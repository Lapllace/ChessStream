const { google } = require('googleapis');

const POLL_INTERVAL_MS = 15000;
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NETWORK_ERROR_CODES = [
  'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED',
];

function errorMessage(error) {
  return error?.response?.data?.error?.message
    || error?.message
    || String(error);
}

class YouTubeBot {
  constructor(queueManager, sendToRenderer, oauth2Client = null) {
    this.queue      = queueManager;
    this.send       = sendToRenderer;
    this.oauth2Client = oauth2Client;
    this.youtube    = null;
    this.channelId  = process.env.YOUTUBE_CHANNEL_ID;
    this.liveChatId = process.env.YOUTUBE_LIVE_CHAT_ID;
    this.pageToken  = null;
    this.timer      = null;
    this.polling    = false;
    this.startTime  = 0;
    this.consecutiveErrors = 0;
  }

  async connect() {
    if (!this.oauth2Client) {
      console.warn('[YouTube] Login Google não configurado — bot desativado.');
      return;
    }

    // Evita dois intervalos de polling se connect() for chamado novamente.
    this.disconnect();
    this.youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });

    // Se não tiver o liveChatId no .env, tenta descobrir automaticamente
    if (!this.liveChatId) {
      await this.discoverLiveChatId();
    }

    if (!this.liveChatId) {
      console.warn('[YouTube] Nenhuma live ativa encontrada.');
      return;
    }

    // Valida o recurso antes de começar: liveChatMessages é o nome correto
    // na YouTube Data API v3 (não existe youtube.liveChat.messages).
    if (typeof this.youtube?.liveChatMessages?.list !== 'function') {
      console.error(
        '[YouTube] Recurso liveChatMessages indisponível no cliente googleapis. '
        + 'Verifique a versão da biblioteca.'
      );
      return;
    }

    // Marca o início desta conexão. Mensagens publicadas antes deste momento
    // são histórico da live e não devem ser reprocessadas após um restart.
    this.startTime = Date.now();

    console.log(`[YouTube] Monitorando chat: ${this.liveChatId}`);
    this.send('chat:status', { platform: 'youtube', connected: true });
    this.poll().catch((error) => {
      console.error('[YouTube] Erro inesperado no primeiro poll:', errorMessage(error));
    });
    this.timer = setInterval(() => {
      this.poll().catch((error) => {
        console.error('[YouTube] Erro inesperado no ciclo de polling:', errorMessage(error));
      });
    }, POLL_INTERVAL_MS);
  }

  disconnect() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async discoverLiveChatId() {
    try {
      const { data } = await this.youtube.liveBroadcasts.list({
        part: ['snippet'],
        broadcastStatus: 'active',
      });

      const broadcast = data?.items?.[0];
      if (broadcast?.snippet?.liveChatId) {
        this.liveChatId = broadcast.snippet.liveChatId;
        console.log(`[YouTube] Live encontrada: ${this.liveChatId}`);
      }
    } catch (err) {
      console.error('[YouTube] Erro ao buscar live:', errorMessage(err));
    }
  }

  async poll() {
    if (!this.liveChatId || !this.youtube) return;

    // Impede ciclos sobrepostos quando uma resposta demora mais que o intervalo.
    if (this.polling) return;
    this.polling = true;

    try {
      const params = {
        part: ['snippet', 'authorDetails'],
        liveChatId: this.liveChatId,
        maxResults: 200,
      };
      if (this.pageToken) params.pageToken = this.pageToken;

      // API oficial do YouTube Data v3: youtube.liveChatMessages.list
      const response = await this.youtube.liveChatMessages.list(params);
      const data = response?.data;

      // Validação defensiva da resposta antes de iterar.
      if (!data || !Array.isArray(data.items)) {
        console.warn(
          '[YouTube] Resposta inesperada da API de chat:',
          data ? Object.keys(data) : data
        );
        return;
      }

      // Se a API não devolver nextPageToken, mantém o anterior para não
      // reprocessar o histórico inteiro.
      if (data.nextPageToken) {
        this.pageToken = data.nextPageToken;
      }

      for (const item of data.items) {
        const text     = item?.snippet?.displayMessage?.trim();
        const username = item?.authorDetails?.displayName;
        const isMember = item?.authorDetails?.isChatSponsor;

        if (!text || !username) continue;

        // Ignora mensagens anteriores ao início desta conexão. Sem isto, o
        // primeiro poll após reiniciar o app reprocessa o histórico da live.
        const publishedAt = item?.snippet?.publishedAt;
        const publishedAtMs = publishedAt ? new Date(publishedAt).getTime() : NaN;
        if (Number.isFinite(publishedAtMs) && publishedAtMs < this.startTime) continue;

        // Detecta membership YouTube
        if (isMember) {
          this.queue.upsertSubscriber({
            username,
            platform: 'youtube',
            subType:  'yt_member',
          });
        }

        try {
          await this.handleMessage(username, text, isMember);
        } catch (messageError) {
          // Uma mensagem inválida não pode interromper o resto do lote.
          console.error(
            '[YouTube] Erro ao processar mensagem de',
            username,
            '—',
            errorMessage(messageError)
          );
        }
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      const status = err?.response?.status;
      const reason = err?.response?.data?.error?.errors?.[0]?.reason
        || err?.errors?.[0]?.reason
        || '';
      const message = errorMessage(err);

      if (status === 403 || /quotaExceeded|liveChatEnded|liveChatNotFound/i.test(reason)) {
        console.error('[YouTube] Quota excedida ou live encerrada. Polling interrompido.');
        this.disconnect();
        this.send('chat:status', { platform: 'youtube', connected: false });
      } else {
        const isNetworkError = NETWORK_ERROR_CODES.some(
          (code) => err.code === code
            || err.cause?.code === code
            || err.message?.includes(code)
        );

        if (isNetworkError) {
          this.consecutiveErrors = (this.consecutiveErrors || 0) + 1;
          // Backoff exponencial: 5s, 10s, 20s, 40s, máximo 60s
          const backoff = Math.min(5000 * Math.pow(2, this.consecutiveErrors - 1), 60000);
          console.warn(
            `[${this.constructor.name}] Rede indisponível (tentativa ${this.consecutiveErrors}). `
            + `Aguardando ${backoff / 1000}s...`
          );
          await sleepMs(backoff);
        } else {
          // Erro de lógica — esse sim vale logar
          console.error(`[${this.constructor.name}] Erro inesperado:`, message);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async handleMessage(username, message, isMember) {
    if (message.startsWith('!jogar ')) {
      const chessNick = message.split(' ')[1];
      if (!chessNick) return;
      const result = await this.queue.join(username, chessNick, 'youtube');
      await this.say(`@${username} ${result.msg}`);
      this.send('chat:message', { platform: 'youtube', username, text: result.msg });
    }

    else if (message === '!posicao') {
      const result = await this.queue.position(username);
      await this.say(`@${username} ${result.msg}`);
      this.send('chat:message', { platform: 'youtube', username, text: result.msg });
    }

    else if (message === '!sair') {
      const result = await this.queue.leave(username);
      await this.say(`@${username} ${result.msg}`);
      this.send('chat:message', { platform: 'youtube', username, text: result.msg });
    }

    else if (message === '!fila') {
      try {
        const queue = await this.queue.getQueue();
        const count = queue.length;
        if (count === 0) {
          await this.say('📋 A fila está vazia. Use !jogar <nick> para entrar!');
        } else {
          const next = queue[0];
          await this.say(
            `📋 Fila: ${count} jogador(es). Próximo: @${next.username} · Use !posicao`
          );
        }
      } catch {
        await this.say('📋 Não foi possível consultar a fila agora.');
      }
    }

    else if (message === '!ajuda' || message === '!help') {
      await this.say(
        '♟ Comandos: !jogar <nick> · !posicao · !sair · !fila'
      );
    }
  }

  async say(message) {
    if (!this.youtube || !this.liveChatId) return;
    try {
      await this.youtube.liveChatMessages.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            liveChatId: this.liveChatId,
            type: 'textMessageEvent',
            textMessageDetails: { messageText: message },
          },
        },
      });
    } catch (err) {
      // Quota ou live encerrada: não sujar o log com erro repetido
      const status = err?.response?.status;
      if (status === 403) {
        console.warn('[YouTube] Quota excedida ou sem permissão para enviar mensagem.');
      } else {
        console.error('[YouTube] Erro ao enviar mensagem:', errorMessage(err));
      }
    }
  }
}

module.exports = YouTubeBot;
