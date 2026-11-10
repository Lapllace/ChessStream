const tmi = require('tmi.js');

class TwitchBot {
  constructor(queueManager, sendToRenderer) {
    this.queue  = queueManager;
    this.send   = sendToRenderer;
    this.client = null;

    this.channel = process.env.TWITCH_CHANNEL;
    this.username = process.env.TWITCH_USERNAME;
    this.token    = process.env.TWITCH_OAUTH_TOKEN;
  }

  async connect() {
    if (!this.token || !this.channel) {
      console.warn('[Twitch] Credenciais não configuradas — bot desativado.');
      return;
    }

    this.client = new tmi.Client({
      options:  { debug: false },
      identity: { username: this.username, password: this.token },
      channels: [this.channel],
    });

    this.client.on('message', (channel, tags, message, self) => {
      if (self) return;
      this.handleMessage(channel, tags, message.trim());
    });

    this.client.on('connected', () => {
      console.log(`[Twitch] Conectado ao canal #${this.channel}`);
      this.send('chat:status', { platform: 'twitch', connected: true });
    });

    this.client.on('disconnected', () => {
      this.send('chat:status', { platform: 'twitch', connected: false });
    });

    await this.client.connect();
  }

  disconnect() {
    this.client?.disconnect();
  }

  async handleMessage(channel, tags, message) {
    const username = tags['display-name'] || tags.username;
    const isSubOrVip = tags.subscriber || tags['user-type'] === 'mod';

    // Detecta membership Twitch (sub) para prioridade automática
    if (tags.subscriber) {
      this.queue.db?.upsertSubscriber({
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
      const result = this.queue.position(username);
      this.say(channel, `@${username} ${result.msg}`);
    }

    else if (message === '!sair') {
      const result = this.queue.leave(username);
      this.say(channel, `@${username} ${result.msg}`);
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
      const player = this.queue.skip();
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
