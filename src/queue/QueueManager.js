/**
 * QueueManager — coração do sistema
 *
 * Prioridades:
 *   1 = Ultra VIP  (convidado direto do streamer)
 *   2 = VIP Pago   (doação Pix / assinante Mercado Pago)
 *   3 = Fidelidade (membro YouTube / sub Twitch)
 *   4 = Padrão     (viewer comum via !jogar)
 */

const axios = require('axios');

const PRIORITY = {
  ULTRA_VIP:  1,
  PAID:       2,
  MEMBER:     3,
  STANDARD:   4,
};

class QueueManager {
  constructor(db, sendToRenderer) {
    this.db            = db;
    this.send          = sendToRenderer;
    this.paused        = false;
    this.currentPlayer = null;
  }

  // ── Validação do nick no Chess.com ────────────────────────────────────────
  async validateChessNick(nick) {
    try {
      const res = await axios.get(`https://api.chess.com/pub/player/${nick.toLowerCase()}`, {
        headers: { 'User-Agent': 'ChessStreamHub/1.0' },
        timeout: 5000,
      });
      return res.status === 200 ? res.data : null;
    } catch {
      return null;
    }
  }

  // ── Determina prioridade do usuário ───────────────────────────────────────
  getUserPriority(username, platform) {
    const sub = this.db.getSubscriber(username);
    if (!sub) return PRIORITY.STANDARD;

    if (sub.sub_type === 'paid')       return PRIORITY.PAID;
    if (sub.sub_type === 'twitch_sub') return PRIORITY.MEMBER;
    if (sub.sub_type === 'yt_member')  return PRIORITY.MEMBER;
    return PRIORITY.STANDARD;
  }

  // ── !jogar ────────────────────────────────────────────────────────────────
  async join(username, chessNick, platform) {
    if (this.paused) {
      return { ok: false, msg: '⏸️ A fila está pausada no momento.' };
    }

    // Verifica se já está na fila
    const queue = this.db.getQueue();
    if (queue.find(p => p.username === username)) {
      const pos = this.db.getQueuePosition(username);
      return { ok: false, msg: `Você já está na fila! Posição: #${pos}` };
    }

    // Valida nick no Chess.com
    const profile = await this.validateChessNick(chessNick);
    if (!profile) {
      return { ok: false, msg: `❌ Nick "${chessNick}" não encontrado no Chess.com.` };
    }

    const priority = this.getUserPriority(username, platform);
    this.db.addToQueue({ username, chessNick, priority, platform });

    const pos = this.db.getQueuePosition(username);
    this.broadcastQueue();

    const priorityLabel = priority <= 2 ? ' ⭐ (prioridade alta!)' : '';
    return { ok: true, msg: `✅ ${username} entrou na fila! Posição: #${pos}${priorityLabel}` };
  }

  // ── !posicao ──────────────────────────────────────────────────────────────
  position(username) {
    const pos = this.db.getQueuePosition(username);
    if (pos === 0) return { ok: false, msg: `${username}, você não está na fila. Use !jogar <nick>` };
    return { ok: true, msg: `${username}, você está na posição #${pos} da fila.` };
  }

  // ── !sair ─────────────────────────────────────────────────────────────────
  leave(username) {
    const pos = this.db.getQueuePosition(username);
    if (pos === 0) return { ok: false, msg: `${username}, você não está na fila.` };
    this.db.removeFromQueue(username);
    this.broadcastQueue();
    return { ok: true, msg: `👋 ${username} saiu da fila.` };
  }

  // ── !proximo (streamer) ───────────────────────────────────────────────────
  next() {
    const queue = this.db.getQueue();
    if (queue.length === 0) return null;

    const player = queue[0];
    this.currentPlayer = player;
    this.db.removeFromQueue(player.username);
    this.broadcastQueue();

    this.send('queue:current-player', player);
    return player;
  }

  // ── !pular (streamer) ─────────────────────────────────────────────────────
  skip() {
    if (this.currentPlayer) {
      // Move para o fim com prioridade padrão
      this.db.addToQueue({
        username:  this.currentPlayer.username,
        chessNick: this.currentPlayer.chess_nick,
        priority:  PRIORITY.STANDARD,
        platform:  this.currentPlayer.platform,
      });
    }
    return this.next();
  }

  // ── Remover manualmente ───────────────────────────────────────────────────
  remove(username) {
    this.db.removeFromQueue(username);
    this.broadcastQueue();
  }

  // ── Promover para VIP Pago (Opção B) ─────────────────────────────────────
  promote(username) {
    const queue = this.db.getQueue();
    const player = queue.find(p => p.username === username);
    if (!player) return false;

    this.db.removeFromQueue(username);
    this.db.addToQueue({
      username:  player.username,
      chessNick: player.chess_nick,
      priority:  PRIORITY.PAID,
      platform:  player.platform,
    });
    this.broadcastQueue();
    this.send('queue:vip-alert', { username, chessNick: player.chess_nick });
    return true;
  }

  // ── Reordenar via Drag & Drop ─────────────────────────────────────────────
  reorder(orderedUsernames) {
    const queue = this.db.getQueue();
    this.db.clearQueue();

    orderedUsernames.forEach((username, index) => {
      const player = queue.find(p => p.username === username);
      if (player) {
        this.db.addToQueue({
          username:  player.username,
          chessNick: player.chess_nick,
          priority:  player.priority,
          platform:  player.platform,
        });
      }
    });

    this.broadcastQueue();
  }

  // ── Remover por nick do Chess.com (após fim de partida) ───────────────────
  removeByChessNick(chessNick) {
    const queue = this.db.getQueue();
    const player = queue.find(p =>
      p.chess_nick.toLowerCase() === chessNick.toLowerCase()
    );
    if (player) {
      this.db.removeFromQueue(player.username);
      this.broadcastQueue();
      return player;
    }
    return null;
  }

  // ── Controle de pausa ─────────────────────────────────────────────────────
  setPaused(state) {
    this.paused = state;
    this.send('queue:paused', state);
    return state;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  getQueue() {
    return this.db.getQueue();
  }

  broadcastQueue() {
    this.send('queue:update', this.db.getQueue());
  }
}

module.exports = QueueManager;
module.exports.PRIORITY = PRIORITY;
