/**
 * Vercel Serverless Function
 * Webhook do LivePix → fila VIP no Supabase.
 *
 * Deploy: vercel deploy (dentro da pasta vercel-webhook/)
 * URL:    https://seu-projeto.vercel.app/api/livepix?secret=SEU_SEGREDO
 *
 * Variáveis de ambiente obrigatórias:
 *   SUPABASE_URL            → URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY    → service_role key (ignora RLS; NUNCA use anon aqui)
 *   LIVEPIX_CLIENT_ID       → client_id da aplicação criada no painel LivePix
 *   LIVEPIX_CLIENT_SECRET   → client_secret da aplicação LivePix
 *
 * Opcionais:
 *   LIVEPIX_OAUTH_SCOPE     → escopo OAuth (default: messages:read)
 *   LIVEPIX_WEBHOOK_SECRET  → segredo compartilhado para validar a chamada
 *
 * Observação importante: o webhook do LivePix envia apenas
 * `{ userId, clientId, event, resource: { id, reference, type } }`.
 * O valor, o doador e a mensagem precisam ser buscados na API oficial
 * (GET /v2/messages/{id}) com um access token OAuth2.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const LIVEPIX_API = 'https://api.livepix.gg/v2';
const LIVEPIX_TOKEN_URL = 'https://oauth.livepix.gg/oauth2/token';

// !jogar <nick> — aceita "!jogar Hikaru", "!jogar @Hikaru", com qualquer caixa.
const COMMAND_PATTERN = /(?:^|\s)!jogar\s+@?([a-zA-Z0-9_-]{2,32})/i;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Cache do token OAuth entre invocações "quentes" da função.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    console.warn('[LivePix] Chamada rejeitada: segredo do webhook inválido.');
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const event = body?.event;
  const resource = body?.resource || {};

  // Eventos de assinatura/cancelamento e payloads sem recurso não interessam.
  if (!resource?.id || !['message', 'payment'].includes(resource.type)) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'unsupported_resource' });
  }

  if (event && !['new', 'created'].includes(String(event).toLowerCase())) {
    return res.status(200).json({ ok: true, skipped: true, reason: `event_${event}` });
  }

  try {
    const donation = await resolveDonation(resource);

    if (!donation) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'no_donation_details' });
    }

    if (donation.flagged) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'flagged_message' });
    }

    const match = COMMAND_PATTERN.exec(donation.message || '');
    if (!match) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'no_command' });
    }

    const chessNick = match[1];
    const donorName = (donation.donorName || '').trim() || 'Anônimo';
    const amountCents = Number.isFinite(donation.amountCents) ? donation.amountCents : 0;
    const sourceId = `livepix:${resource.type}:${resource.id}`;

    const result = await enqueueVip({
      donorName,
      chessNick,
      amountCents,
      message: donation.message,
      sourceId,
      livepixId: resource.id,
    });

    if (!result.ok) {
      // 500 faz o LivePix tentar novamente (ele repete por até 24h).
      return res.status(500).json({ error: result.error });
    }

    return res.status(200).json({
      ok: true,
      duplicated: Boolean(result.duplicated),
      username: donorName,
      chessNick,
      amountCents,
    });
  } catch (error) {
    console.error('[LivePix] Erro ao processar webhook:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
};

/* ── Segurança ─────────────────────────────────────────────────────────────── */

function isAuthorized(req) {
  const expected = process.env.LIVEPIX_WEBHOOK_SECRET;
  if (!expected) {
    // Sem segredo configurado o endpoint fica aberto: aceitável só em dev.
    console.warn('[LivePix] LIVEPIX_WEBHOOK_SECRET não configurado — webhook sem validação.');
    return true;
  }

  const query = req.query || {};
  const provided = String(
    query.secret
    || req.headers['x-livepix-secret']
    || ''
  );

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/* ── LivePix API ───────────────────────────────────────────────────────────── */

/**
 * Alguns webhooks já trazem o objeto completo em `resource`. Quando não
 * trouxerem, buscamos os detalhes na API oficial usando o id do recurso.
 */
async function resolveDonation(resource) {
  if (resource.message || resource.username) {
    return normalizeDonation(resource);
  }

  if (resource.type === 'payment') {
    // Pagamentos avulsos não possuem mensagem/doador na API do LivePix.
    // Só conseguimos montar uma entrada VIP quando o PIX vem como "message".
    const payment = await fetchLivePixResource('payments', resource.id);
    return payment ? normalizeDonation(payment) : null;
  }

  const message = await fetchLivePixResource('messages', resource.id);
  return message ? normalizeDonation(message) : null;
}

function normalizeDonation(payload) {
  const amountRaw = payload.amount ?? payload.value ?? payload.amountCents ?? 0;
  const amountCents = Number.isFinite(Number(amountRaw))
    ? Math.round(Number(amountRaw))
    : 0;

  return {
    donorName: payload.username
      || payload.donor?.displayName
      || payload.donor?.name
      || payload.donor?.username
      || payload.donorName
      || 'Anônimo',
    message: String(payload.message || payload.description || ''),
    amountCents,
    flagged: payload.flagged === true,
  };
}

async function fetchLivePixResource(kind, id) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('Não foi possível autenticar na API do LivePix.');
  }

  const response = await fetch(`${LIVEPIX_API}/${kind}/${encodeURIComponent(id)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`LivePix API ${kind}/${id} respondeu ${response.status} ${detail}`.trim());
  }

  const json = await response.json();
  return json?.data || null;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const clientId = process.env.LIVEPIX_CLIENT_ID;
  const clientSecret = process.env.LIVEPIX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[LivePix] LIVEPIX_CLIENT_ID/SECRET não configurados.');
    return null;
  }

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: process.env.LIVEPIX_OAUTH_SCOPE || 'messages:read',
  });

  const response = await fetch(LIVEPIX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OAuth LivePix respondeu ${response.status} ${detail}`.trim());
  }

  const json = await response.json();
  if (!json?.access_token) {
    throw new Error('OAuth LivePix não retornou access_token.');
  }

  cachedToken = json.access_token;
  setTokenExpiry(json.expires_in);

  return cachedToken;
}

function setTokenExpiry(expiresInSeconds) {
  const seconds = Number(expiresInSeconds);
  cachedTokenExpiresAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
}

/* ── Supabase ──────────────────────────────────────────────────────────────── */

async function enqueueVip({ donorName, chessNick, amountCents, message, sourceId, livepixId }) {
  const position = await nextQueuePosition();

  // source_id tem UNIQUE no schema: o LivePix pode reenviar o mesmo evento
  // por até 24h; a segunda inserção é ignorada em vez de duplicar o jogador.
  const { data, error } = await supabase
    .from('queue')
    .insert({
      player_name: donorName,
      chess_username: chessNick,
      platform: 'livepix',
      status: 'pending',
      position,
      amount_cents: amountCents,
      source_id: sourceId,
      notes: JSON.stringify({
        priority: 'vip',
        amount_cents: amountCents,
        message,
        donor: donorName,
        source: 'livepix',
        livepix_id: livepixId,
      }),
    })
    .select('id')
    .single();

  if (!error) return { ok: true, id: data?.id };

  // 23505 = unique_violation (webhook reenviado).
  if (error.code === '23505') {
    return { ok: true, duplicated: true };
  }

  console.error('[LivePix] Erro ao inserir na fila:', error);
  return { ok: false, error: error.message };
}

async function nextQueuePosition() {
  const { data, error } = await supabase
    .from('queue')
    .select('position')
    .eq('status', 'pending')
    .order('position', { ascending: false, nullsFirst: false })
    .limit(1);

  if (error) {
    console.warn('[LivePix] Não foi possível calcular a posição:', error.message);
    return null;
  }

  return (data?.[0]?.position || 0) + 1;
}
