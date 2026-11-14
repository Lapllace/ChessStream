/**
 * QueueManager — fila persistida no Supabase.
 *
 * A API pública mantém os nomes usados pelos bots e pelo renderer, enquanto
 * os campos persistidos seguem o esquema public.queue.
 */

const axios = require('axios');
const { randomUUID } = require('crypto');
const { getSupabaseClient } = require('../main/database');

const PRIORITY = {
  ULTRA_VIP: 1,
  PAID: 2,
  MEMBER: 3,
  STANDARD: 4,
};

class QueueManager {
  constructor(sendToRenderer, getStreamerId = () => '') {
    this.send = sendToRenderer;
    // Função (não valor): o streamer_id é gerado/alterado enquanto o app roda.
    this.getStreamerId = typeof getStreamerId === 'function' ? getStreamerId : () => '';
    this.paused = false;
    this.currentPlayer = null;
    this.matchHistory = [];
    this.subscribers = new Map();
    this.warnedMissingQueueRpc = false;
  }

  /**
   * Sempre resolve a instância atual: o usuário pode trocar URL/chave nas
   * configurações e o cliente anterior é descartado por reconnectSupabase().
   */
  get supabase() {
    return getSupabaseClient();
  }

  /** Identificador da instalação; vazio = modo legado (uma única fila). */
  get streamerId() {
    try {
      return String(this.getStreamerId() || '').trim();
    } catch {
      return '';
    }
  }

  /**
   * Isola as consultas da fila por streamer. Sem streamer_id configurado o
   * comportamento antigo (fila global) é preservado para não quebrar
   * instalações que ainda não ativaram o LivePix.
   */
  scopeToStreamer(query) {
    const id = this.streamerId;
    return id ? query.eq('streamer_id', id) : query;
  }

  assertSupabase() {
    if (!this.supabase) {
      throw new Error('Supabase não está configurado. Verifique o arquivo .env.');
    }
  }

  /**
   * RPC ausente = Supabase próprio rodando um schema anterior ao multi-tenant.
   * Códigos: PGRST202 (PostgREST não encontra a função) e 42883 (Postgres).
   */
  isMissingRpc(error) {
    if (!error) return false;
    const code = String(error.code || '');
    if (code === 'PGRST202' || code === '42883') return true;
    return /could not find the function|function .* does not exist/i
      .test(String(error.message || ''));
  }

  /** Schema próprio antigo, sem a coluna streamer_id. */
  isUnknownStreamerColumn(error) {
    if (!error) return false;
    const code = String(error.code || '');
    if (code !== '42703' && code !== 'PGRST204') return false;
    return /streamer_id/i.test(String(error.message || ''));
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
      priority: this.normalizePriority(metadata.priority),
    };
  }

  /**
   * O webhook do LivePix grava priority: 'vip' (texto) e o app usa a escala
   * numérica 1..4. Converte ambos para o mesmo valor interno.
   */
  normalizePriority(value) {
    if (value === 'vip') return PRIORITY.PAID;

    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric >= PRIORITY.ULTRA_VIP && numeric <= PRIORITY.STANDARD) {
      return numeric;
    }

    return PRIORITY.STANDARD;
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
      outcome: player.outcome || null,
    };
    this.matchHistory.push(entry);
    return entry;
  }

  /**
   * Registra o desfecho de uma partida encerrada no Chess.com para o jogador
   * que está no palco. O palco é esvaziado automaticamente e o resultado fica
   * anexado à entrada arquivada no histórico da sessão.
   *
   * @param {string} chessNick nick do oponente que estava jogando
   * @param {'Vitória'|'Derrota'|'Empate'} outcome
   */
  async registerMatchEnd(chessNick, outcome) {
    const target = this.normalizeUsername(chessNick);
    const current = this.currentPlayer;
    if (!current || !target) return false;

    const currentNick = this.normalizeUsername(current.chess_nick);
    if (!currentNick || currentNick !== target) return false;

    // O outcome é copiado para o histórico por archiveCurrentPlayer().
    current.outcome = outcome;
    this.clearCurrentPlayer('match-ended');
    await this.broadcastQueue();

    console.log(`[Fila] Partida encerrada: ${current.username} — ${outcome}.`);
    return true;
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
    const streamerId = this.streamerId;

    // Caminho SaaS: o SELECT direto está bloqueado por RLS, então a fila é
    // lida pela RPC, que devolve exclusivamente as linhas deste streamer.
    if (streamerId) {
      const { data, error } = await this.supabase.rpc('get_streamer_queue', {
        p_streamer_id: streamerId,
      });

      if (!error) {
        return (data || []).map((row) => this.toPlayer(row));
      }

      if (!this.isMissingRpc(error)) {
        console.error('[Supabase] Erro ao buscar fila:', error.message);
        throw error;
      }

      // Fallback: Supabase próprio com schema antigo, sem a RPC e com SELECT
      // liberado. O modo legado continua funcionando nessa instalação.
      // A RPC é tentada de novo nas próximas leituras (a função pode passar a
      // existir depois de rodar o schema.sql), mas o aviso aparece só uma vez.
      if (!this.warnedMissingQueueRpc) {
        this.warnedMissingQueueRpc = true;
        console.warn('[Supabase] RPC get_streamer_queue ausente — usando SELECT direto.');
      }
    }

    const query = this.scopeToStreamer(
      this.supabase
        .from('queue')
        .select('*')
        .in('status', ['pending', 'playing'])
    );

    const { data, error } = await query
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
    // Deriva da própria fila visível (sem SELECT direto na tabela).
    const queue = await this.getQueue();
    const highest = queue.reduce(
      (max, player) => Math.max(max, Number(player.position) || 0),
      0
    );
    return highest + 1;
  }

  async addToQueue({ username, chessNick, priority, platform }) {
    this.assertSupabase();

    const streamerId = this.streamerId;
    if (!streamerId) {
      // A policy de INSERT exige streamer_id válido: falhar aqui é melhor do
      // que gravar em uma fila global compartilhada entre todos os streamers.
      throw new Error(
        'streamer_id não configurado nesta instalação. Abra Configurações e ative o LivePix para gerar sua identidade de fila.'
      );
    }

    // ID gerado no cliente: o INSERT não precisa de RETURNING (que exigiria
    // uma policy de SELECT, removida de propósito).
    const row = {
      id: randomUUID(),
      streamer_id: streamerId,
      player_name: username,
      chess_username: chessNick || null,
      platform: platform || 'chess.com',
      status: 'pending',
      position: await this.nextPosition(),
      notes: JSON.stringify({ priority: priority || PRIORITY.STANDARD }),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    let { error } = await this.supabase.from('queue').insert(row);

    // Fallback: Supabase próprio com schema antigo (sem streamer_id).
    if (error && this.isUnknownStreamerColumn(error)) {
      const legacyRow = { ...row };
      delete legacyRow.streamer_id;
      const retry = await this.supabase.from('queue').insert(legacyRow);
      error = retry.error;
      if (!error) {
        console.warn('[Supabase] Coluna streamer_id ausente — gravando em modo legado.');
      }
    }

    if (error) {
      console.error('[Supabase] Erro ao adicionar à fila:', error.message);
      throw error;
    }
    return this.toPlayer(row);
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
    // Soft delete: o schema revoga DELETE de anon/authenticated, então a saída
    // da fila é registrada como 'cancelled'. As consultas da fila filtram por
    // status, portanto a linha deixa de aparecer sem apagar o histórico.
    const query = this.scopeToStreamer(
      this.supabase
        .from('queue')
        .update({ status: 'cancelled' })
        .eq('player_name', username)
        .in('status', ['pending', 'playing'])
    );

    const { error } = await query;
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

    // A fila já vem da RPC ordenada por position/created_at.
    const queue = await this.getQueue();
    const candidate = queue.find((player) => player.status === 'pending');

    if (!candidate) {
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

    // Sem RETURNING: a policy de SELECT foi removida de propósito.
    const { error: updateError } = await this.supabase
      .from('queue')
      .update({ status: 'playing' })
      .eq('id', candidate.id);
    if (updateError) throw updateError;

    this.currentPlayer = { ...candidate, status: 'playing' };
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
    const query = this.scopeToStreamer(
      this.supabase
        .from('queue')
        .update(changes)
        .eq('id', id)
    );

    // Sem .select(): não há policy de SELECT. O estado atualizado é lido de
    // volta pela RPC, que também garante o isolamento por streamer.
    const { error } = await query;
    if (error) throw error;

    const queue = await this.getQueue();
    return queue.find((player) => player.id === id) || null;
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
    const row = {
      queue_id: queueId || null,
      player_name: playerName,
      opponent_name: opponentName,
      result: resultMap[result] || result || 'ongoing',
      game_url: gameUrl || null,
    };

    const streamerId = this.streamerId;
    if (streamerId) row.streamer_id = streamerId;

    let { error } = await this.supabase.from('match_history').insert(row);

    // Fallback: Supabase próprio com schema antigo (sem streamer_id).
    if (error && this.isUnknownStreamerColumn(error)) {
      const legacyRow = { ...row };
      delete legacyRow.streamer_id;
      const retry = await this.supabase.from('match_history').insert(legacyRow);
      error = retry.error;
    }

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
