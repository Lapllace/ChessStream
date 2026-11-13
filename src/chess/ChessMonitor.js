const axios = require('axios');

const POLL_INTERVAL_MS = 20_000; // 20 segundos
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NETWORK_ERROR_CODES = [
  'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED',
];

class ChessMonitor {
  constructor(queueManager, sendToRenderer) {
    this.queue      = queueManager;
    this.send       = sendToRenderer;
    this.timer      = null;
    this.knownGames = new Set(); // UUIDs já processados nesta sessão
    this.activeGameUrl = null;   // URL da partida em andamento
    this.consecutiveErrors = 0;  // contador de falhas de rede consecutivas
  }

  start() {
    this.streamer = (process.env.CHESS_STREAMER_NICK || '').toLowerCase();
    if (!this.streamer) {
      console.warn('[Chess] CHESS_STREAMER_NICK não configurado — monitor desativado.');
      this.send?.('chat:status', { platform: 'chess', connected: false });
      return;
    }
    console.log(`[Chess] Monitorando ${this.streamer} a cada ${POLL_INTERVAL_MS / 1000}s`);
    this.poll(); // executa imediatamente
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);

    // Polling ativo: acende o status CHESS no cabeçalho.
    this.send?.('chat:status', { platform: 'chess', connected: true });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.send?.('chat:status', { platform: 'chess', connected: false });
  }

  async poll() {
    try {
      // Busca arquivo do mês atual
      const now    = new Date();
      const year   = now.getFullYear();
      const month  = String(now.getMonth() + 1).padStart(2, '0');
      const url    = `https://api.chess.com/pub/player/${this.streamer}/games/${year}/${month}`;

      const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'ChessStreamHub/1.0' },
        timeout: 8000,
      });

      const games = data.games || [];

      // Processa do mais recente para o mais antigo
      for (const game of [...games].reverse()) {
        const uuid = game.uuid;
        if (!uuid) continue;

        const whiteUser = game.white?.username?.toLowerCase();
        const blackUser = game.black?.username?.toLowerCase();
        const isStreamer = whiteUser === this.streamer || blackUser === this.streamer;
        if (!isStreamer) continue;

        // Partida em andamento: guarda a URL para checar o resultado nos
        // próximos ciclos. Não marca como conhecida para não perder o fim.
        if (!game.end_time) {
          if (game.url && this.activeGameUrl !== game.url) {
            this.activeGameUrl = game.url;
            console.log(`[Chess] Partida em andamento: ${game.url}`);
          }
          continue;
        }

        if (this.knownGames.has(uuid)) continue;
        this.knownGames.add(uuid);
        if (this.knownGames.size > 500) {
          const first = this.knownGames.values().next().value;
          this.knownGames.delete(first);
        }

        const opponentNick = whiteUser === this.streamer ? blackUser : whiteUser;
        const result       = this.parseResult(game, whiteUser === this.streamer);

        // Verifica se o oponente está na fila e remove
        const removed = await this.queue.removeByChessNick(opponentNick);
        if (removed) {
          console.log(`[Chess] Partida encerrada contra ${opponentNick} — removido da fila.`);
          this.send('chess:game-ended', { opponent: opponentNick, result });
        }

        // Salva no histórico para evitar reprocessar
        await this.queue.saveGame({
          uuid,
          opponent: opponentNick,
          result,
          playerName: this.streamer,
        });
      }

      // Se há partida em andamento, verifica se ela terminou. Roda ao final
      // do ciclo para que game:result seja o último evento a atualizar o badge.
      if (this.activeGameUrl) {
        const finished = await this.checkGameResult();
        if (finished) {
          this.send?.('game:result', {
            outcome: finished.outcome,
            gameUrl: finished.gameUrl,
          });
          this.activeGameUrl = null;
        }
      }

      this.consecutiveErrors = 0;
    } catch (err) {
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
        console.error(`[${this.constructor.name}] Erro inesperado:`, err.message);
      }
      return; // pula este ciclo
    }
  }

  async checkGameResult() {
    if (!this.activeGameUrl || !this.streamer) return null;

    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const url = `https://api.chess.com/pub/player/${this.streamer}/games/${year}/${month}`;

      const response = await fetch(url, {
        headers: { 'User-Agent': 'ChessStreamHub/1.0' },
      });
      if (!response.ok) return null;

      const data = await response.json();
      const games = data.games || [];

      // Procura a partida ativa pelo URL
      const finished = games.find((g) => g.url === this.activeGameUrl);
      // A partida só terminou quando o Chess.com preenche end_time.
      if (!finished || !finished.end_time) return null;

      const nick = this.streamer.toLowerCase();
      const isWhite = finished.white?.username?.toLowerCase() === nick;
      const myResult = isWhite ? finished.white?.result : finished.black?.result;

      let outcome;
      if (myResult === 'win') {
        outcome = 'vitoria';
      } else if (['stalemate', 'agreed', 'repetition', 'insufficient', '50move',
        'timevsinsufficient'].includes(myResult)) {
        outcome = 'empate';
      } else {
        outcome = 'derrota';
      }

      return { outcome, gameUrl: this.activeGameUrl, raw: myResult };
    } catch {
      return null; // rede oscilou — tenta no próximo ciclo
    }
  }

  parseResult(game, streamerIsWhite) {
    const white = game.white?.result;
    const black = game.black?.result;

    if (streamerIsWhite) {
      if (white === 'win')  return 'vitória';
      if (white === 'lose') return 'derrota';
      return 'empate';
    } else {
      if (black === 'win')  return 'vitória';
      if (black === 'lose') return 'derrota';
      return 'empate';
    }
  }
}

module.exports = ChessMonitor;
