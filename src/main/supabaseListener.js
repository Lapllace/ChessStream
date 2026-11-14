const { getSupabaseClient } = require('./database');

const CHANNEL_NAME = 'fila_vip';
const SUBSCRIBE_TIMEOUT_MS = 15000;

class SupabaseListener {
  constructor(queueManager, sendToRenderer, options = {}) {
    this.queue  = queueManager;
    this.send   = sendToRenderer;
    // Resolvido no start(): o cliente pode ter sido recriado por
    // reconnectSupabase() enquanto o app estava aberto.
    this.client = null;
    this.channel = null;
    // streamer_id da instalação. Vazio = modo legado (sem filtro).
    this.getStreamerId = typeof options.getStreamerId === 'function'
      ? options.getStreamerId
      : () => '';
    // Serializa start/stop. Sem isto, dois start() concorrentes reutilizam o
    // mesmo tópico e o segundo tenta adicionar postgres_changes depois do
    // subscribe(), gerando: "cannot add postgres_changes callbacks ... after subscribe()".
    this.lifecycle = Promise.resolve();
  }

  get streamerId() {
    try {
      return String(this.getStreamerId() || '').trim();
    } catch {
      return '';
    }
  }

  start() {
    return this.enqueue(() => this.startInternal());
  }

  stop() {
    return this.enqueue(() => this.stopInternal());
  }

  enqueue(task) {
    const run = this.lifecycle.catch(() => {}).then(task);
    // Mantém a fila viva mesmo se uma operação falhar.
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async startInternal() {
    await this.stopInternal();

    this.client = getSupabaseClient();
    if (!this.client) {
      console.warn('[Supabase] Cliente não configurado — listener não iniciado.');
      return;
    }

    // Remove qualquer canal órfão com o mesmo tópico (ex.: start anterior que
    // falhou no meio) antes de criar um novo. É isto que evita o erro acima.
    await this.removeStaleChannels();

    console.log('[Supabase] Conectando ao canal Realtime...');

    // Filtro no servidor: a instância só recebe eventos da própria fila.
    // Sem streamer_id (modo legado) mantém a assinatura global anterior.
    const streamerId = this.streamerId;
    const queueFilter = streamerId ? { filter: `streamer_id=eq.${streamerId}` } : {};
    if (streamerId) {
      console.log(`[Supabase] Filtrando fila pelo streamer ${streamerId}.`);
    }

    const channel = this.client.channel(CHANNEL_NAME);
    this.channel = channel;

    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'fila_vip' },
      (payload) => {
        this.handleVipPayment(payload.new)
          .catch((error) => console.error('[Supabase] Erro ao processar pagamento:', error));
      }
    );

    // O webhook do LivePix insere direto em public.queue. Sem esta assinatura,
    // o app só veria a fila VIP depois de um restart.
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'queue', ...queueFilter },
      (payload) => {
        this.handleQueueInsert(payload.new)
          .catch((error) => console.error('[Supabase] Erro ao processar entrada na fila:', error));
      }
    );

    channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'queue', ...queueFilter },
      () => this.refreshQueue()
    );

    channel.on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'queue', ...queueFilter },
      () => this.refreshQueue()
    );

    await new Promise((resolve) => {
      let settled = false;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(status);
      };
      const timer = setTimeout(() => finish('TIMEOUT'), SUBSCRIBE_TIMEOUT_MS);

      channel.subscribe((status) => {
        console.log(`[Supabase] Status: ${status}`);
        this.send('supabase:status', status);
        if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          finish(status);
        }
      });
    });
  }

  async stopInternal() {
    const channel = this.channel;
    this.channel = null;
    if (!channel || !this.client) return;

    try {
      await this.client.removeChannel(channel);
      console.log('[Supabase] Canal Realtime removido.');
    } catch (error) {
      console.warn('[Supabase] Erro ao remover canal Realtime:', error?.message || error);
    }
  }

  async removeStaleChannels() {
    if (typeof this.client?.getChannels !== 'function') return;

    const topic = `realtime:${CHANNEL_NAME}`;
    const stale = this.client
      .getChannels()
      .filter((channel) => channel !== this.channel
        && (channel.topic === topic || channel.topic === CHANNEL_NAME));

    for (const channel of stale) {
      try {
        await this.client.removeChannel(channel);
        console.warn('[Supabase] Canal Realtime órfão removido antes de reconectar.');
      } catch (error) {
        console.warn('[Supabase] Erro ao remover canal órfão:', error?.message || error);
      }
    }
  }

  async refreshQueue() {
    try {
      const queue = await this.queue.getQueue();
      this.send('queue:update', queue);
    } catch (error) {
      console.warn('[Supabase] Não foi possível atualizar a fila:', error?.message || error);
    }
  }

  /**
   * Linha inserida pelo webhook do LivePix (ou por outra instância do app).
   * Atualiza o painel e dispara o alerta VIP quando a prioridade é "vip".
   */
  async handleQueueInsert(row) {
    if (!row) return;

    // Defesa extra: o filtro do Realtime já é por streamer_id, mas uma linha
    // antiga (sem streamer_id) ou um evento de outro tenant nunca deve
    // atualizar o painel desta instalação.
    const streamerId = this.streamerId;
    if (streamerId && row.streamer_id !== streamerId) return;

    await this.refreshQueue();

    let metadata = {};
    try {
      metadata = JSON.parse(row.notes || '{}');
    } catch {
      metadata = {};
    }

    const isVip = metadata.priority === 'vip' || Number(metadata.priority) === 2;
    if (!isVip) return;

    this.send('queue:vip-alert', {
      username: row.player_name,
      chessNick: row.chess_username,
      amount_cents: metadata.amount_cents || row.amount_cents || 0,
    });
  }

  async handleVipPayment(row) {
    // fila_vip é o fluxo legado do Mercado Pago e não possui streamer_id.
    // Só descartamos quando a linha explicitamente pertence a outro streamer.
    const streamerId = this.streamerId;
    if (streamerId && row?.streamer_id && row.streamer_id !== streamerId) return;

    const { username, chess_nick, amount_cents } = row;
    console.log(`[Supabase] Pagamento recebido: ${username} (R$${amount_cents / 100})`);

    // Salva como assinante pago
    this.queue.upsertSubscriber({
      username,
      chessNick: chess_nick,
      platform:  'payment',
      subType:   'paid',
    });

    // Se já estiver na fila, promove; senão, adiciona diretamente
    const inQueue = (await this.queue.getQueue()).find(p => p.username === username);
    if (inQueue) {
      await this.queue.promote(username);
    } else if (chess_nick) {
      await this.queue.join(username, chess_nick, 'payment');
      await this.queue.promote(username);
    }

    // Alerta visual/sonoro no painel
    this.send('queue:vip-alert', { username, chessNick: chess_nick, amount_cents });
  }
}

module.exports = SupabaseListener;
