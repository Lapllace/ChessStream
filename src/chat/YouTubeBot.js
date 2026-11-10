const axios = require('axios');

const POLL_INTERVAL_MS = 5000;

class YouTubeBot {
  constructor(queueManager, sendToRenderer) {
    this.queue      = queueManager;
    this.send       = sendToRenderer;
    this.apiKey     = process.env.YOUTUBE_API_KEY;
    this.channelId  = process.env.YOUTUBE_CHANNEL_ID;
    this.liveChatId = process.env.YOUTUBE_LIVE_CHAT_ID;
    this.pageToken  = null;
    this.timer      = null;
  }

  async connect() {
    if (!this.apiKey) {
      console.warn('[YouTube] API Key não configurada — bot desativado.');
      return;
    }

    // Se não tiver o liveChatId no .env, tenta descobrir automaticamente
    if (!this.liveChatId) {
      await this.discoverLiveChatId();
    }

    if (!this.liveChatId) {
      console.warn('[YouTube] Nenhuma live ativa encontrada.');
      return;
    }

    console.log(`[YouTube] Monitorando chat: ${this.liveChatId}`);
    this.send('chat:status', { platform: 'youtube', connected: true });
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  disconnect() {
    if (this.timer) clearInterval(this.timer);
  }

  async discoverLiveChatId() {
    try {
      const { data } = await axios.get('https://www.googleapis.com/youtube/v3/liveBroadcasts', {
        params: {
          part:        'snippet',
          broadcastStatus: 'active',
          key:         this.apiKey,
        },
      });

      const broadcast = data.items?.[0];
      if (broadcast) {
        this.liveChatId = broadcast.snippet.liveChatId;
        console.log(`[YouTube] Live encontrada: ${this.liveChatId}`);
      }
    } catch (err) {
      console.error('[YouTube] Erro ao buscar live:', err.message);
    }
  }

  async poll() {
    if (!this.liveChatId) return;

    try {
      const params = {
        part:       'snippet,authorDetails',
        liveChatId: this.liveChatId,
        key:        this.apiKey,
      };
      if (this.pageToken) params.pageToken = this.pageToken;

      const { data } = await axios.get(
        'https://www.googleapis.com/youtube/v3/liveChat/messages',
        { params }
      );

      this.pageToken = data.nextPageToken;

      for (const item of data.items || []) {
        const text     = item.snippet?.displayMessage?.trim();
        const username = item.authorDetails?.displayName;
        const isMember = item.authorDetails?.isChatSponsor;

        if (!text || !username) continue;

        // Detecta membership YouTube
        if (isMember) {
          this.queue.upsertSubscriber({
            username,
            platform: 'youtube',
            subType:  'yt_member',
          });
        }

        await this.handleMessage(username, text, isMember);
      }
    } catch (err) {
      if (err.response?.status === 403) {
        console.error('[YouTube] Quota excedida ou live encerrada.');
        clearInterval(this.timer);
        this.send('chat:status', { platform: 'youtube', connected: false });
      } else {
        console.error('[YouTube] Erro no polling:', err.message);
      }
    }
  }

  async handleMessage(username, message, isMember) {
    if (message.startsWith('!jogar ')) {
      const chessNick = message.split(' ')[1];
      if (!chessNick) return;
      const result = await this.queue.join(username, chessNick, 'youtube');
      // YouTube não tem API de envio de mensagem fácil, loga para o painel
      console.log(`[YouTube] ${result.msg}`);
      this.send('chat:message', { platform: 'youtube', username, text: result.msg });
    }

    else if (message === '!posicao') {
      const result = await this.queue.position(username);
      this.send('chat:message', { platform: 'youtube', username, text: result.msg });
    }

    else if (message === '!sair') {
      const result = await this.queue.leave(username);
      this.send('chat:message', { platform: 'youtube', username, text: result.msg });
    }
  }
}

module.exports = YouTubeBot;
