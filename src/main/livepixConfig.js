/**
 * Configuração LivePix por streamer (modelo SaaS).
 *
 * O app gera um streamer_id único por instalação e publica as credenciais do
 * LivePix em public.streamer_configs. Com isso o webhook na Vercel consegue
 * autenticar na conta LivePix correta sem nenhum client_id global.
 */

const crypto = require('crypto');
const { getSupabaseClient } = require('./database');

/**
 * Endpoint do webhook distribuído com o app. Pode ser sobrescrito por
 * LIVEPIX_WEBHOOK_BASE_URL (build/execução) ou pelo campo nas configurações
 * para quem hospeda a própria função na Vercel.
 */
const DEFAULT_WEBHOOK_BASE_URL = String(
  process.env.LIVEPIX_WEBHOOK_BASE_URL
  || 'https://chessstream-webhook.vercel.app/api/livepix'
).trim();

// Mesmo formato aceito por register_streamer_config() no Supabase.
const STREAMER_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function isValidStreamerId(value) {
  return STREAMER_ID_PATTERN.test(String(value || '').trim());
}

function generateStreamerId() {
  return crypto.randomUUID();
}

function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim() || DEFAULT_WEBHOOK_BASE_URL;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * Monta a URL que o streamer cola no painel do LivePix.
 * Retorna '' quando ainda não há identidade/segredo configurados.
 */
function buildWebhookUrl({ baseUrl, streamerId, secret }) {
  if (!isValidStreamerId(streamerId) || !secret) return '';

  try {
    const url = new URL(normalizeBaseUrl(baseUrl));
    url.searchParams.set('streamer', String(streamerId).trim());
    url.searchParams.set('secret', String(secret));
    return url.toString();
  } catch {
    return '';
  }
}

function hasLivepixCredentials({ clientId, clientSecret } = {}) {
  return Boolean(String(clientId || '').trim() && String(clientSecret || '').trim());
}

/**
 * Publica/atualiza as credenciais do streamer no Supabase via RPC.
 * A tabela streamer_configs não aceita INSERT/UPDATE direto pela anon key.
 */
async function syncStreamerConfig({ streamerId, streamerSecret, clientId, clientSecret, webhookSecret }) {
  if (!isValidStreamerId(streamerId)) {
    return { ok: false, error: 'streamer_id inválido.' };
  }

  if (!hasLivepixCredentials({ clientId, clientSecret }) || !webhookSecret || String(streamerSecret || '').trim().length < 32) {
    return { ok: false, error: 'Credenciais LivePix incompletas.' };
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return { ok: false, error: 'Supabase não está configurado no app.' };
  }

  try {
    const { error } = await supabase.rpc('register_streamer_config', {
      p_streamer_id: String(streamerId).trim(),
      p_client_id: String(clientId).trim(),
      p_client_secret: String(clientSecret).trim(),
      p_streamer_secret: String(streamerSecret).trim(),
    });

    if (error) {
      return { ok: false, error: error.message };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = {
  DEFAULT_WEBHOOK_BASE_URL,
  STREAMER_ID_PATTERN,
  isValidStreamerId,
  generateStreamerId,
  generateWebhookSecret,
  normalizeBaseUrl,
  buildWebhookUrl,
  hasLivepixCredentials,
  syncStreamerConfig,
};
