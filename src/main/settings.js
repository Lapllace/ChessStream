const { default: Store } = require('electron-store');

const schema = {
  chessStreamerNick: { type: 'string', default: '' },
  twitchClientId:    { type: 'string', default: '' },
  twitchChannel:     { type: 'string', default: '' },
  twitchUsername:    { type: 'string', default: '' },
  twitchOAuthToken:  { type: 'string', default: '' },
  youtubeChannelId:  { type: 'string', default: '' },
  youtubeChannelName:{ type: 'string', default: '' },
  youtubeAccessToken:{ type: 'string', default: '' },
  youtubeRefreshToken:{ type: 'string', default: '' },
  mpAccessToken:     { type: 'string', default: '' },
  mpMinValue:        { type: 'number', default: 5 },
  supabaseUrl:       { type: 'string', default: '' },
  supabaseAnonKey:   { type: 'string', default: '' },
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
    twitchClientId: 'TWITCH_CLIENT_ID',
    twitchChannel: 'TWITCH_CHANNEL',
    twitchUsername: 'TWITCH_USERNAME',
    twitchOAuthToken: 'TWITCH_OAUTH_TOKEN',
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

    if (settings.youtubeAccessToken) {
      process.env.YOUTUBE_ACCESS_TOKEN = settings.youtubeAccessToken;
    } else {
      delete process.env.YOUTUBE_ACCESS_TOKEN;
    }

    if (settings.youtubeRefreshToken) {
      process.env.YOUTUBE_REFRESH_TOKEN = settings.youtubeRefreshToken;
    } else {
      delete process.env.YOUTUBE_REFRESH_TOKEN;
    }
  }
}

module.exports = { getSettings, saveSettings, applyToEnv };
