const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const { default: Store } = require('electron-store');
const { reconnectSupabase } = require('./database');
const {
  DEFAULT_WEBHOOK_BASE_URL,
  buildWebhookUrl,
  generateStreamerId,
  generateWebhookSecret,
} = require('./livepixConfig');

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
  'livepixClientSecret',
  'livepixWebhookSecret',
  'licenseKey',
  'streamerSecret',
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
  // ── LivePix (SaaS) ──────────────────────────────────────────────
  streamerId:            { type: 'string', default: '' },
  streamerSecret:        { type: 'string', default: '' },
  livepixClientId:       { type: 'string', default: '' },
  livepixClientSecret:   { type: 'string', default: '' },
  livepixWebhookSecret:  { type: 'string', default: '' },
  livepixWebhookBaseUrl: { type: 'string', default: DEFAULT_WEBHOOK_BASE_URL },
  // ── Licença (assinatura mensal, sem vínculo por máquina) ────────
  // licenseKey é criptografada via safeStorage (está em SECRET_KEYS).
  licenseKey:        { type: 'string', default: '' },
  licenseExpiresAt:  { type: 'string', default: '' }, // ISO date
  licenseCheckedAt:  { type: 'string', default: '' }, // ISO date
  licenseDaysLeft:   { type: 'number', default: 0 },
  licenseStatus:     { type: 'string', default: '' }, // active | expired | revoked
  termsAccepted:     { type: 'boolean', default: false },
  termsAcceptedVersion: { type: 'string', default: '' },
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
  // Remove dinamicamente todos os segredos: evita que uma chave nova em
  // SECRET_KEYS vaze para o renderer por esquecimento no destructuring.
  const publicSettings = { ...settings };
  for (const key of SECRET_KEYS) delete publicSettings[key];

  const streamerId = String(settings.streamerId || '');
  const webhookUrl = streamerId && settings.livepixWebhookSecret
    ? buildWebhookUrl({
      baseUrl: settings.livepixWebhookBaseUrl,
      streamerId,
      secret: settings.livepixWebhookSecret,
    })
    : '';

  return {
    ...publicSettings,
    hasTwitchToken: Boolean(settings.twitchOAuthToken),
    youtubeConnected: Boolean(settings.youtubeAccessToken),
    livepixConfigured: Boolean(
      String(settings.livepixClientId || '').trim()
      && String(settings.livepixClientSecret || '').trim()
    ),
    livepixWebhookUrl: webhookUrl,
    hasLicenseKey: Boolean(String(settings.licenseKey || '').trim()),
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

  // ── LivePix (multi-streamer) ─────────────────────────────────────
  if (typeof values.livepixClientId === 'string') {
    values.livepixClientId = values.livepixClientId.trim();
  }
  if (typeof values.livepixWebhookBaseUrl === 'string') {
    values.livepixWebhookBaseUrl = values.livepixWebhookBaseUrl.trim();
  }

  const incomingClientId = typeof values.livepixClientId === 'string'
    ? values.livepixClientId
    : '';
  const incomingSecret = typeof values.livepixClientSecret === 'string'
    ? values.livepixClientSecret.trim()
    : '';

  // O modal nunca devolve o segredo salvo; campo vazio significa "manter".
  if (Object.prototype.hasOwnProperty.call(values, 'livepixClientSecret') && !incomingSecret) {
    delete values.livepixClientSecret;
  }

  // Ativa o modo multi-tenant na primeira vez que houver credenciais.
  // Depois disso a identidade é mantida mesmo se o usuário limpar os campos.
  const hasStoredSecret = Boolean(store.get('livepixClientSecret'));
  const activatesLivepix = Boolean(store.get('streamerId'))
    || Boolean(incomingClientId && (incomingSecret || hasStoredSecret));

  if (activatesLivepix) {
    if (!store.get('streamerId')) {
      values.streamerId = generateStreamerId();
    }
    if (!store.get('livepixWebhookSecret')) {
      values.livepixWebhookSecret = generateWebhookSecret();
    }
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

/**
 * Dados usados pelo handler de settings:save para publicar as credenciais no
 * Supabase e montar a URL exibida ao streamer.
 */
function getLivepixConfig() {
  const settings = getSettings();
  return {
    streamerId: String(settings.streamerId || ''),
    streamerSecret: String(settings.streamerSecret || '').trim(),
    clientId: String(settings.livepixClientId || '').trim(),
    clientSecret: String(settings.livepixClientSecret || '').trim(),
    webhookSecret: String(settings.livepixWebhookSecret || ''),
    baseUrl: String(settings.livepixWebhookBaseUrl || DEFAULT_WEBHOOK_BASE_URL),
  };
}

/**
 * Garante uma identidade de streamer estável para esta instalação.
 *
 * A fila é multi-tenant e as policies de INSERT/UPDATE em public.queue exigem
 * streamer_id válido. Gerar o id no primeiro boot mantém o app funcionando
 * mesmo para quem nunca configurou o LivePix (antes o id só nascia junto com
 * as credenciais LivePix).
 */
function ensureStreamerIdentity() {
  if (!String(getSettings().streamerSecret || '').trim()) {
    store.set('streamerSecret', encryptSecret(crypto.randomBytes(32).toString('hex')));
  }
  const current = String(store.get('streamerId') || '').trim();
  if (current) return current;

  const generated = generateStreamerId();
  store.set('streamerId', generated);
  console.log(`[Settings] streamer_id gerado para esta instalação: ${generated}`);
  return generated;
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
  getLivepixConfig,
  saveSettings,
  applyToEnv,
  ensureStreamerIdentity,
};
