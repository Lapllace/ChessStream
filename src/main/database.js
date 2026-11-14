/**
 * Cliente Supabase "vivo".
 *
 * Não exportamos mais uma instância fixa: o renderer pode trocar URL/chave
 * em runtime, então os consumidores sempre pedem a instância atual através
 * de getSupabaseClient(). reconnectSupabase() descarta a anterior (inclusive
 * o socket Realtime) e monta uma nova com as credenciais recebidas.
 */

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const CLIENT_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  realtime: {
    transport: WebSocket,
  },
};

let client = null;
let currentUrl = '';
let currentKey = '';
let missingConfigWarned = false;

function pick(...values) {
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) return normalized;
  }
  return '';
}

function readEnvCredentials() {
  return {
    url: pick(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_URL),
    key: pick(
      process.env.SUPABASE_ANON_KEY,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ),
  };
}

function buildClient(url, key) {
  if (!url || !key) return null;

  try {
    return createClient(url, key, CLIENT_OPTIONS);
  } catch (error) {
    console.error('[Supabase] Falha ao criar cliente:', error?.message || error);
    return null;
  }
}

/**
 * Fecha canais e o socket antigo. Sem isto, trocar as chaves deixaria a
 * conexão Realtime anterior aberta consumindo recursos e recebendo eventos
 * do projeto antigo.
 */
function disposeClient(instance) {
  if (!instance) return;

  try {
    const removal = instance.removeAllChannels?.();
    if (removal && typeof removal.catch === 'function') {
      removal.catch(() => {});
    }
  } catch (error) {
    console.warn('[Supabase] Erro ao remover canais antigos:', error?.message || error);
  }

  try {
    const disconnection = instance.realtime?.disconnect?.();
    if (disconnection && typeof disconnection.catch === 'function') {
      disconnection.catch(() => {});
    }
  } catch (error) {
    console.warn('[Supabase] Erro ao desconectar Realtime antigo:', error?.message || error);
  }
}

/**
 * Retorna sempre o cliente correspondente às credenciais atuais.
 * Se as variáveis de ambiente mudaram desde a última chamada (por exemplo,
 * via applyToEnv), recria automaticamente.
 */
function getSupabaseClient() {
  const { url, key } = readEnvCredentials();

  if (!url || !key) {
    if (client) {
      disposeClient(client);
      client = null;
      currentUrl = '';
      currentKey = '';
    }

    if (!missingConfigWarned) {
      missingConfigWarned = true;
      console.error('ERRO: Supabase URL ou Anon Key não encontradas no arquivo .env');
    }
    return null;
  }

  missingConfigWarned = false;

  if (client && url === currentUrl && key === currentKey) {
    return client;
  }

  if (client) disposeClient(client);

  client = buildClient(url, key);
  currentUrl = client ? url : '';
  currentKey = client ? key : '';
  return client;
}

/**
 * Aplica novas credenciais imediatamente (sem reiniciar o Electron).
 * Também atualiza process.env para que módulos que leem env diretamente
 * enxerguem os mesmos valores.
 *
 * @param {string} newUrl
 * @param {string} newKey
 * @returns {import('@supabase/supabase-js').SupabaseClient|null}
 */
function reconnectSupabase(newUrl, newKey) {
  const url = typeof newUrl === 'string' ? newUrl.trim() : '';
  const key = typeof newKey === 'string' ? newKey.trim() : '';

  if (url) process.env.SUPABASE_URL = url;
  else delete process.env.SUPABASE_URL;

  if (key) process.env.SUPABASE_ANON_KEY = key;
  else delete process.env.SUPABASE_ANON_KEY;

  const previous = client;
  client = null;
  currentUrl = '';
  currentKey = '';
  disposeClient(previous);

  if (!url || !key) {
    missingConfigWarned = true;
    console.warn('[Supabase] Credenciais vazias — cliente desconectado.');
    return null;
  }

  missingConfigWarned = false;
  client = buildClient(url, key);
  currentUrl = client ? url : '';
  currentKey = client ? key : '';

  if (client) {
    console.log('[Supabase] Cliente recriado com as novas credenciais.');
  }

  return client;
}

module.exports = { getSupabaseClient, reconnectSupabase };
