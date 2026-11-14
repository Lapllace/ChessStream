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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // usar service_role key aqui, não anon
);

module.exports = async (req, res) => {
  // Aceita apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, data } = req.body;

  // Valida a assinatura do Mercado Pago antes de qualquer processamento.
  if (!validateMPSignature(req, data?.id)) {
    console.warn('[Webhook] Assinatura inválida — requisição rejeitada.');
    return res.status(401).json({ error: 'Invalid signature' });
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

    // Insere na tabela fila_vip do Supabase
    const { error } = await supabase.from('fila_vip').insert({
      payment_id:   String(paymentId),
      username,
      chess_nick:   chessNick,
      platform,
      amount_cents: amountCents,
      paid_at:      new Date().toISOString(),
    });

    if (error) {
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
function validateMPSignature(req, paymentId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // sem secret configurado: permite (modo dev)

  const xSignature = req.headers['x-signature'] || '';
  const xRequestId = req.headers['x-request-id'] || '';

  const tsMatch  = xSignature.match(/ts=([^,]+)/);
  const v1Match  = xSignature.match(/v1=([^,]+)/);
  if (!tsMatch || !v1Match) return false;

  const ts   = tsMatch[1];
  const hash = v1Match[1];

  // Manifesto assinado pelo Mercado Pago
  const manifest = `id:${paymentId};request-id:${xRequestId};ts:${ts};`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const hashBuffer     = Buffer.from(hash, 'hex');
  if (expectedBuffer.length !== hashBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, hashBuffer);
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
