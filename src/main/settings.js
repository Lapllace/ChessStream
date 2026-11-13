const { app, safeStorage } = require('electron');
const { default: Store } = require('electron-store');
const { reconnectSupabase } = require('./database');

/**
 * Valores gravados pelo safeStorage recebem este prefixo para que consigamos
 * diferenciar texto puro (versões antigas do app) de conteúdo criptografado.
 */
const ENCRYPTED_PREFIX = 'enc:v1:';

/** Campos que nunca devem ser gravados em texto puro no disco. */
const SECRET_KEYS = [
  'twitchOAuthToken',
  'youtubeAccessToken',
  'youtubeRefreshToken',
  'tiktokSessionId',
  'mpAccessToken',
];

const schema = {
  chessStreamerNick: { type: 'string', default: '' },
  twitchClientId:    { type: 'string', default: '' },
  twitchChannel:     { type: 'string', default: '' },
  twitchUsername:    { type: 'string', default: '' },
  twitchOAuthToken:  { type: 'string', default: '' },
  tiktokUsername:    { type: 'string', default: '' },
  tiktokSessionId:   { type: 'string', default: '' },
  youtubeChannelId:  { type: 'string', default: '' },
  youtubeChannelName:{ type: 'string', default: '' },
  youtubeAccessToken:{ type: 'string', default: '' },
  youtubeRefreshToken:{ type: 'string', default: '' },
  mpAccessToken:     { type: 'string', default: '' },
  mpMinValue:        { type: 'number', default: 5 },
  supabaseUrl:       { type: 'string', default: '' },
  supabaseAnonKey:   { type: 'string', default: '' },
  language:          { type: 'string', default: 'pt' },
};

const store = new Store({
  projectName: 'chessstream-hub',
  schema,
  encryptionKey: 'chessstream-hub-local-key',
  clearInvalidConfig: true,
});

/**
 * O safeStorage só pode ser usado depois de app.whenReady(). Fora dessa janela
 * (ex.: require no topo do main), tratamos como indisponível.
 */
function isSafeStorageAvailable() {
  try {
    return app.isReady() && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Criptografa um segredo. Se o valor já estiver cifrado, não cifra de novo.
 * Sem safeStorage disponível, mantém texto puro (compatibilidade).
 */
function encryptSecret(value) {
  if (typeof value !== 'string' || value === '') return '';
  if (value.startsWith(ENCRYPTED_PREFIX)) return value;
  if (!isSafeStorageAvailable()) return value;

  try {
    const encrypted = safeStorage.encryptString(value);
    return `${ENCRYPTED_PREFIX}${encrypted.toString('base64')}`;
  } catch (error) {
    console.warn('[Settings] Falha ao criptografar segredo:', error?.message || error);
    return value;
  }
}

/**
 * Descriptografa um segredo. Falhas retornam string vazia de forma silenciosa
 * (chave do sistema trocada, perfil do Windows recriado, valor corrompido...).
 */
function decryptSecret(value) {
  if (typeof value !== 'string' || value === '') return '';
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;

  try {
    const base64 = value.slice(ENCRYPTED_PREFIX.length);
    return safeStorage.decryptString(Buffer.from(base64, 'base64'));
  } catch {
    return '';
  }
}

/** Lê o store aplicando a descriptografia na memória. Uso interno/main. */
function getSettings() {
  const settings = { ...store.store };

  for (const key of SECRET_KEYS) {
    settings[key] = decryptSecret(settings[key]);
  }

  return settings;
}

/**
 * Versão segura para atravessar o IPC até o renderer: tokens não saem do
 * processo principal, apenas indicadores de "conectado".
 */
function getPublicSettings() {
  const settings = getSettings();
  const {
    twitchOAuthToken,
    youtubeAccessToken,
    youtubeRefreshToken,
    tiktokSessionId,
    ...publicSettings
  } = settings;

  return {
    ...publicSettings,
    hasTwitchToken: Boolean(twitchOAuthToken),
    youtubeConnected: Boolean(youtubeAccessToken),
  };
}

function saveSettings(partial) {
  const values = { ...(partial || {}) };

  // Normaliza credenciais da Twitch para evitar espaços acidentais e "##"
  // no canal (o Client ID precisa bater exatamente com o cadastrado na Twitch).
  if (typeof values.twitchClientId === 'string') {
    values.twitchClientId = values.twitchClientId.trim();
  }
  if (typeof values.twitchChannel === 'string') {
    values.twitchChannel = values.twitchChannel.trim().replace(/^#/, '');
  }
  if (typeof values.twitchUsername === 'string') {
    values.twitchUsername = values.twitchUsername.trim();
  }

  // Criptografa apenas o que está sendo gravado nesta chamada.
  for (const key of SECRET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      values[key] = encryptSecret(values[key]);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (Object.prototype.hasOwnProperty.call(schema, key)) {
      store.set(key, value);
    }
  }

  // process.env precisa refletir tokens/credenciais já descriptografados.
  applyToEnv();

  // Recria o cliente Supabase na hora: sem isso o módulo ficaria preso ao
  // cliente antigo até o app ser reiniciado.
  const touchesSupabase = Object.prototype.hasOwnProperty.call(values, 'supabaseUrl')
    || Object.prototype.hasOwnProperty.call(values, 'supabaseAnonKey');
  if (touchesSupabase) {
    reconnectSupabase(store.get('supabaseUrl'), store.get('supabaseAnonKey'));
  }
}

function applyToEnv() {
  const settings = getSettings();
  const envMap = {
    chessStreamerNick: 'CHESS_STREAMER_NICK',
    twitchClientId: 'TWITCH_CLIENT_ID',
    twitchChannel: 'TWITCH_CHANNEL',
    twitchUsername: 'TWITCH_USERNAME',
    twitchOAuthToken: 'TWITCH_OAUTH_TOKEN',
    tiktokUsername: 'TIKTOK_USERNAME',
    tiktokSessionId: 'TIKTOK_SESSION_ID',
    youtubeChannelId: 'YOUTUBE_CHANNEL_ID',
    mpAccessToken: 'MP_ACCESS_TOKEN',
    supabaseUrl: 'SUPABASE_URL',
    supabaseAnonKey: 'SUPABASE_ANON_KEY',
  };

  for (const [settingKey, envKey] of Object.entries(envMap)) {
    if (settings[settingKey]) {
      process.env[envKey] = String(settings[settingKey]).trim();
    }
  }

  if (settings.youtubeAccessToken) {
    process.env.YOUTUBE_ACCESS_TOKEN = settings.youtubeAccessToken;
  }

  if (settings.youtubeRefreshToken) {
    process.env.YOUTUBE_REFRESH_TOKEN = settings.youtubeRefreshToken;
  }
}

module.exports = {
  getSettings,
  getPublicSettings,
  saveSettings,
  applyToEnv,
};
