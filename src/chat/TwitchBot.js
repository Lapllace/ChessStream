const tmi = require('tmi.js');

const AUTH_ERROR_PATTERN = /login authentication failed|authentication failed|invalid (oauth )?token|improperly formatted auth/i;

function cleanCredential(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return '';
  return trimmed;
}

function errorMessage(error) {
  return String(
    error?.exception?.message
    || error?.message
    || error?.error
    || error?.info
    || error
    || 'erro desconhecido'
  );
}

function sanitizeTwitchToken(rawToken) {
  const raw = cleanCredential(rawToken)
    // Remove espaços invisíveis e caracteres de controle que quebram o login.
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/\s+/g, '');
  if (!raw) return '';

  // Remove qualquer prefixo "oauth:" (inclusive duplicado) e adiciona
  // exatamente um, evitando tanto "oauth:oauth:..." quanto token sem prefixo.
  const tokenValue = raw.replace(/^(?:oauth:)+/i, '');
  return tokenValue ? `oauth:${tokenValue}` : '';
}

function getStoredTwitchToken() {
  try {
    // Require tardio: evita inicializar o electron-store fora do processo
    // principal (por exemplo, em testes de sintaxe ou ferramentas).
    const { getSettings } = require('../main/settings');
    return getSettings()?.twitchOAuthToken || '';
  } catch {
    return '';
  }
}

function describeTwitchError(error, secret = '') {
  const redact = (value) => {
    const text = String(value ?? '');
    return secret ? text.split(secret).join('[token-redacted]') : text;
  };

  const details = {
    name: error?.name,
    message: redact(errorMessage(error)),
    code: error?.code || error?.errno,
    status: error?.response?.status || error?.status,
    cause: redact(error?.cause?.message),
  };

  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(' | ');
}

class TwitchBot {
  constructor(queueManager, sendToRenderer) {
    this.queue  = queueManager;
    this.send   = sendToRenderer;
    this.client = null;
    this.connecting = false;
    this.authFailed = false;

    this.channel  = cleanCredential(process.env.TWITCH_CHANNEL).replace(/^#/, '');
    this.token    = sanitizeTwitchToken(
      process.env.TWITCH_OAUTH_TOKEN || getStoredTwitchToken()
    );
    this.username = cleanCredential(process.env.TWITCH_USERNAME) || this.channel;
  }

  async connect() {
    if (this.connecting || this.client) return;

    const token = sanitizeTwitchToken(
      this.token || process.env.TWITCH_OAUTH_TOKEN || getStoredTwitchToken()
    );
    const channel = cleanCredential(this.channel || process.env.TWITCH_CHANNEL).replace(/^#/, '');
    const username = cleanCredential(process.env.TWITCH_USERNAME) || channel;

    // Verificação defensiva: sem credenciais válidas, aborta silenciosamente.
    if (!token || !channel) {
      console.log('[Twitch] Credenciais ausentes, bot não iniciado.');
      this.send('chat:status', { platform: 'twitch', connected: false });
      return;
    }

    // sanitizeTwitchToken() garante exatamente um prefixo "oauth:".
    const tokenValue = token.replace(/^oauth:/i, '');
    if (!tokenValue || tokenValue.length < 20 || /undefined|null/i.test(tokenValue)) {
      console.warn(
        '[Twitch] Token OAuth inválido. '
        + `prefixo=${token.slice(0, 6) || '(vazio)'} tamanho=${token.length} `
        + '— renove o login da Twitch pela interface.'
      );
      this.send('chat:status', { platform: 'twitch', connected: false });
      return;
    }

    this.token = token;
    this.channel = channel;
    this.username = username;
    this.authFailed = false;
    this.connecting = true;

    this.client = new tmi.Client({
      options:  { debug: false },
      connection: { reconnect: true, secure: true },
      identity: { username: this.username, password: this.token },
      channels: [this.channel],
    });

    this.client.on('message', (channelName, tags, message, self) => {
      if (self) return;
      this.handleMessage(channelName, tags, message.trim())
        .catch((error) => console.error('[Twitch] Erro ao processar mensagem:', error));
    });

    this.client.on('connected', () => {
      this.authFailed = false;
      console.log(`[Twitch] Conectado ao canal #${this.channel}`);
      this.send('chat:status', { platform: 'twitch', connected: true });
    });

    this.client.on('disconnected', () => {
      this.send('chat:status', { platform: 'twitch', connected: false });
    });

    // O tmi.js avisa falhas de login por 'notice', não por 'error'.
    this.client.on('notice', (channelName, msgId, message) => {
      if (msgId === 'login_authentication_failed' || AUTH_ERROR_PATTERN.test(String(message))) {
        this.handleAuthFailure(message);
      }
    });

    this.client.on('error', (error) => {
      const message = errorMessage(error);
      if (AUTH_ERROR_PATTERN.test(message)) {
        this.handleAuthFailure(message);
      } else {
        console.error('[Twitch] Aviso de conexão:', describeTwitchError(error, tokenValue));
      }
    });

    try {
      await this.client.connect();
    } catch (error) {
      const message = errorMessage(error);
      console.error(
        '[Twitch] Falha ao conectar:',
        describeTwitchError(error, tokenValue)
      );
      console.error(
        '[Twitch] Diagnóstico (sem expor o token):',
        `usuario=${this.username || '(vazio)'}`,
        `canal=${this.channel || '(vazio)'}`,
        `prefixoToken=${token.slice(0, 6) || '(vazio)'}`,
        `tamanhoToken=${token.length}`
      );

      if (AUTH_ERROR_PATTERN.test(message)) {
        this.handleAuthFailure(message);
      } else {
        this.send('chat:status', { platform: 'twitch', connected: false });
        this.client = null;
      }
    } finally {
      this.connecting = false;
    }
  }

  handleAuthFailure(details) {
    this.authFailed = true;
    const tokenValue = sanitizeTwitchToken(this.token).replace(/^oauth:/i, '');
    const safeDetails = tokenValue
      ? String(details || '').split(tokenValue).join('[token-redacted]')
      : String(details || '');
    console.error('[Twitch] Autenticação falhou:', safeDetails || 'credenciais inválidas.');
    console.error(
      '[Twitch] Renove o login da Twitch pela interface (Configurações → Login Twitch).'
    );
    this.send('chat:status', { platform: 'twitch', connected: false });

    const client = this.client;
    this.client = null;
    if (!client) return;

    // O tmi.js pode rejeitar disconnect() quando o socket já caiu; isso não
    // pode virar "unhandledRejection" no log.
    Promise.resolve()
      .then(() => client.disconnect())
      .catch((error) => {
        const message = errorMessage(error);
        if (/not opened|already closing/i.test(message)) return;
        console.error('[Twitch] Erro ao desconectar após falha de autenticação:', message);
      });
  }

  async disconnect() {
    const client = this.client;
    this.client = null;
    if (!client) return;

    try {
      await client.disconnect();
    } catch (error) {
      const message = errorMessage(error);
      // Socket já fechado pela Twitch: não sujar o log com um erro fantasma.
      if (/not opened|already closing/i.test(message)) return;
      console.error('[Twitch] Erro ao desconectar:', message);
    }
  }

  async handleMessage(channel, tags, message) {
    const username = tags['display-name'] || tags.username;
    // Detecta membership Twitch (sub) para prioridade automática
    if (tags.subscriber) {
      this.queue.upsertSubscriber({
        username,
        platform: 'twitch',
        subType: 'twitch_sub',
      });
    }

    // ── Comandos de viewer ───────────────────────────────────────────────────
    if (message.startsWith('!jogar ')) {
      const chessNick = message.split(' ')[1];
      if (!chessNick) {
        this.say(channel, `@${username}, use: !jogar <seu_nick_no_chess.com>`);
        return;
      }
      const result = await this.queue.join(username, chessNick, 'twitch');
      this.say(channel, `@${username} ${result.msg}`);
    }

    else if (message === '!posicao') {
      const result = await this.queue.position(username);
      this.say(channel, `@${username} ${result.msg}`);
    }

    else if (message === '!sair') {
      const result = await this.queue.leave(username);
      this.say(channel, `@${username} ${result.msg}`);
    }

    else if (message === '!fila') {
      try {
        const queue = await this.queue.getQueue();
        const count = queue.length;
        if (count === 0) {
          this.say(channel, '📋 A fila está vazia. Use !jogar <nick> para entrar!');
        } else {
          const next = queue[0];
          this.say(channel,
            `📋 Fila: ${count} jogador(es). Próximo: @${next.username} (${next.chess_nick}). `
            + 'Use !posicao para ver sua posição.'
          );
        }
      } catch {
        this.say(channel, '📋 Não foi possível consultar a fila agora.');
      }
    }

    else if (message === '!ajuda' || message === '!help' || message === '!comandos') {
      this.say(channel,
        '♟ Comandos: !jogar <nick> (entrar na fila) · '
        + '!posicao (ver sua posição) · '
        + '!sair (sair da fila) · '
        + '!fila (ver quantos estão na fila)'
      );
    }

    // ── Comandos de streamer/moderador ───────────────────────────────────────
    const isMod = tags.mod || tags.badges?.broadcaster;
    if (!isMod) return;

    if (message === '!proximo') {
      const player = await this.queue.next();
      if (player) {
        this.say(channel, `🎯 Próximo desafiante: @${player.username} (${player.chess_nick})! Aceite o desafio no Chess.com!`);
      } else {
        this.say(channel, 'A fila está vazia!');
      }
    }

    else if (message === '!pular') {
      const player = await this.queue.skip();
      if (player) {
        this.say(channel, `⏭️ Próximo: @${player.username} (${player.chess_nick})`);
      }
    }

    else if (message === '!fila pausar') {
      this.queue.setPaused(true);
      this.say(channel, '⏸️ Fila pausada. Nenhum novo desafiante será aceito.');
    }

    else if (message === '!fila retomar') {
      this.queue.setPaused(false);
      this.say(channel, '▶️ Fila reaberta! Use !jogar <nick> para entrar.');
    }
  }

  say(channel, message) {
    try {
      this.client?.say(channel, message);
    } catch (err) {
      console.error('[Twitch] Erro ao enviar mensagem:', err.message);
    }
  }
}

module.exports = TwitchBot;
// Reutilizado pelo fluxo OAuth do processo principal para garantir exatamente
// um prefixo "oauth:" no token retornado pela Twitch.
module.exports.sanitizeTwitchToken = sanitizeTwitchToken;
