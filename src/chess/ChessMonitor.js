const axios = require('axios');

const POLL_INTERVAL_MS = 20_000; // 20 segundos

class ChessMonitor {
  constructor(queueManager, sendToRenderer) {
    this.queue      = queueManager;
    this.send       = sendToRenderer;
    this.streamer   = (process.env.CHESS_STREAMER_NICK || '').toLowerCase();
    this.timer      = null;
    this.knownGames = new Set(); // UUIDs já processados nesta sessão
  }

  start() {
    if (!this.streamer) {
      console.warn('[Chess] CHESS_STREAMER_NICK não configurado — monitor desativado.');
      return;
    }
    console.log(`[Chess] Monitorando ${this.streamer} a cada ${POLL_INTERVAL_MS / 1000}s`);
    this.poll(); // executa imediatamente
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
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
        if (!uuid || this.knownGames.has(uuid)) continue;
        this.knownGames.add(uuid);

        // Verifica se a partida já terminou
        if (!game.end_time) continue;

        const whiteUser = game.white?.username?.toLowerCase();
        const blackUser = game.black?.username?.toLowerCase();

        const isStreamer  = whiteUser === this.streamer || blackUser === this.streamer;
        if (!isStreamer) continue;

        const opponentNick = whiteUser === this.streamer ? blackUser : whiteUser;
        const result       = this.parseResult(game, whiteUser === this.streamer);

        // Verifica se o oponente está na fila e remove
        const removed = this.queue.removeByChessNick(opponentNick);
        if (removed) {
          console.log(`[Chess] Partida encerrada contra ${opponentNick} — removido da fila.`);
          this.send('chess:game-ended', { opponent: opponentNick, result });
        }

        // Salva no histórico para evitar reprocessar
        this.queue.db?.saveGame({ uuid, opponent: opponentNick, result });
      }
    } catch (err) {
      console.error('[Chess] Erro no polling:', err.message);
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
