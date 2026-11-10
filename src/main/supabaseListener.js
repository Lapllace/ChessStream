const { supabase } = require('./database');

class SupabaseListener {
  constructor(queueManager, sendToRenderer) {
    this.queue  = queueManager;
    this.send   = sendToRenderer;
    this.client = supabase;
  }

  start() {
    console.log('[Supabase] Conectando ao canal Realtime...');

    this.channel = this.client
      .channel('fila_vip')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'fila_vip' },
        (payload) => {
          this.handleVipPayment(payload.new)
            .catch((error) => console.error('[Supabase] Erro ao processar pagamento:', error));
        }
      )
      .subscribe((status) => {
        console.log(`[Supabase] Status: ${status}`);
        this.send('supabase:status', status);
      });
  }

  stop() {
    if (this.channel) {
      this.channel.unsubscribe();
    }
    this.channel = null;
  }

  async handleVipPayment(row) {
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
