require('dotenv').config();
const { app } = require('electron');
app.commandLine.appendSwitch(
  'disable-features',
  'WebAuthentication,WebAuthenticationDevice,CredentialManagement'
);
const { BrowserWindow, ipcMain, shell, session } = require('electron');
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getSettings, getPublicSettings, getLivepixConfig, saveSettings, applyToEnv, ensureStreamerIdentity } = require('./settings');
const {
  buildWebhookUrl,
  hasLivepixCredentials,
  syncStreamerConfig,
} = require('./livepixConfig');

// Servidor do overlay OBS
let overlayServer = null;

function startOverlayServer() {
  if (overlayServer) return; // já rodando

  overlayServer = http.createServer((req, res) => {
    if (req.url === '/overlay' || req.url === '/') {
      const overlayPath = path.join(__dirname, '../renderer/overlay.html');
      try {
        const html = fs.readFileSync(overlayPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end('Overlay not found');
      }
      return;
    }

    if (req.url === '/queue-data') {
      try {
        const queue   = queueManager?.getQueue?.() || Promise.resolve([]);
        const current = queueManager?.currentPlayer || null;
        Promise.resolve(queue).then((q) => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ queue: q, current }));
        }).catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ queue: [], current: null }));
        });
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ queue: [], current: null }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  overlayServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn('[Overlay] Porta 17563 já em uso — overlay não iniciado.');
    } else {
      console.error('[Overlay] Erro no servidor:', err.message);
    }
  });

  overlayServer.listen(17563, '127.0.0.1', () => {
    console.log('[Overlay] Disponível em http://localhost:17563/overlay');
  });
}

process.on('unhandledRejection', (reason) => {
  const message = reason?.exception?.message || reason?.message || '';
  if (message.includes('map')) return;
  console.error('[Sistema] Rejeição não tratada:', reason);
});

const QueueManager = require('../queue/QueueManager');
const ChessMonitor = require('../chess/ChessMonitor');
const TwitchBot    = require('../chat/TwitchBot');
const { sanitizeTwitchToken } = TwitchBot;
const TikTokBot   = require('../chat/TikTokBot');
const YouTubeBot   = require('../chat/YouTubeBot');

let mainWindow;
let queueManager;
let chessMonitor;
let twitchBot;
let tiktokBot;
let youtubeBot;
let supabaseListener;
let activationWindow = null;
// Último resultado da validação. `allowed` é o gate único de bots/serviços.
let licenseStatus = null;
let licenseWatcherTimer = null;

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];
const YOUTUBE_REDIRECT_URI = 'http://localhost:42813/oauth2callback';
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

// ── Licença (assinatura mensal) ───────────────────────────────────────────────
const LICENSE_API_URL = process.env.LICENSE_API_URL
  || 'https://chessstream.vercel.app/api/license';
const LICENSE_CHECK_INTERVAL_DAYS = 3;
const LICENSE_WARN_DAYS = 7;
const LICENSE_DAY_MS = 24 * 60 * 60 * 1000;
const LICENSE_KEY_PATTERN = /^CSH-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
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

// ── Licença (ativação/validação via Vercel) ───────────────────────────────────
/** Aceita a chave colada sem hífens e devolve o formato canônico. */
function normalizeLicenseKey(value) {
  const raw = String(value || '').trim().toUpperCase();
  const compact = raw.replace(/[^A-Z0-9]/g, '');

  if (compact.length === 15 && compact.startsWith('CSH')) {
    return `CSH-${compact.slice(3, 7)}-${compact.slice(7, 11)}-${compact.slice(11, 15)}`;
  }

  return raw;
}

function maskLicenseKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  return key.length <= 8 ? key : `${key.slice(0, 4)}-****-****-${key.slice(-4)}`;
}

/** Consulta o endpoint. `null` significa offline: o cache local decide. */
async function checkLicense(key) {
  try {
    const response = await fetch(LICENSE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(10000),
    });
    return await response.json();
  } catch (err) {
    console.warn('[Licença] Verificação offline — usando cache local.', err?.message || '');
    return null; // null = modo offline, usar cache
  }
}

async function activateLicense(key) {
  try {
    const response = await fetch(LICENSE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, action: 'activate' }),
      signal: AbortSignal.timeout(10000),
    });
    return await response.json();
  } catch (err) {
    console.warn('[Licença] Falha ao ativar:', err?.message || '');
    return { error: 'Sem conexão com o servidor de licenças.' };
  }
}

/**
 * Atualiza somente o cache (sem tocar na chave). A chave em si só é gravada
 * após uma ativação bem-sucedida e sai cifrada pelo safeStorage, pois está
 * em SECRET_KEYS.
 */
function saveLicenseCache(result) {
  const settings = getSettings();
  const daysLeft = Number(result?.daysLeft);
  const expiresAt = result?.expiresAt ? new Date(result.expiresAt) : null;

  saveSettings({
    licenseExpiresAt: expiresAt && !Number.isNaN(expiresAt.getTime())
      ? expiresAt.toISOString()
      : settings.licenseExpiresAt,
    licenseCheckedAt: new Date().toISOString(),
    licenseDaysLeft: Number.isFinite(daysLeft) ? Math.max(0, daysLeft) : 0,
    licenseStatus: result?.valid ? 'active' : (settings.licenseStatus || ''),
  });
}

function persistActivatedLicense(key, result) {
  const daysLeft = Number(result?.daysLeft);
  const expiresAt = result?.expiresAt ? new Date(result.expiresAt) : null;

  saveSettings({
    licenseKey: key,
    licenseExpiresAt: expiresAt && !Number.isNaN(expiresAt.getTime())
      ? expiresAt.toISOString()
      : '',
    licenseCheckedAt: new Date().toISOString(),
    licenseDaysLeft: Number.isFinite(daysLeft) ? Math.max(0, daysLeft) : 0,
    licenseStatus: 'active',
  });
}

/**
 * Decide se o app pode abrir. Consulta a rede no máximo a cada 3 dias; fora
 * disso, usa o cache local. Sem conexão, aceita o cache até `licenseExpiresAt`
 * e bloqueia quando ele também expirou.
 */
async function validateLicenseOnBoot() {
  const settings = getSettings();
  const { licenseKey, licenseExpiresAt, licenseCheckedAt, licenseDaysLeft } = settings;

  if (!licenseKey) {
    return { allowed: false, reason: 'no_license', daysLeft: 0 };
  }

  const now = new Date();
  const cachedExpiry = licenseExpiresAt ? new Date(licenseExpiresAt) : null;
  const cacheValid = cachedExpiry
    && !Number.isNaN(cachedExpiry.getTime())
    && cachedExpiry > now;

  const lastCheck = licenseCheckedAt ? new Date(licenseCheckedAt) : null;
  const hasValidLastCheck = lastCheck && !Number.isNaN(lastCheck.getTime());
  const daysSinceCheck = hasValidLastCheck
    ? (now.getTime() - lastCheck.getTime()) / LICENSE_DAY_MS
    : Infinity;

  if (daysSinceCheck < LICENSE_CHECK_INTERVAL_DAYS) {
    return cacheValid
      ? { allowed: true, daysLeft: Number(licenseDaysLeft) || 0, expiresAt: licenseExpiresAt }
      : { allowed: false, reason: 'expired', message: 'Licença expirada. Renove para continuar.' };
  }

  const result = await checkLicense(licenseKey);

  if (result === null) {
    if (cacheValid) {
      console.warn('[Licença] Offline — usando cache. Expira em:', licenseExpiresAt);
      return {
        allowed: true,
        daysLeft: Number(licenseDaysLeft) || 0,
        expiresAt: licenseExpiresAt,
        offline: true,
        reason: 'offline_cache',
      };
    }
    return {
      allowed: false,
      reason: 'expired_offline',
      message: 'Sem conexão e sua licença não pôde ser validada. Conecte-se para renovar.',
    };
  }

  if (!result.valid) {
    const reason = result.needsActivation
      ? 'not_activated'
      : result.expired
        ? 'expired'
        : result.revoked
          ? 'revoked'
          : 'invalid';

    return {
      allowed: false,
      reason,
      message: result.message || result.error || 'Licença inválida.',
    };
  }

  saveLicenseCache(result);

  return {
    allowed: true,
    daysLeft: Number(result.daysLeft) || 0,
    expiresAt: result.expiresAt,
    message: result.message,
  };
}

/**
 * Janela dedicada de ativação. A janela principal nem é criada enquanto a
 * licença não for válida, evitando que os bots/overlay subam por engano.
 */
function createActivationWindow(reason = 'no_license') {
  if (activationWindow && !activationWindow.isDestroyed()) {
    activationWindow.focus();
    return activationWindow;
  }

  activationWindow = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    autoHideMenuBar: true,
    title: 'ChessStream Hub — Ativação',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  activationWindow.removeMenu();
  activationWindow.on('closed', () => {
    activationWindow = null;
  });

  // loadFile com `query` já monta a URL final (?reason=...). Chamar loadFile
  // e loadURL em seguida faria a tela carregar duas vezes.
  activationWindow.loadFile(
    path.join(__dirname, '../renderer/activation.html'),
    { query: { reason } }
  );

  return activationWindow;
}

/** Envia o banner quando faltam <= 7 dias, esperando o renderer carregar. */
function notifyLicenseWarning(status) {
  if (!status?.allowed) return;

  const daysLeft = Number(status.daysLeft);
  if (!Number.isFinite(daysLeft) || daysLeft > LICENSE_WARN_DAYS) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const payload = {
    daysLeft: Math.max(0, daysLeft),
    expiresAt: status.expiresAt || getSettings().licenseExpiresAt,
  };
  const send = () => sendToRenderer('license:warning', payload);

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

/**
 * Revalida em segundo plano. O intervalo é curto (6h), mas a rede só é
 * consultada quando `licenseCheckedAt` tem mais de 3 dias — então continua
 * silencioso e cobre sessões longas sem reiniciar o app.
 */
function startLicenseWatcher() {
  if (licenseWatcherTimer) return;

  licenseWatcherTimer = setInterval(async () => {
    try {
      const status = await validateLicenseOnBoot();
      licenseStatus = status;

      if (!status.allowed) {
        console.warn('[Licença] Revalidação falhou:', status.reason, '-', status.message || '');
        sendToRenderer('license:expired', status);
        return;
      }

      notifyLicenseWarning(status);
    } catch (error) {
      console.warn('[Licença] Erro na revalidação silenciosa:', error?.message || error);
    }
  }, 6 * 60 * 60 * 1000);

  licenseWatcherTimer.unref?.();
}

/** Chamado pela tela de ativação depois do sucesso. */
async function openMainApp() {
  const status = licenseStatus?.allowed ? licenseStatus : await validateLicenseOnBoot();
  licenseStatus = status;

  if (!status.allowed) {
    return { ok: false, error: status.message || 'Licença inválida ou expirada.' };
  }

  // Cria a janela principal ANTES de fechar a de ativação: assim
  // `window-all-closed` nunca dispara no meio da troca.
  createWindow();
  startOverlayServer();
  startLicenseWatcher();

  await restartBots();

  if (activationWindow && !activationWindow.isDestroyed()) {
    activationWindow.close();
  }

  notifyLicenseWarning(status);
  return { ok: true };
}

// ── Janela principal ──────────────────────────────────────────────────────────
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  return mainWindow;
}

// ── Auto-updater ──────────────────────────────────────────────────────────────
/**
 * Verifica atualizações via GitHub Releases. Só roda em builds empacotados:
 * em `npm start` não existe `app-update.yml` e a checagem geraria erro.
 * O módulo é carregado sob demanda para não pesar no boot de desenvolvimento.
 */
function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[Updater] Modo desenvolvimento — verificação de atualizações desativada.');
    return;
  }

  try {
    const { autoUpdater } = require('electron-updater');

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = { info() {}, warn() {}, error() {}, debug() {} }; // silencia o log interno

    autoUpdater.on('update-available', (info) => {
      console.log(`[Updater] Atualização disponível: v${info.version}`);
    });
    autoUpdater.on('update-not-available', () => {
      console.log('[Updater] Aplicativo já está na versão mais recente.');
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[Updater] v${info.version} baixada — será instalada ao fechar o app.`);
    });
    autoUpdater.on('error', (error) => {
      console.warn('[Updater] Erro na verificação:', error?.message || error);
    });

    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      console.warn('[Updater] Não foi possível verificar atualizações:', error?.message || error);
    });
  } catch (error) {
    console.warn('[Updater] Módulo indisponível:', error?.message || error);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // safeStorage só existe depois do app pronto, por isso applyToEnv() (que
  // descriptografa o token da Twitch) roda aqui e não no topo do módulo.
  applyToEnv();

  // Identidade multi-tenant: precisa existir antes do QueueManager/listener.
  ensureStreamerIdentity();

  queueManager = new QueueManager(sendToRenderer, () => getSettings().streamerId);
  chessMonitor  = new ChessMonitor(queueManager, sendToRenderer);
  setupAutoUpdater();

  // A licença é validada ANTES de criar a janela principal ou iniciar
  // qualquer bot/monitor. Sem licença, só a tela de ativação aparece.
  const status = await validateLicenseOnBoot();
  licenseStatus = status;

  if (!status.allowed) {
    console.warn('[Licença] App bloqueado:', status.reason, '-', status.message || '');
    createActivationWindow(status.reason);
    return;
  }

  createWindow();
  startOverlayServer();
  startLicenseWatcher();
  notifyLicenseWarning(status);

  await restartBots();
}).catch((error) => {
  console.error('[App] Erro ao iniciar o Electron:', error);
});

// Serializa reinícios. Chamadas concorrentes (salvar config enquanto um login
// termina, por exemplo) criavam dois canais Realtime com o mesmo tópico e
// quebravam o Supabase com "cannot add postgres_changes callbacks ... after subscribe()".
let restartChain = Promise.resolve();

function restartBots() {
  const run = restartChain.catch(() => {}).then(() => restartBotsInternal());
  restartChain = run.catch(() => {});
  return run;
}

async function restartBotsInternal() {
  // Sem licença válida nenhum bot conecta (nem por settings:save/login).
  if (!licenseStatus?.allowed) {
    console.warn('[Licença] Bots não iniciados: licença inválida.');
    sendToRenderer('bots:restarted', { ok: false, reason: 'license_required' });
    return;
  }

  await twitchBot?.disconnect();
  tiktokBot?.stopMonitoring();
  youtubeBot?.disconnect();

  const previousSupabaseListener = supabaseListener;
  supabaseListener = null;
  await previousSupabaseListener?.stop();

  applyToEnv();

  // Reinicia o ChessMonitor para pegar o nick atualizado
  chessMonitor.stop();
  chessMonitor = new ChessMonitor(queueManager, sendToRenderer);
  chessMonitor.start();

  twitchBot = new TwitchBot(queueManager, sendToRenderer);
  const settings = getSettings();
  const tiktokUsername = settings.tiktokUsername || process.env.TIKTOK_USERNAME;
  tiktokBot = tiktokUsername
    ? new TikTokBot({
      tiktokUsername,
      tiktokSessionId: settings.tiktokSessionId || process.env.TIKTOK_SESSION_ID || '',
    }, queueManager, sendToRenderer)
    : null;
  if (tiktokBot) void tiktokBot.startMonitoring();

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

  // O TwitchBot valida as credenciais e aborta com log amigável quando faltam,
  // por isso chamamos connect() sempre (sem depender de env possivelmente vazio).
  await twitchBot.connect();
  if (process.env.YOUTUBE_ACCESS_TOKEN) await youtubeBot.connect();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseKey) {
    const SupabaseListener = require('./supabaseListener');
    const listener = new SupabaseListener(queueManager, sendToRenderer, {
      getStreamerId: () => getSettings().streamerId,
    });
    supabaseListener = listener;
    try {
      await listener.start();
    } catch (error) {
      // Uma falha do Supabase não pode bloquear o salvamento das configurações.
      console.error('[Supabase] Falha ao iniciar listener:', error?.message || error);
      await listener.stop().catch(() => {});
      if (supabaseListener === listener) supabaseListener = null;
    }
  } else {
    supabaseListener = null;
  }

  sendToRenderer('bots:restarted', { ok: true });
}

app.on('window-all-closed', async () => {
  if (licenseWatcherTimer) {
    clearInterval(licenseWatcherTimer);
    licenseWatcherTimer = null;
  }
  chessMonitor?.stop();
  await twitchBot?.disconnect();
  tiktokBot?.stopMonitoring();
  youtubeBot?.disconnect();
  await supabaseListener?.stop();
  overlayServer?.close();
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

ipcMain.handle('queue:next', async () => queueManager.next());

ipcMain.handle('queue:skip', async () => queueManager.skip());

ipcMain.handle('history:get', () => queueManager.getMatchHistory());

ipcMain.handle('queue:remove', async (_, username) => queueManager.remove(username));

ipcMain.handle('queue:reorder', async (_, orderedIds) => queueManager.reorder(orderedIds));

ipcMain.handle('queue:pause', () => queueManager.setPaused(true));

ipcMain.handle('queue:resume', () => queueManager.setPaused(false));

ipcMain.handle('queue:promote', async (_, username) => queueManager.promote(username));

ipcMain.handle('queue:manual-add', async (_, nick) => {
  const chessNick = String(nick || '').trim().replace(/^@+/, '');
  if (!chessNick) {
    return { ok: false, msg: 'Informe o nick do Chess.com.' };
  }

  try {
    // Usa o próprio nick como username para que o filtro anti-duplicatas
    // funcione por jogador. Um username fixo "Manual" bloquearia o segundo add.
    return await queueManager.join(chessNick, chessNick, 'manual');
  } catch (error) {
    console.error('[Fila] Erro ao adicionar manualmente:', error.message);
    return { ok: false, msg: 'Não foi possível adicionar agora.' };
  }
});

ipcMain.handle('tiktok:login', (event, username) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender);

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId;
    const authWindow = new BrowserWindow({
      width: 450,
      height: 700,
      parent: parentWindow,
      modal: true,
      show: false,
      autoHideMenuBar: true,
      title: 'Login TikTok',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // Muta a janela: os vídeos do feed não tocam áudio enquanto o login é lido.
    authWindow.webContents.setAudioMuted(true);

    // Bloqueia apenas os vídeos do CDN (os assets do login continuam a carregar).
    authWindow.webContents.session.webRequest.onBeforeRequest(
      { urls: ['*://*.tiktokcdn.com/*video*'] },
      (details, callback) => callback({ cancel: true })
    );

    let cookieReadFailed = false;
    let cookieCaptured = false;
    let checkingCookies = false;
    let cookieInterval = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (cookieInterval) {
        clearInterval(cookieInterval);
        cookieInterval = null;
      }
      if (!authWindow.isDestroyed()) authWindow.close();
      resolve(result);
    };

    if (typeof username === 'string' && username.trim()) {
      saveSettings({ tiktokUsername: username.trim() });
    }

    const checkCookies = async () => {
      if (settled || cookieCaptured || checkingCookies) return;
      checkingCookies = true;

      try {
        const cookies = await session.defaultSession.cookies.get({
          url: 'https://www.tiktok.com',
          name: 'sessionid',
        });
        if (settled) return;
        const sessionId = cookies.find((cookie) => cookie.value)?.value;
        if (!sessionId) return;

        cookieCaptured = true;
        clearTimeout(timeoutId);
        if (cookieInterval) {
          clearInterval(cookieInterval);
          cookieInterval = null;
        }
        saveSettings({ tiktokSessionId: sessionId });

        // Fecha já a janela para o vídeo/áudio parar imediatamente.
        if (!authWindow.isDestroyed()) authWindow.close();

        try {
          await restartBots();
          finish({ ok: true });
        } catch (error) {
          console.error(
            '[TikTok Auth] Login capturado, mas os bots não reiniciaram:',
            error?.message || error
          );
          finish({ ok: false, error: 'restart_failed' });
        }
      } catch (error) {
        if (cookieReadFailed) return;
        cookieReadFailed = true;
        console.warn(
          '[TikTok Auth] Não foi possível ler o cookie sessionid:',
          error?.message || error
        );
      } finally {
        checkingCookies = false;
      }
    };

    timeoutId = setTimeout(() => {
      finish({ ok: false, error: 'timeout' });
    }, 3 * 60 * 1000);

    authWindow.removeMenu();
    authWindow.webContents.on('did-finish-load', checkCookies);
    authWindow.webContents.on('did-navigate', checkCookies);
    authWindow.webContents.on('did-navigate-in-page', checkCookies);
    authWindow.once('ready-to-show', () => authWindow.show());
    authWindow.on('closed', () => {
      // Se o cookie já foi capturado, o fecho foi intencional.
      if (cookieCaptured) return;
      finish({ ok: false, error: 'cancelled' });
    });
    cookieInterval = setInterval(checkCookies, 1000);
    authWindow.loadURL('https://www.tiktok.com/login', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/124.0.0.0 Safari/537.36',
    });
  });
});

ipcMain.handle('config:get', () => {
  // O ChessMonitor inicia antes do renderer registrar o listener de
  // 'chat:status'. Reenvia o estado atual para o badge não ficar apagado.
  sendToRenderer('chat:status', chessMonitor?.getStatus?.() ?? {
    platform: 'chess',
    connected: false,
  });
  return {
    streamerNick: getSettings().chessStreamerNick || process.env.CHESS_STREAMER_NICK,
    twitchChannel: getSettings().twitchChannel || process.env.TWITCH_CHANNEL,
    supabaseEnabled: !!(
      getSettings().supabaseUrl
      || process.env.NEXT_PUBLIC_SUPABASE_URL
      || process.env.SUPABASE_URL
    ),
  };
});

ipcMain.handle('settings:get', () => {
  sendToRenderer('chat:status', chessMonitor?.getStatus?.() ?? {
    platform: 'chess',
    connected: false,
  });
  // Tokens permanecem no processo principal; o renderer só recebe flags.
  return getPublicSettings();
});

function readLegalDocument(name) {
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../..');
  const filePath = path.join(root, name);
  const packagedPrivacyPath = path.join(root, 'PRIVACY.md');
  const resolvedPath = fs.existsSync(filePath) ? filePath
    : name === path.join('docs', 'PRIVACY.md') && fs.existsSync(packagedPrivacyPath)
      ? packagedPrivacyPath
      : filePath;
  return fs.readFileSync(resolvedPath, 'utf8');
}

ipcMain.handle('terms:get', () => ({
  license: readLegalDocument('LICENSE.txt'),
  privacy: readLegalDocument(path.join('docs', 'PRIVACY.md')),
}));

ipcMain.handle('terms:accept', () => {
  saveSettings({ termsAccepted: true, termsAcceptedVersion: '1.0' });
  return { ok: true, version: '1.0' };
});

ipcMain.handle('settings:save', async (_, partial) => {
  const settings = { ...(partial || {}) };
  const loggedInTikTokUser = typeof settings.loggedInTikTokUser === 'string'
    ? settings.loggedInTikTokUser.trim()
    : '';
  delete settings.loggedInTikTokUser;
  if (loggedInTikTokUser) {
    settings.tiktokUsername = loggedInTikTokUser;
  }
  saveSettings(settings);

  // Publica as credenciais LivePix do streamer no Supabase. Falhas não
  // impedem o uso local, mas voltam para a UI para o usuário corrigir.
  // Só sincroniza quando o salvamento toca em algo relevante para o webhook.
  const livepixTouched = [
    'livepixClientId',
    'livepixClientSecret',
    'livepixWebhookBaseUrl',
    'supabaseUrl',
    'supabaseAnonKey',
  ].some((key) => Object.prototype.hasOwnProperty.call(settings, key));

  const livepix = livepixTouched ? await syncLivepixConfig() : null;

  await restartBots();
  return { ok: true, livepix };
});

// ── IPC: licença (assinatura mensal) ─────────────────────────────────────────
ipcMain.handle('license:activate', async (_, key) => {
  if (!key || typeof key !== 'string') {
    return { ok: false, error: 'Chave não informada.' };
  }

  const normalizedKey = normalizeLicenseKey(key);

  // Validação local do formato antes de gastar uma chamada de rede.
  if (!LICENSE_KEY_PATTERN.test(normalizedKey)) {
    return { ok: false, error: 'Formato inválido. Use CSH-XXXX-XXXX-XXXX.' };
  }

  // Primeiro consulta: identifica chave inexistente, revogada, expirada ou
  // que ainda precisa da primeira ativação.
  const checkResult = await checkLicense(normalizedKey);
  if (!checkResult) {
    return { ok: false, error: 'Sem conexão com o servidor. Verifique sua internet.' };
  }
  if (checkResult.error) {
    return { ok: false, error: checkResult.error };
  }
  if (checkResult.revoked || checkResult.expired) {
    return { ok: false, error: checkResult.message || 'Licença indisponível.' };
  }

  // Já ativada e válida: aceita direto.
  if (checkResult.valid) {
    persistActivatedLicense(normalizedKey, checkResult);
    licenseStatus = {
      allowed: true,
      daysLeft: checkResult.daysLeft,
      expiresAt: checkResult.expiresAt,
      message: checkResult.message,
    };
    return {
      ok: true,
      message: checkResult.message,
      daysLeft: checkResult.daysLeft,
    };
  }

  // Primeira utilização: confirma a ativação (inicia os 30 dias).
  if (checkResult.needsActivation) {
    const activateResult = await activateLicense(normalizedKey);

    if (!activateResult || activateResult.error) {
      return { ok: false, error: activateResult?.error || 'Erro ao ativar a licença.' };
    }
    if (activateResult.valid) {
      persistActivatedLicense(normalizedKey, activateResult);
      licenseStatus = {
        allowed: true,
        daysLeft: activateResult.daysLeft,
        expiresAt: activateResult.expiresAt,
        message: activateResult.message,
      };
      return {
        ok: true,
        message: activateResult.message,
        daysLeft: activateResult.daysLeft,
      };
    }

    return { ok: false, error: activateResult.message || 'Não foi possível ativar a chave.' };
  }

  return { ok: false, error: checkResult.message || 'Chave inválida.' };
});

ipcMain.handle('license:get', () => {
  const s = getSettings();
  return {
    key: maskLicenseKey(s.licenseKey),
    expiresAt: s.licenseExpiresAt,
    daysLeft: s.licenseDaysLeft,
  };
});

ipcMain.handle('license:open-app', () => openMainApp());

// Compatibilidade com o badge do modal de Configurações (settingsModal.js):
// apenas lê o estado em memória, nunca dispara consulta online.
ipcMain.handle('license:status', () => {
  const s = getSettings();
  const status = licenseStatus;
  const valid = Boolean(status?.allowed);

  return {
    valid,
    reason: valid
      ? (status.offline ? 'offline_grace' : 'active')
      : (status?.reason || (s.licenseKey ? 'invalid' : 'no_license')),
    offline: Boolean(status?.offline),
    daysLeft: Number(status?.daysLeft ?? s.licenseDaysLeft) || 0,
    expiresAt: status?.expiresAt || s.licenseExpiresAt || '',
    keyMasked: maskLicenseKey(s.licenseKey),
    message: status?.message || '',
  };
});

/**
 * Sincroniza streamer_configs e devolve a URL pronta para o painel do LivePix.
 * A URL é sempre reconstruída a partir da identidade local (streamer_id +
 * webhook_secret), mesmo quando o Supabase ainda não foi configurado.
 */
async function syncLivepixConfig() {
  const config = getLivepixConfig();
  const configured = hasLivepixCredentials(config);
  const webhookUrl = buildWebhookUrl({
    baseUrl: config.baseUrl,
    streamerId: config.streamerId,
    secret: config.webhookSecret,
  });

  if (!configured) {
    return { configured: false, synced: false, webhookUrl, error: null };
  }

  const result = await syncStreamerConfig(config);
  return {
    configured: true,
    synced: result.ok,
    webhookUrl,
    error: result.ok ? null : result.error,
  };
}

async function fetchTwitchUser(accessToken, clientId) {
  const response = await fetch('https://api.twitch.tv/helix/users', {
    headers: {
      'Client-Id': clientId,
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const error = new Error(`Helix respondeu ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json();
  return payload?.data?.[0] || null;
}

ipcMain.handle('twitch:login', (event, clientIdFromRenderer) => new Promise((resolve) => {
  let settled = false;
  let redirectHandled = false;
  let tokenCaptured = false;
  let timeoutId;
  let authWindow = null;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    if (authWindow && !authWindow.isDestroyed()) authWindow.close();
    resolve(result);
  };

  // O Client ID digitado no formulário tem prioridade sobre env/settings,
  // permitindo conectar antes mesmo de salvar as configurações.
  const clientId = String(clientIdFromRenderer || '').trim()
    || String(process.env.TWITCH_CLIENT_ID || '').trim()
    || String(getSettings().twitchClientId || '').trim();

  if (!clientId) {
    finish({ ok: false, error: 'Client ID da Twitch não configurado.' });
    return;
  }

  timeoutId = setTimeout(() => {
    finish({ ok: false, error: 'timeout' });
  }, 3 * 60 * 1000);

  // Implicit Grant Flow: o access_token volta no hash do redirect.
  const redirectUri = 'http://localhost';
  const authUrl = 'https://id.twitch.tv/oauth2/authorize'
    + `?response_type=token&client_id=${encodeURIComponent(clientId)}`
    + '&redirect_uri=http://localhost&scope=chat:read+chat:edit';

  const parentWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  authWindow = new BrowserWindow({
    width: 520,
    height: 720,
    parent: parentWindow,
    modal: true,
    title: 'Login com a Twitch',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  authWindow.removeMenu();

  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('accounts.google.com') || url.includes('google.com/signin')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  authWindow.once('ready-to-show', () => {
    if (!authWindow.isDestroyed()) authWindow.show();
  });

  authWindow.webContents.on('dom-ready', () => {
    authWindow.webContents.executeJavaScript(`
      try {
        Object.defineProperty(navigator, 'credentials', {
          get: () => undefined,
          configurable: true
        });
      } catch (e) {}
    `).catch(() => {});
  });

  // O token vem no fragment: http://localhost/#access_token=TOKEN&...
  const extractTwitchToken = (url) => {
    if (!url.startsWith('http://localhost')) return null;
    const hash = url.includes('#') ? url.split('#')[1] : '';
    const params = new URLSearchParams(hash);
    return params.get('access_token') || null;
  };

  const completeLogin = async (browserEvent, url) => {
    const token = extractTwitchToken(url);
    if (!token) return;

    if (browserEvent?.preventDefault) browserEvent.preventDefault();
    if (redirectHandled || settled) return;
    redirectHandled = true;

    // Fecha a janela assim que o token é capturado; a consulta do username
    // acontece em segundo plano e não deve manter a janela aberta.
    tokenCaptured = true;
    if (authWindow && !authWindow.isDestroyed()) authWindow.close();

    let username = '';
    try {
      const user = await fetchTwitchUser(token, clientId);
      username = user?.login || '';
    } catch (error) {
      if (error.status === 401) {
        finish({ ok: false, error: 'Token da Twitch inválido ou expirado.' });
        return;
      }
      // A consulta serve só para descobrir o username; o token em si veio de
      // um redirect oficial da Twitch.
      console.warn('[Twitch Auth] Não foi possível consultar o usuário:', error.message);
    }

    finish({
      ok: true,
      token: sanitizeTwitchToken(token),
      clientId,
      username,
    });
  };

  // did-navigate-in-page dispara quando apenas o fragment muda; did-navigate
  // cobre a navegação completa. will-redirect fica como terceira tentativa
  // para builds do Chromium que abortam a requisição antes do did-navigate.
  authWindow.webContents.on('did-navigate', (browserEvent, url) => {
    if (!extractTwitchToken(url)) return;
    void completeLogin(browserEvent, url);
  });

  authWindow.webContents.on('did-navigate-in-page', (browserEvent, url) => {
    if (!extractTwitchToken(url)) return;
    void completeLogin(browserEvent, url);
  });

  authWindow.webContents.on('will-redirect', (browserEvent, url) => {
    if (!url.startsWith('http://localhost')) return;
    browserEvent.preventDefault();
    const token = extractTwitchToken(url);
    if (token) {
      void completeLogin(browserEvent, url);
    } else {
      finish({ ok: false, error: 'Token não encontrado no redirect' });
    }
  });

  authWindow.on('closed', () => {
    // Se o token já foi capturado, o fecho foi intencional.
    if (tokenCaptured) return;
    finish({ ok: false, error: 'cancelled' });
  });

  const standardUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/124.0.0.0 Safari/537.36';
  authWindow.loadURL(authUrl, { userAgent: standardUserAgent });
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
