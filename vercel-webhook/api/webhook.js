/**
 * Vercel Serverless Function
 * Recebe webhooks do Mercado Pago e grava no Supabase
 *
 * Deploy: vercel deploy (dentro da pasta vercel-webhook/)
 * URL gerada:  https://seu-projeto.vercel.app/api/webhook
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

// Mesmo formato aceito por public.queue.streamer_id no schema.
const STREAMER_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  SERVICE_KEY   // usar service_role key aqui, não anon
);

/**
 * Segredo usado no HMAC do Mercado Pago.
 *
 * A variável canônica é MERCADO_PAGO_WEBHOOK_SECRET. O alias legado
 * MP_WEBHOOK_SECRET NÃO é aceito automaticamente: mantê-lo como fallback
 * silencioso esconderia uma configuração incompleta em produção.
 */
function getWebhookSecret() {
  return String(process.env.MERCADO_PAGO_WEBHOOK_SECRET || '').trim();
}

/** Lê ?streamer=<streamer_id> (Vercel popula req.query; fallback: req.url). */
function readStreamerId(req) {
  let value = '';

  if (req.query && req.query.streamer != null) {
    value = Array.isArray(req.query.streamer) ? req.query.streamer[0] : req.query.streamer;
  } else {
    try {
      const url = new URL(req.url || '', 'https://localhost');
      value = url.searchParams.get('streamer') || '';
    } catch {
      value = '';
    }
  }

  return String(value || '').trim();
}

module.exports = async (req, res) => {
  // Aceita apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, data } = req.body || {};

  // Fail-closed: sem segredo configurado NÃO existe modo "dev" que aceite
  // qualquer requisição. Nenhum pagamento é processado.
  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) {
    if (process.env.MP_WEBHOOK_SECRET) {
      console.warn('[Webhook] MP_WEBHOOK_SECRET existe, mas a variável exigida é MERCADO_PAGO_WEBHOOK_SECRET. Renomeie na Vercel.');
    }
    console.error('[Webhook] MERCADO_PAGO_WEBHOOK_SECRET não configurado — pagamento rejeitado.');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  // Valida a assinatura do Mercado Pago antes de qualquer processamento.
  if (!validateMPSignature(req, data?.id, webhookSecret)) {
    console.warn('[Webhook] Assinatura inválida — requisição rejeitada.');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Tenant opcional: mantém compatibilidade com URLs antigas sem o parâmetro.
  const streamerId = readStreamerId(req);
  if (streamerId && !STREAMER_ID_PATTERN.test(streamerId)) {
    return res.status(400).json({ error: 'Invalid streamer' });
  }

  // Mercado Pago envia tipo "payment"
  if (type !== 'payment') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  const paymentId = data?.id;
  if (!paymentId) return res.status(400).json({ error: 'Missing payment id' });

  try {
    // Busca detalhes do pagamento na API do MP
    const payment = await fetchMPPayment(paymentId);

    if (payment.status !== 'approved') {
      return res.status(200).json({ ok: true, status: payment.status });
    }

    // Extrai metadados: username e chess_nick devem vir no campo "external_reference"
    // Formato esperado: "twitch:NomeDoViewer:nick_chess"
    const ref   = payment.external_reference || '';
    const parts = ref.split(':');
    const platform  = parts[0] || 'unknown';
    const username  = parts[1] || 'desconhecido';
    const chessNick = parts[2] || '';

    const amountCents = Math.round((payment.transaction_amount || 0) * 100);
    const minValue    = parseInt(process.env.MP_MIN_VALUE_CENTS || '500', 10);

    if (amountCents < minValue) {
      console.log(`Pagamento abaixo do mínimo: R$${amountCents / 100}`);
      return res.status(200).json({ ok: true, below_minimum: true });
    }

    // Insere na tabela fila_vip do Supabase (service_role ignora RLS).
    const { error } = await supabase.from('fila_vip').insert({
      payment_id:   String(paymentId),
      streamer_id:  streamerId || null,
      username,
      chess_nick:   chessNick,
      platform,
      amount_cents: amountCents,
      paid_at:      new Date().toISOString(),
    });

    if (error) {
      // payment_id é UNIQUE: o MP reenvia o mesmo evento. Responder 200 evita
      // que ele continue tentando entregar o mesmo pagamento.
      if (error.code === '23505') {
        return res.status(200).json({ ok: true, duplicate: true });
      }
      console.error('Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true, username, chessNick, amountCents });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// Valida o header x-signature enviado pelo Mercado Pago.
// Formato: ts=TIMESTAMP,v1=HASH
function validateMPSignature(req, paymentId, secret) {
  if (!secret) return false;

  const xSignature = String(req.headers['x-signature'] || '').trim();
  const xRequestId = String(req.headers['x-request-id'] || '').trim();

  // Sem os dois headers não há como validar o HMAC: rejeita.
  if (!xSignature || !xRequestId) return false;

  const tsMatch = /(?:^|,)\s*ts=([^,]+)/.exec(xSignature);
  const v1Match = /(?:^|,)\s*v1=([^,]+)/.exec(xSignature);
  if (!tsMatch || !v1Match) return false;

  const ts   = tsMatch[1].trim();
  const hash = v1Match[1].trim();
  if (!/^\d+$/.test(ts) || !/^[a-f0-9]{64}$/i.test(hash)) return false;

  // Manifesto assinado pelo Mercado Pago
  const manifest = `id:${paymentId};request-id:${xRequestId};ts:${ts};`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(manifest)
    .digest();
  const provided = Buffer.from(hash, 'hex');

  if (expected.length !== provided.length) return false;

  return crypto.timingSafeEqual(expected, provided);
}

// Busca dados do pagamento na API do Mercado Pago
function fetchMPPayment(id) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.mercadopago.com',
      path:     `/v1/payments/${id}`,
      method:   'GET',
      headers:  {
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type':  'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.end();
  });
}
