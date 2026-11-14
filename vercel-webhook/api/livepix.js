/**
 * Vercel Serverless Function
 * Webhook do LivePix → fila VIP no Supabase (modelo SaaS / multi-streamer).
 *
 * URL (gerada pelo app e colada no painel do LivePix):
 *   https://seu-projeto.vercel.app/api/livepix?streamer=<streamer_id>&secret=<webhook_secret>
 *
 * O endpoint não usa mais credenciais LivePix globais: ele busca
 * `livepix_client_id` / `livepix_client_secret` em public.streamer_configs
 * para o `streamer` informado. Cada cliente do app tem a sua própria conta
 * LivePix e a sua própria fila.
 *
 * Variáveis de ambiente (somente infraestrutura do fornecedor):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_SERVICE_KEY)
 *   LIVEPIX_OAUTH_SCOPE (opcional, default: messages:read)
 *
 * Observação: o webhook do LivePix envia apenas
 * `{ userId, clientId, event, resource: { id, reference, type } }`.
 * O valor, o doador e a mensagem precisam ser buscados na API oficial
 * (GET /v2/messages/{id}) com um access token OAuth2.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const LIVEPIX_API = 'https://api.livepix.gg/v2';
const LIVEPIX_TOKEN_URL = 'https://oauth.livepix.gg/oauth2/token';

// Mesmo formato validado pela função register_streamer_config() no schema.
const STREAMER_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// !jogar <nick> — aceita "!jogar Hikaru", "!jogar @Hikaru", com qualquer caixa.
const COMMAND_PATTERN = /(?:^|\s)!jogar\s+@?([a-zA-Z0-9_-]{2,32})/i;

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

// Cache de token OAuth por streamer/credencial entre invocações "quentes".
// A chave inclui o client_id para invalidar sozinha quando o streamer troca
// as credenciais no app.
const tokenCache = new Map();

function getSupabase() {
  if (supabase) return supabase;
  if (!process.env.SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados.');
  }

  supabase = createClient(process.env.SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabase;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = readQuery(req);
  const streamerId = singleValue(query.streamer);
  const providedSecret = singleValue(query.secret);

  if (!STREAMER_ID_PATTERN.test(streamerId)) {
    return res.status(400).json({ error: 'Missing or invalid streamer' });
  }

  let config;
  try {
    config = await loadStreamerConfig(streamerId);
  } catch (error) {
    console.error('[LivePix] Erro ao buscar streamer_configs:', error);
    return res.status(500).json({ error: 'Config lookup failed' });
  }

  if (!config) {
    return res.status(404).json({ error: 'Unknown streamer' });
  }

  if (!secretsMatch(providedSecret, config.webhook_secret)) {
    console.warn(`[LivePix] Segredo inválido para o streamer ${streamerId}.`);
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
    const donation = await resolveDonation(resource, streamerId, config);

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

    // O id é único globalmente, mas incluímos o streamer para manter a
    // idempotência correta mesmo se dois streamers receberem o mesmo id.
    const sourceId = `livepix:${streamerId}:${resource.type}:${resource.id}`;

    const result = await enqueueVip({
      streamerId,
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

/* ── Request helpers ───────────────────────────────────────────────────────── */

function readQuery(req) {
  let fromUrl = {};
  try {
    const url = new URL(req.url || '', 'https://localhost');
    fromUrl = Object.fromEntries(url.searchParams.entries());
  } catch {
    fromUrl = {};
  }

  if (req.query && typeof req.query === 'object') {
    return { ...fromUrl, ...req.query };
  }

  return fromUrl;
}

function singleValue(value) {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return typeof value === 'string' ? value : '';
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/* ── Segurança ─────────────────────────────────────────────────────────────── */

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;

  const providedBuffer = Buffer.from(String(provided));
  const expectedBuffer = Buffer.from(String(expected));
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/* ── Configuração por streamer ─────────────────────────────────────────────── */

async function loadStreamerConfig(streamerId) {
  const { data, error } = await getSupabase()
    .from('streamer_configs')
    .select('streamer_id, livepix_client_id, livepix_client_secret, webhook_secret')
    .eq('streamer_id', streamerId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.livepix_client_id || !data?.livepix_client_secret) return null;
  return data;
}

/* ── LivePix API ───────────────────────────────────────────────────────────── */

/**
 * Alguns webhooks já trazem o objeto completo em `resource`. Quando não
 * trouxerem, buscamos os detalhes na API oficial usando o id do recurso.
 */
async function resolveDonation(resource, streamerId, config) {
  if (resource.message || resource.username) {
    return normalizeDonation(resource);
  }

  if (resource.type === 'payment') {
    // Pagamentos avulsos não possuem mensagem/doador na API do LivePix.
    // Só conseguimos montar uma entrada VIP quando o PIX vem como "message".
    const payment = await fetchLivePixResource('payments', resource.id, streamerId, config);
    return payment ? normalizeDonation(payment) : null;
  }

  const message = await fetchLivePixResource('messages', resource.id, streamerId, config);
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

async function fetchLivePixResource(kind, id, streamerId, config) {
  const token = await getAccessToken(streamerId, config);
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

async function getAccessToken(streamerId, config) {
  const cacheKey = `${streamerId}:${config.livepix_client_id}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.livepix_client_id,
    client_secret: config.livepix_client_secret,
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

  const seconds = Number(json.expires_in);
  const ttlMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;

  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + ttlMs,
  });

  return json.access_token;
}

/* ── Supabase ──────────────────────────────────────────────────────────────── */

async function enqueueVip({
  streamerId,
  donorName,
  chessNick,
  amountCents,
  message,
  sourceId,
  livepixId,
}) {
  const position = await nextQueuePosition(streamerId);

  // source_id tem UNIQUE no schema: o LivePix pode reenviar o mesmo evento
  // por até 24h; a segunda inserção é ignorada em vez de duplicar o jogador.
  const { data, error } = await getSupabase()
    .from('queue')
    .insert({
      streamer_id: streamerId,
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

async function nextQueuePosition(streamerId) {
  const { data, error } = await getSupabase()
    .from('queue')
    .select('position')
    .eq('streamer_id', streamerId)
    .eq('status', 'pending')
    .order('position', { ascending: false, nullsFirst: false })
    .limit(1);

  if (error) {
    console.warn('[LivePix] Não foi possível calcular a posição:', error.message);
    return null;
  }

  return (data?.[0]?.position || 0) + 1;
}
