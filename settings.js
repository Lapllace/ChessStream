const { default: Store } = require('electron-store');

const schema = {
  chessStreamerNick: { type: 'string', default: '' },
  twitchChannel:    { type: 'string', default: '' },
  twitchOAuthToken: { type: 'string', default: '' },
  youtubeApiKey:    { type: 'string', default: '' },
  youtubeChannelId: { type: 'string', default: '' },
  mpAccessToken:    { type: 'string', default: '' },
  mpMinValue:       { type: 'number', default: 5.00 },
  supabaseUrl:      { type: 'string', default: '' },
  supabaseAnonKey:  { type: 'string', default: '' },
};

const store = new Store({
  projectName: 'chessstream-hub',
  schema,
  encryptionKey: 'chessstream-hub-local-key',
  clearInvalidConfig: true,
});

function getSettings() {
  return store.store;
}

function saveSettings(partial) {
  for (const [key, value] of Object.entries(partial || {})) {
    if (Object.prototype.hasOwnProperty.call(schema, key)) {
      store.set(key, value);
    }
  }
}

function applyToEnv() {
  const settings = store.store;
  const envMap = {
    chessStreamerNick: 'CHESS_STREAMER_NICK',
    twitchChannel: 'TWITCH_CHANNEL',
    twitchOAuthToken: 'TWITCH_OAUTH_TOKEN',
    youtubeApiKey: 'YOUTUBE_API_KEY',
    youtubeChannelId: 'YOUTUBE_CHANNEL_ID',
    mpAccessToken: 'MP_ACCESS_TOKEN',
    supabaseUrl: 'SUPABASE_URL',
    supabaseAnonKey: 'SUPABASE_ANON_KEY',
  };

  for (const [settingKey, envKey] of Object.entries(envMap)) {
    if (settings[settingKey]) {
      process.env[envKey] = settings[settingKey];
    } else {
      delete process.env[envKey];
    }
  }
}

module.exports = { getSettings, saveSettings, applyToEnv };