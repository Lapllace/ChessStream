require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const QueueManager = require('../queue/QueueManager');
const ChessMonitor = require('../chess/ChessMonitor');
const TwitchBot    = require('../chat/TwitchBot');
const YouTubeBot   = require('../chat/YouTubeBot');
const Database     = require('./database');

let mainWindow;
let queueManager;
let chessMonitor;
let twitchBot;
let youtubeBot;

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
  const db = new Database();
  db.init();

  queueManager = new QueueManager(db, sendToRenderer);
  chessMonitor  = new ChessMonitor(queueManager, sendToRenderer);
  twitchBot     = new TwitchBot(queueManager, sendToRenderer);
  youtubeBot    = new YouTubeBot(queueManager, sendToRenderer);

  createWindow();

  // Inicia monitoramento do Chess.com (polling a cada 20s)
  chessMonitor.start();

  // Inicia bots de chat
  if (process.env.TWITCH_OAUTH_TOKEN) await twitchBot.connect();
  if (process.env.YOUTUBE_API_KEY)    await youtubeBot.connect();

  // Opção B: Supabase Realtime
  if (process.env.SUPABASE_URL) {
    const SupabaseListener = require('./supabaseListener');
    const listener = new SupabaseListener(queueManager, sendToRenderer);
    listener.start();
  }
});

app.on('window-all-closed', () => {
  chessMonitor?.stop();
  twitchBot?.disconnect();
  youtubeBot?.disconnect();
  if (process.platform !== 'darwin') app.quit();
});

// ── Comunicação com Renderer ──────────────────────────────────────────────────
function sendToRenderer(event, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, payload);
  }
}

// ── IPC: ações do painel ──────────────────────────────────────────────────────
ipcMain.handle('queue:get', () => queueManager.getQueue());

ipcMain.handle('queue:next', () => {
  const player = queueManager.next();
  if (player) {
    // Abre Chess.com já com o oponente selecionado
    shell.openExternal(`https://www.chess.com/play/online/new?opponent=${player.chessNick}`);
  }
  return player;
});

ipcMain.handle('queue:skip', () => queueManager.skip());

ipcMain.handle('queue:remove', (_, username) => queueManager.remove(username));

ipcMain.handle('queue:reorder', (_, orderedIds) => queueManager.reorder(orderedIds));

ipcMain.handle('queue:pause', () => queueManager.setPaused(true));

ipcMain.handle('queue:resume', () => queueManager.setPaused(false));

ipcMain.handle('queue:promote', (_, username) => queueManager.promote(username));

ipcMain.handle('config:get', () => ({
  streamerNick: process.env.CHESS_STREAMER_NICK,
  twitchChannel: process.env.TWITCH_CHANNEL,
  supabaseEnabled: !!process.env.SUPABASE_URL,
}));
