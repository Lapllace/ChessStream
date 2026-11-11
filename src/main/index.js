require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');
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
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
const GOOGLE_AUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ChessStream Hub - Autorizado</title>
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #090710;
      background-image:
        radial-gradient(circle at 50% 50%, #1e1333 0%, #090710 80%),
        linear-gradient(rgba(199, 125, 255, .03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(199, 125, 255, .03) 1px, transparent 1px);
      background-size: 100% 100%, 20px 20px, 20px 20px;
      color: #fff;
      font-family: "Press Start 2P", monospace;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      overflow: hidden;
    }
    .undertale-box {
      background: #120d24;
      border: 4px solid #fff;
      outline: 4px solid #9d4edd;
      box-shadow: 0 0 25px rgba(157, 78, 221, .4);
      padding: 40px;
      width: min(460px, calc(100vw - 32px));
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      animation: shake .25s cubic-bezier(.36, .07, .19, .97) .6s both;
    }
    .stage {
      width: 100px;
      height: 100px;
      position: relative;
      margin-bottom: 25px;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .pawn, .queen { position: absolute; }
    .pawn {
      width: 65px;
      height: 65px;
      animation: dropPawn .6s cubic-bezier(.6, -.28, .735, .045) forwards,
        pawnGlow 1.2s ease-in-out 1.4s forwards;
    }
    .queen {
      width: 75px;
      height: 75px;
      opacity: 0;
      transform: scale(.5);
      animation: promoteQueen .5s ease-out 2.4s forwards,
        floatQueen 2s ease-in-out 2.9s infinite alternate;
    }
    .title {
      font-size: 14px;
      color: #c77dff;
      line-height: 1.6;
      opacity: 0;
      transform: translateY(10px);
      animation: popText .3s ease-out .7s forwards;
    }
    .subtitle {
      font-size: 10px;
      color: #a0a0c0;
      margin-top: 15px;
      line-height: 1.5;
      opacity: 0;
      animation: fadeIn .4s ease-out 1.1s forwards;
    }
    .badge {
      display: inline-block;
      margin-top: 20px;
      padding: 6px 12px;
      border: 2px solid #7b2cbf;
      background: #241442;
      color: #e0aaff;
      font-size: 9px;
      opacity: 0;
      animation: fadeIn .4s ease-out 2.5s forwards;
    }
    @keyframes shake {
      10%, 90% { transform: translate3d(-2px, 2px, 0); }
      20%, 80% { transform: translate3d(3px, -3px, 0); }
      30%, 50%, 70% { transform: translate3d(-5px, 5px, 0); }
      40%, 60% { transform: translate3d(5px, -5px, 0); }
    }
    @keyframes dropPawn {
      0% { transform: translateY(-350px) scale(.6); opacity: 0; }
      80% { opacity: 1; }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }
    @keyframes pawnGlow {
      0% { filter: drop-shadow(0 0 0 #c77dff); }
      50% {
        filter: drop-shadow(0 0 20px #c77dff) brightness(2.5);
        transform: scale(1.15);
        opacity: 1;
      }
      100% {
        filter: drop-shadow(0 0 40px #fff) brightness(4);
        transform: scale(1.3);
        opacity: 0;
      }
    }
    @keyframes promoteQueen {
      0% { opacity: 0; transform: scale(.3); filter: drop-shadow(0 0 30px #fff); }
      100% { opacity: 1; transform: scale(1); filter: drop-shadow(0 0 15px #c77dff); }
    }
    @keyframes floatQueen {
      0% { transform: translateY(0); filter: drop-shadow(0 0 12px #c77dff); }
      100% { transform: translateY(-6px); filter: drop-shadow(0 0 22px #f72585); }
    }
    @keyframes popText {
      0% { opacity: 0; transform: scale(.8) translateY(10px); }
      70% { transform: scale(1.05) translateY(-2px); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes fadeIn { to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
      }
    }
  </style>
</head>
<body>
  <div class="undertale-box">
    <div class="stage">
      <svg class="pawn" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="50" cy="28" r="14" fill="#fff"/>
        <path d="M38 46H62L58 68H42Z" fill="#fff"/>
        <rect x="30" y="72" width="40" height="8" rx="2" fill="#fff"/>
        <rect x="22" y="84" width="56" height="10" rx="2" fill="#fff"/>
      </svg>
      <svg class="queen" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="20" cy="22" r="4" fill="#f72585"/>
        <circle cx="50" cy="16" r="5" fill="#f72585"/>
        <circle cx="80" cy="22" r="4" fill="#f72585"/>
        <path d="M18 30L34 46L50 26L66 46L82 30L76 68H24Z" fill="#c77dff"/>
        <rect x="26" y="72" width="48" height="8" rx="2" fill="#fff"/>
        <rect x="18" y="84" width="64" height="10" rx="2" fill="#fff"/>
      </svg>
    </div>
    <div class="title">AUTORIZADO!</div>
    <div class="subtitle">LOGIN EFETUADO COM SUCESSO.</div>
    <div class="badge">Pode fechar esta janela</div>
  </div>
</body>
</html>`;

function loadGoogleCredentials() {
  const credPath = path.join(
    __dirname,
    '../../assets/client_secret_532294206568-hhdb5lhl6gsr24lfblngdcv8e18uj358.apps.googleusercontent.com.json'
  );
  try {
    const raw = fs.readFileSync(credPath, 'utf8');
    const json = JSON.parse(raw);
    const creds = json.installed || json.web;
    if (!creds?.client_id || !creds?.client_secret) {
      throw new Error('Formato inválido: campos client_id ou client_secret ausentes.');
    }
    return creds;
  } catch (error) {
    console.error('[Google] Erro ao carregar credenciais OAuth:', error.message);
    return null;
  }
}

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
  let ytOAuth2Client = null;
  const googleCreds = loadGoogleCredentials();
  if (googleCreds) {
    ytOAuth2Client = new google.auth.OAuth2(
      googleCreds.client_id,
      googleCreds.client_secret,
      YOUTUBE_REDIRECT_URI
    );
    const accessToken = process.env.YOUTUBE_ACCESS_TOKEN;
    const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
    if (accessToken) {
      ytOAuth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken || undefined,
      });
      ytOAuth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) {
          saveSettings({ youtubeAccessToken: tokens.access_token });
        }
        if (tokens.refresh_token) {
          saveSettings({ youtubeRefreshToken: tokens.refresh_token });
        }
      });
    }
  }
  youtubeBot = new YouTubeBot(queueManager, sendToRenderer, ytOAuth2Client);

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
  const creds = loadGoogleCredentials();
  if (!creds) {
    resolve({
      ok: false,
      error: 'Arquivo de credenciais Google não encontrado em assets/.',
    });
    return;
  }
  const clientId = creds.client_id;
  const clientSecret = creds.client_secret;

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
  let settled = false;
  let server;
  let timeoutId;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    server?.close();
    resolve(result);
  };

  server = http.createServer(async (request, response) => {
    const callbackUrl = new URL(request.url, YOUTUBE_REDIRECT_URI);
    const error = callbackUrl.searchParams.get('error');
    const code = callbackUrl.searchParams.get('code');

    if (error) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChessStream Hub</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 48px 40px; text-align: center; max-width: 400px; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 8px; color: #fff; }
    p { font-size: 14px; color: #888; line-height: 1.6; }
    .accent { color: #ef4444; }
  </style>
</head>
<body><div class="card"><div class="icon">❌</div><h1>Falha na autenticação</h1><p>Não foi possível conectar sua conta Google.<br><span class="accent">Volte ao app e tente novamente.</span></p></div></body>
</html>`);
      finish({ ok: false, error: `Google: ${error}` });
      return;
    }
    if (!code) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChessStream Hub</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 48px 40px; text-align: center; max-width: 400px; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 8px; color: #fff; }
    p { font-size: 14px; color: #888; line-height: 1.6; }
    .accent { color: #ef4444; }
  </style>
</head>
<body><div class="card"><div class="icon">❌</div><h1>Falha na autenticação</h1><p>Não foi possível conectar sua conta Google.<br><span class="accent">Volte ao app e tente novamente.</span></p></div></body>
</html>`);
      finish({ ok: false, error: 'Callback OAuth inválido.' });
      return;
    }

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
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(GOOGLE_AUTH_SUCCESS_HTML);
      finish({
        ok: true,
        channelName: channel.snippet?.title || '',
        channelId: channel.id,
      });
    } catch (requestError) {
      console.error('[Google] Erro no login do YouTube:', requestError);
      response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<h1>Erro na autenticação</h1><p>${requestError.message}</p>`);
      finish({ ok: false, error: requestError.message });
    }
  });

  server.once('error', (error) => {
    console.error('[Google] Não foi possível abrir a porta OAuth:', error);
    finish({ ok: false, error: 'A porta local do login Google está indisponível.' });
  });
  server.listen(42813, '127.0.0.1', () => shell.openExternal(authUrl));
  timeoutId = setTimeout(() => {
    server.close();
    finish({ ok: false, error: 'timeout' });
  }, LOGIN_TIMEOUT_MS);
}));
