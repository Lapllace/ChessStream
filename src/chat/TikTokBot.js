const { WebcastPushConnection } = require('tiktok-live-connector/legacy');

const AUTH_ERROR_PATTERN = /login authentication failed|authentication failed|invalid session|session\s*id|sessionid|failed to retrieve session/i;
const RATE_LIMIT_PATTERN = /rate limit|too many connections/i;
const IGNORED_ERROR_PATTERN = /\bmap\b|TopViewer/i;
const DEFAULT_RECONNECT_DELAY = 30000;
const RATE_LIMIT_RECONNECT_DELAY = 5 * 60 * 1000;

function errorMessage(error) {
  return String(
    error?.exception?.message
    || error?.message
    || error?.info
    || error?.exception
    || error
    || ''
  );
}

class TikTokBot {
  constructor(options = {}, queueManager = null, sendToRenderer = null) {
    this.username = (options.tiktokUsername || '').replace(/^@/, '').trim();
    this.sessionId = options.tiktokSessionId || '';
    this.queueManager = queueManager;
    this.send = sendToRenderer;
    this.connection = null;
    this.reconnectTimeout = null;
    this.isConnecting = false;
    this.authFailed = false;
    this.stopped = true;
    this.reconnectDelay = DEFAULT_RECONNECT_DELAY;
    this.startTime = Date.now();
    this.isReady = false;
  }

  async startMonitoring() {
    this.stopMonitoring();
    if (!this.username) {
      console.log('[TikTok] Usuário não configurado — bot não iniciado.');
      return;
    }
    this.authFailed = false;
    this.stopped = false;
    this.startTime = Date.now();
    this.isReady = false;
    if (this.isConnecting) return;
    this.isConnecting = true;

    console.log(`[TikTok] Tentando conectar na live de @${this.username}...`);
    const options = {
      enableExtendedGiftInfo: false,
      requestOptions: { timeout: 10000 },
    };

    if (this.sessionId.trim()) options.sessionId = this.sessionId.trim();

    try {
      this.connection = new WebcastPushConnection(this.username, options);

      this.connection.on('error', (error) => {
        const message = errorMessage(error);

        // Log inútil da lib (dados quebrados quando a sessão é inválida).
        if (IGNORED_ERROR_PATTERN.test(message)) return;

        // Sessão inválida/expirada: para de reconectar e avisa o utilizador.
        if (AUTH_ERROR_PATTERN.test(message)) {
          this.handleAuthFailure(message);
          return;
        }

        if (RATE_LIMIT_PATTERN.test(message)) {
          this.reconnectDelay = RATE_LIMIT_RECONNECT_DELAY;
          console.error(
            '[TikTok] Rate Limit atingido. A próxima tentativa será feita em 5 minutos.'
          );
          this.scheduleReconnect();
          return;
        }

        console.error('[TikTok] Aviso de Conexão:', message || error);
      });

      this.connection.on('chat', (data) => {
        // Enquanto a conexão não estiver pronta, o SDK pode entregar o
        // histórico da sala. Ignora silenciosamente para não reprocessar comandos.
        if (!this.isReady) return;

        // createTime vem em segundos; descarta mensagens anteriores ao início
        // desta conexão.
        const createTime = Number(data?.createTime);
        if (Number.isFinite(createTime) && (createTime * 1000) < this.startTime) {
          return;
        }

        const username = data?.uniqueId || data?.user?.uniqueId || '';
        const message = data?.comment || data?.content || '';

        // Log de diagnóstico: confirma que os comentários estão chegando.
        console.log(`[TikTok] @${username || 'desconhecido'}: ${message}`);

        if (!username || !message) return;

        this.handleMessage(username, message).catch((error) => {
          console.error('[TikTok] Erro ao processar comando:', errorMessage(error));
        });
      });

      this.connection.on('connected', (state) => {
        console.log(`[TikTok] Conectado com sucesso! Room ID: ${state.roomId}`);
        this.isConnecting = false;
        this.authFailed = false;
        this.isReady = true;
        this.reconnectDelay = DEFAULT_RECONNECT_DELAY;
        this.send?.('chat:status', { platform: 'tiktok', connected: true });
      });

      this.connection.on('disconnected', () => {
        console.warn('[TikTok] Desconectado da live.');
        this.isReady = false;
        this.send?.('chat:status', { platform: 'tiktok', connected: false });
        this.scheduleReconnect();
      });

      this.connection.on('streamEnd', () => {
        console.warn('[TikTok] A live foi encerrada pelo streamer.');
        this.isReady = false;
        this.send?.('chat:status', { platform: 'tiktok', connected: false });
        this.scheduleReconnect();
      });

      await this.connection.connect();
    } catch (error) {
      this.isConnecting = false;
      const message = errorMessage(error);

      if (AUTH_ERROR_PATTERN.test(message)) {
        this.handleAuthFailure(message);
        return;
      }

      if (RATE_LIMIT_PATTERN.test(message)) {
        this.reconnectDelay = RATE_LIMIT_RECONNECT_DELAY;
        console.error(
          '[TikTok] Rate Limit atingido. A próxima tentativa será feita em 5 minutos.'
        );
      } else {
        console.error(`[TikTok] Erro ao conectar em @${this.username}:`, message);
      }

      this.scheduleReconnect();
    }
  }

  async handleMessage(username, message) {
    const text = String(message || '').trim();
    if (!text) return;

    if (!this.queueManager) {
      console.warn('[TikTok] QueueManager não configurado — comando ignorado.');
      return;
    }

    if (text.startsWith('!jogar')) {
      const chessNick = text.split(/\s+/)[1];
      if (!chessNick) return;

      // join() valida o nick, evita duplicatas, aplica prioridade e atualiza
      // o painel (internamente ele chama addToQueue).
      const result = await this.queueManager.join(username, chessNick, 'tiktok');
      console.log(`[TikTok] ${result.msg}`);
      this.send?.('chat:message', { platform: 'tiktok', username, text: result.msg });
      return;
    }

    if (text === '!posicao') {
      const result = await this.queueManager.position(username);
      console.log(`[TikTok] ${result.msg}`);
      this.send?.('chat:message', { platform: 'tiktok', username, text: result.msg });
      return;
    }

    if (text === '!sair') {
      const result = await this.queueManager.leave(username);
      console.log(`[TikTok] ${result.msg}`);
      this.send?.('chat:message', { platform: 'tiktok', username, text: result.msg });
    }
  }

  handleAuthFailure(details) {
    if (this.authFailed) return;
    this.authFailed = true;

    console.error('[TikTok] Login authentication failed:', details || 'sessão inválida.');
    console.error(
      '[TikTok] O Session ID expirou ou é inválido. Reconexão automática desativada.'
    );
    console.error(
      '[TikTok] Renove o login em Configurações → Conectar conta TikTok.'
    );

    this.send?.('chat:status', {
      platform: 'tiktok',
      connected: false,
      reason: 'auth_failed',
    });

    // Impede o loop de reconexão (que causava Rate Limit na API).
    this.stopMonitoring();
  }

  scheduleReconnect() {
    if (this.authFailed || this.stopped || this.reconnectTimeout) return;

    console.log(`[TikTok] Tentando reconectar em ${this.reconnectDelay / 1000} segundos...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.authFailed || this.stopped) return;
      if (!this.connection || !this.connection.isConnected) {
        this.startMonitoring().catch((error) => {
          console.error('[TikTok] Erro ao reconectar:', errorMessage(error));
        });
      }
    }, this.reconnectDelay);
  }

  stopMonitoring() {
    this.stopped = true;
    this.isReady = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.isConnecting = false;

    if (this.connection) {
      try {
        this.connection.disconnect();
      } catch (error) {
        console.error('[TikTok] Erro ao desconectar:', errorMessage(error));
      }
      this.connection = null;
    }
  }

  disconnect() {
    this.stopMonitoring();
  }
}

module.exports = TikTokBot;
