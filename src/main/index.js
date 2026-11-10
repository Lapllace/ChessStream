require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const http = require('http');
const { google } = require('googleapis');
const path = require('path');
const { getSettings, saveSettings, applyToEnv } = require('./settings');

applyToEnv();

const QueueManager = require('../queue/QueueManager');
const ChessMonitor = require('../chess/ChessMonitor');
const TwitchBot    = require('../chat/TwitchBot');
const YouTubeBot   = require('../chat/YouTubeBot');

let mainWindow;
let queueManager;
let chessMonitor;
let twitchBot;
let youtubeBot;
let supabaseListener;

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];
const YOUTUBE_REDIRECT_URI = 'http://localhost:42813/oauth2callback';

// ── Janela principal ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ChessStream Hub',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  queueManager = new QueueManager(sendToRenderer);
  chessMonitor  = new ChessMonitor(queueManager, sendToRenderer);
  createWindow();

  // Inicia monitoramento do Chess.com (polling a cada 20s)
  chessMonitor.start();

  await restartBots();
}).catch((error) => {
  console.error('[App] Erro ao iniciar o Electron:', error);
});

async function restartBots() {
  twitchBot?.disconnect();
  youtubeBot?.disconnect();
  supabaseListener?.stop();

  applyToEnv();

  twitchBot = new TwitchBot(queueManager, sendToRenderer);
  youtubeBot = new YouTubeBot(queueManager, sendToRenderer);

  if (process.env.TWITCH_OAUTH_TOKEN) await twitchBot.connect();
  if (process.env.YOUTUBE_ACCESS_TOKEN) await youtubeBot.connect();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseKey) {
    const SupabaseListener = require('./supabaseListener');
    supabaseListener = new SupabaseListener(queueManager, sendToRenderer);
    supabaseListener.start();
  } else {
    supabaseListener = null;
  }

  sendToRenderer('bots:restarted', { ok: true });
}

app.on('window-all-closed', () => {
  chessMonitor?.stop();
  twitchBot?.disconnect();
  youtubeBot?.disconnect();
  supabaseListener?.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ── Comunicação com Renderer ──────────────────────────────────────────────────
function sendToRenderer(event, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, payload);
  }
}

// ── IPC: ações do painel ──────────────────────────────────────────────────────
ipcMain.handle('queue:get', async () => queueManager.getQueue());

ipcMain.handle('queue:next', async () => {
  const player = await queueManager.next();
  if (player) {
    // Abre Chess.com já com o oponente selecionado
    shell.openExternal(`https://www.chess.com/play/online/new?opponent=${player.chessNick}`);
  }
  return player;
});

ipcMain.handle('queue:skip', async () => queueManager.skip());

ipcMain.handle('queue:remove', async (_, username) => queueManager.remove(username));

ipcMain.handle('queue:reorder', async (_, orderedIds) => queueManager.reorder(orderedIds));

ipcMain.handle('queue:pause', () => queueManager.setPaused(true));

ipcMain.handle('queue:resume', () => queueManager.setPaused(false));

ipcMain.handle('queue:promote', async (_, username) => queueManager.promote(username));

ipcMain.handle('config:get', () => ({
  streamerNick: getSettings().chessStreamerNick || process.env.CHESS_STREAMER_NICK,
  twitchChannel: getSettings().twitchChannel || process.env.TWITCH_CHANNEL,
  supabaseEnabled: !!(
    getSettings().supabaseUrl
    || process.env.NEXT_PUBLIC_SUPABASE_URL
    || process.env.SUPABASE_URL
  ),
}));

ipcMain.handle('settings:get', () => getSettings());

ipcMain.handle('settings:save', async (_, partial) => {
  saveSettings(partial);
  await restartBots();
  return { ok: true };
});

ipcMain.handle('twitch:login', () => new Promise((resolve) => {
  const authWindow = new BrowserWindow({
    width: 500,
    height: 650,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  let resolved = false;
  const finish = (result) => {
    if (resolved) return;
    resolved = true;
    resolve(result);
  };

  const clientId = process.env.TWITCH_CLIENT_ID || getSettings().twitchClientId;
  if (!clientId) {
    authWindow.close();
    finish({ ok: false, error: 'TWITCH_CLIENT_ID não configurado' });
    return;
  }

  const redirectUri = 'http://localhost';
  const scope = 'chat:read+chat:edit';
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${scope}`;

  authWindow.loadURL(url);
  authWindow.webContents.on('will-redirect', async (event, redirectUrl) => {
    if (!redirectUrl.startsWith(`${redirectUri}#access_token=`)) return;
    const token = redirectUrl.split('#access_token=')[1].split('&')[0];
    saveSettings({ twitchOAuthToken: `oauth:${token}` });
    authWindow.close();
    try {
      await restartBots();
      finish({ ok: true, token: `oauth:${token}` });
    } catch (error) {
      console.error('[Twitch] Erro ao reiniciar após login:', error);
      finish({ ok: false, error: 'Login concluído, mas não foi possível iniciar o bot.' });
    }
  });
  authWindow.on('closed', () => finish({ ok: false, error: 'Cancelado pelo usuário' }));
}));

ipcMain.handle('google:login', () => new Promise((resolve) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    resolve({
      ok: false,
      error: 'GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET não configurados.',
    });
    return;
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    YOUTUBE_REDIRECT_URI
  );
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: YOUTUBE_SCOPES,
  });
  const authWindow = new BrowserWindow({
    width: 500,
    height: 700,
    title: 'Login com Google',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  let settled = false;
  let server;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    server?.close();
    if (!authWindow.isDestroyed()) authWindow.close();
    resolve(result);
  };

  server = http.createServer(async (request, response) => {
    const callbackUrl = new URL(request.url, YOUTUBE_REDIRECT_URI);
    const error = callbackUrl.searchParams.get('error');
    const code = callbackUrl.searchParams.get('code');

    if (error) {
      response.end('<h2>Login cancelado. Pode fechar esta janela.</h2>');
      finish({ ok: false, error: `Google: ${error}` });
      return;
    }
    if (!code) {
      response.end('<h2>Callback OAuth inválido.</h2>');
      return;
    }

    response.end('<h2>Autorizado! Pode fechar esta janela.</h2>');
    try {
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      const { data } = await youtube.channels.list({ part: 'snippet', mine: true });
      const channel = data.items?.[0];
      if (!channel) throw new Error('Nenhum canal YouTube foi encontrado nesta conta.');

      saveSettings({
        youtubeAccessToken: tokens.access_token || '',
        youtubeRefreshToken: tokens.refresh_token || getSettings().youtubeRefreshToken || '',
        youtubeChannelId: channel.id,
        youtubeChannelName: channel.snippet?.title || '',
      });
      applyToEnv();
      await restartBots();
      finish({
        ok: true,
        channelName: channel.snippet?.title || '',
        channelId: channel.id,
      });
    } catch (requestError) {
      console.error('[Google] Erro no login do YouTube:', requestError);
      finish({ ok: false, error: requestError.message });
    }
  });

  server.once('error', (error) => {
    console.error('[Google] Não foi possível abrir a porta OAuth:', error);
    finish({ ok: false, error: 'A porta local do login Google está indisponível.' });
  });
  server.listen(42813, '127.0.0.1', () => authWindow.loadURL(authUrl));
  authWindow.on('closed', () => finish({ ok: false, error: 'Cancelado pelo usuário' }));
}));
