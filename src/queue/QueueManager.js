/**
 * QueueManager — fila persistida no Supabase.
 *
 * A API pública mantém os nomes usados pelos bots e pelo renderer, enquanto
 * os campos persistidos seguem o esquema public.queue.
 */

const axios = require('axios');
const { supabase } = require('../main/database');

const PRIORITY = {
  ULTRA_VIP: 1,
  PAID: 2,
  MEMBER: 3,
  STANDARD: 4,
};

class QueueManager {
  constructor(sendToRenderer) {
    this.send = sendToRenderer;
    this.paused = false;
    this.currentPlayer = null;
    this.matchHistory = [];
    this.subscribers = new Map();
  }

  assertSupabase() {
    if (!supabase) {
      throw new Error('Supabase não está configurado. Verifique o arquivo .env.');
    }
  }

  parseNotes(notes) {
    if (!notes) return {};
    try {
      return JSON.parse(notes);
    } catch {
      return {};
    }
  }

  toPlayer(row) {
    const metadata = this.parseNotes(row.notes);
    return {
      ...row,
      username: row.player_name,
      chess_nick: row.chess_username,
      priority: metadata.priority || PRIORITY.STANDARD,
    };
  }

  archiveCurrentPlayer(reason = 'finished') {
    const player = this.currentPlayer;
    if (!player) return null;

    this.currentPlayer = null;
    const entry = {
      username: player.username,
      chessNick: player.chess_nick || '',
      platform: player.platform || 'chess.com',
      exitedAt: new Date().toISOString(),
      reason,
    };
    this.matchHistory.push(entry);
    return entry;
  }

  clearCurrentPlayer(reason = 'finished') {
    const player = this.currentPlayer;
    if (!player) {
      this.send('queue:current-player', null);
      return null;
    }

    this.archiveCurrentPlayer(reason);
    this.send('queue:current-player', null);
    return player;
  }

  getMatchHistory() {
    const now = new Date();
    return this.matchHistory.filter((entry) => {
      const exitedAt = new Date(entry.exitedAt);
      return exitedAt.getFullYear() === now.getFullYear()
        && exitedAt.getMonth() === now.getMonth()
        && exitedAt.getDate() === now.getDate();
    });
  }

  async getQueue() {
    this.assertSupabase();
    const { data, error } = await supabase
      .from('queue')
      .select('*')
      .in('status', ['pending', 'playing'])
      .order('position', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[Supabase] Erro ao buscar fila:', error.message);
      throw error;
    }
    return (data || []).map((row) => this.toPlayer(row));
  }

  async getQueuePosition(username) {
    const queue = await this.getQueue();
    return queue.findIndex((player) => player.username === username) + 1;
  }

  async position(username) {
    const position = await this.getQueuePosition(username);
    if (position === 0) {
      return { ok: false, msg: `${username}, você não está na fila. Use !jogar <nick>` };
    }
    return { ok: true, msg: `${username}, você está na posição #${position} da fila.` };
  }

  async nextPosition() {
    const { data, error } = await supabase
      .from('queue')
      .select('position')
      .eq('status', 'pending')
      .order('position', { ascending: false, nullsFirst: false })
      .limit(1);

    if (error) throw error;
    return (data?.[0]?.position || 0) + 1;
  }

  async addToQueue({ username, chessNick, priority, platform }) {
    this.assertSupabase();
    const { data, error } = await supabase
      .from('queue')
      .insert({
        player_name: username,
        chess_username: chessNick || null,
        platform: platform || 'chess.com',
        status: 'pending',
        position: await this.nextPosition(),
        notes: JSON.stringify({ priority: priority || PRIORITY.STANDARD }),
      })
      .select()
      .single();

    if (error) {
      console.error('[Supabase] Erro ao adicionar à fila:', error.message);
      throw error;
    }
    return this.toPlayer(data);
  }

  normalizeUsername(username) {
    return String(username || '')
      .trim()
      .replace(/^@+/, '')
      .toLowerCase();
  }

  async join(username, chessNick, platform) {
    if (this.paused) {
      return { ok: false, msg: '⏸️ A fila está pausada no momento.' };
    }

    const queue = await this.getQueue();
    const normalizedUsername = this.normalizeUsername(username);
    const existing = queue.find(
      (player) => this.normalizeUsername(player.username) === normalizedUsername
    );
    if (existing) {
      return { ok: false, msg: 'Você já está na fila!' };
    }

    const profile = await this.validateChessNick(chessNick);
    if (!profile) {
      return { ok: false, msg: `❌ Nick "${chessNick}" não encontrado no Chess.com.` };
    }

    const priority = this.getUserPriority(username);
    await this.addToQueue({ username, chessNick, priority, platform });
    const position = await this.getQueuePosition(username);
    await this.broadcastQueue();

    const priorityLabel = priority <= 2 ? ' ⭐ (prioridade alta!)' : '';
    return {
      ok: true,
      msg: `✅ ${username} entrou na fila! Posição: #${position}${priorityLabel}`,
    };
  }

  async validateChessNick(nick) {
    try {
      const response = await axios.get(
        `https://api.chess.com/pub/player/${encodeURIComponent(nick.toLowerCase())}`,
        { headers: { 'User-Agent': 'ChessStreamHub/1.0' }, timeout: 5000 }
      );
      return response.status === 200 ? response.data : null;
    } catch {
      return null;
    }
  }

  getUserPriority(username) {
    return this.subscribers.get(username)?.subType === 'paid'
      ? PRIORITY.PAID
      : this.subscribers.get(username)
        ? PRIORITY.MEMBER
        : PRIORITY.STANDARD;
  }

  upsertSubscriber({ username, chessNick, platform, subType, expiresAt }) {
    this.subscribers.set(username, { chessNick, platform, subType, expiresAt });
  }

  async getSubscriber(username) {
    return this.subscribers.get(username) || null;
  }

  async removeFromQueue(username, reason = 'removed') {
    this.assertSupabase();
    const { error } = await supabase
      .from('queue')
      .delete()
      .eq('player_name', username)
      .in('status', ['pending', 'playing']);
    if (error) throw error;

    // Se quem saiu da fila era o jogador em "Jogando Agora", registra no
    // histórico e limpa o painel.
    if (this.currentPlayer?.username === username) {
      this.clearCurrentPlayer(reason);
    }

    await this.broadcastQueue();
  }

  async leave(username) {
    const position = await this.getQueuePosition(username);
    if (position === 0) {
      return { ok: false, msg: `${username}, você não está na fila.` };
    }
    await this.removeFromQueue(username);
    return { ok: true, msg: `👋 ${username} saiu da fila.` };
  }

  async next() {
    this.assertSupabase();
    const { data, error } = await supabase
      .from('queue')
      .select('*')
      .eq('status', 'pending')
      .order('position', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    if (error?.code === 'PGRST116') {
      // Fila vazia: o jogador atual sai de "Jogando Agora", vai para o
      // histórico e o painel volta a exibir "Nenhum desafiante ativo".
      if (this.currentPlayer) {
        try {
          await this.updatePlayer(this.currentPlayer.id, { status: 'completed' });
        } catch (updateError) {
          console.warn('[Fila] Não foi possível finalizar o jogador atual:', updateError?.message || updateError);
        }
        this.archiveCurrentPlayer('queue-empty');
      }
      this.send('queue:current-player', null);
      await this.broadcastQueue();
      return null;
    }
    if (error) throw error;

    // Já havia alguém em "Jogando Agora": encerra e registra no histórico
    // antes de promover o próximo da fila.
    if (this.currentPlayer) {
      try {
        await this.updatePlayer(this.currentPlayer.id, { status: 'completed' });
      } catch (updateError) {
        console.warn('[Fila] Não foi possível finalizar o jogador atual:', updateError?.message || updateError);
      }
      this.archiveCurrentPlayer('next');
    }

    const { data: updated, error: updateError } = await supabase
      .from('queue')
      .update({ status: 'playing' })
      .eq('id', data.id)
      .select()
      .single();
    if (updateError) throw updateError;

    this.currentPlayer = this.toPlayer(updated);
    await this.broadcastQueue();
    this.send('queue:current-player', this.currentPlayer);
    return this.currentPlayer;
  }

  async skip() {
    if (this.currentPlayer) {
      await this.updatePlayer(this.currentPlayer.id, {
        status: 'pending',
        position: await this.nextPosition(),
        notes: JSON.stringify({ priority: PRIORITY.STANDARD }),
      });
      // O jogador voltou para o fim da fila; registra a saída do palco.
      this.archiveCurrentPlayer('skipped');
    }
    return this.next();
  }

  async updatePlayer(id, changes) {
    this.assertSupabase();
    const { data, error } = await supabase
      .from('queue')
      .update(changes)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return this.toPlayer(data);
  }

  async promote(username) {
    const queue = await this.getQueue();
    const player = queue.find((item) => item.username === username);
    if (!player) return false;

    await this.updatePlayer(player.id, {
      notes: JSON.stringify({ priority: PRIORITY.PAID }),
    });
    await this.broadcastQueue();
    this.send('queue:vip-alert', { username, chessNick: player.chess_nick });
    return true;
  }

  async remove(username) {
    await this.removeFromQueue(username);
  }

  async reorder(orderedUsernames) {
    const queue = await this.getQueue();
    await Promise.all(orderedUsernames.map(async (username, index) => {
      const player = queue.find((item) => item.username === username);
      if (player) await this.updatePlayer(player.id, { position: index + 1 });
    }));
    await this.broadcastQueue();
  }

  async removeByChessNick(chessNick) {
    const queue = await this.getQueue();
    const player = queue.find((item) =>
      item.chess_nick?.toLowerCase() === chessNick?.toLowerCase()
    );

    if (!player) {
      // A linha pode já ter saído da fila, mas o jogador ainda estar no
      // painel "Jogando Agora". Nesse caso, limpa o painel mesmo assim.
      if (this.currentPlayer?.chess_nick?.toLowerCase() === chessNick?.toLowerCase()) {
        this.clearCurrentPlayer('match-ended');
        await this.broadcastQueue();
      }
      return null;
    }

    await this.removeFromQueue(player.username, 'match-ended');
    return player;
  }

  async recordMatch(queueId, playerName, opponentName, result, gameUrl = '') {
    this.assertSupabase();
    const resultMap = { vitória: 'win', derrota: 'loss', empate: 'draw' };
    const { error } = await supabase.from('match_history').insert({
      queue_id: queueId || null,
      player_name: playerName,
      opponent_name: opponentName,
      result: resultMap[result] || result || 'ongoing',
      game_url: gameUrl || null,
    });
    if (error) {
      console.error('[Supabase] Erro ao registrar partida:', error.message);
      throw error;
    }
  }

  async saveGame({ uuid, opponent, result, playerName = '' }) {
    return this.recordMatch(null, playerName || 'unknown', opponent, result, uuid);
  }

  setPaused(state) {
    this.paused = state;
    this.send('queue:paused', state);
    return state;
  }

  async broadcastQueue() {
    this.send('queue:update', await this.getQueue());
  }
}

module.exports = QueueManager;
module.exports.PRIORITY = PRIORITY;
