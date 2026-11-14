const axios = require('axios');

const POLL_INTERVAL_MS = 20_000; // 20 segundos
const GAME_START_TOLERANCE_MS = POLL_INTERVAL_MS; // evita enfileirar partidas antigas
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
    this.connected  = false;     // estado atual do monitor (usado pelo badge)
    this.knownGames = new Set(); // UUIDs já processados nesta sessão
    this.activeGameUrl = null;   // URL da partida em andamento
    this.autoQueuedGames = new Set(); // URLs de partidas já enfileiradas
    this.consecutiveErrors = 0;  // contador de falhas de rede consecutivas
    this.monitorStartedAt = 0;   // usado para ignorar partidas anteriores ao start
    this.lastGameEndTime = 0;    // end_time da última partida já processada
  }

  getStatus() {
    return { platform: 'chess', connected: !!this.connected };
  }

  start() {
    this.streamer = (process.env.CHESS_STREAMER_NICK || '').toLowerCase();
    this.monitorStartedAt = Date.now();
    if (!this.streamer) {
      console.warn('[Chess] CHESS_STREAMER_NICK não configurado — monitor desativado.');
      this.connected = false;
      this.send?.('chat:status', this.getStatus());
      return;
    }
    console.log(`[Chess] Monitorando ${this.streamer} a cada ${POLL_INTERVAL_MS / 1000}s`);
    this.connected = true;
    this.poll(); // executa imediatamente
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);

    // Polling ativo: acende o status CHESS no cabeçalho.
    this.send?.('chat:status', this.getStatus());
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.connected = false;
    this.send?.('chat:status', this.getStatus());
  }

  async poll() {
    try {
      // 1) Jogos ativos/recém-iniciados: alimenta a fila visual com o oponente.
      //    A PubAPI não expõe desafios pendentes; usamos os jogos diários em
      //    andamento como sinal de que o desafio foi aceito/iniciado.
      try {
        await this.pollActiveGames();
      } catch (err) {
        // Uma falha aqui não pode impedir a checagem de resultados abaixo.
        console.warn(`[Chess] Falha ao buscar jogos ativos: ${err.message}`);
      }

      // 2) Arquivo do mês atual: detecta partidas encerradas.
      const now    = new Date();
      const year   = now.getFullYear();
      const month  = String(now.getMonth() + 1).padStart(2, '0');
      const url    = `https://api.chess.com/pub/player/${this.streamer}/games/${year}/${month}`;

      const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'ChessStreamHub/1.0' },
        timeout: 8000,
      });

      const games = data.games || [];

      // 2.1) Detecta o término da partida mais recente antes de varrer a fila,
      //      para que o desfecho seja anexado ao jogador arquivado no histórico.
      await this.checkLastFinishedGame(games);

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

  /**
   * Extrai o nick do oponente. Em /pub/player/{nick}/games os campos white e
   * black são URLs de perfil (string), enquanto o arquivo mensal usa objetos
   * com { username }. Aceita os dois formatos.
   */
  chessUsername(player) {
    if (!player) return '';
    if (typeof player === 'string') {
      return player.split('/').filter(Boolean).pop()?.toLowerCase() || '';
    }
    return (player.username || '').toLowerCase();
  }

  /**
   * Busca os jogos diários em andamento (Current Daily Chess) e enfileira o
   * oponente de cada partida recém-iniciada. A PubAPI não possui endpoint de
   * desafios pendentes, então o jogo ativo é o primeiro sinal público de que
   * um desafio foi aceito.
   */
  async pollActiveGames() {
    if (!this.streamer) return;

    const url = `https://api.chess.com/pub/player/${encodeURIComponent(this.streamer)}/games`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'ChessStreamHub/1.0' },
      timeout: 8000,
    });

    const games = data.games || [];
    let newest = null;

    for (const game of games) {
      const whiteUser = this.chessUsername(game.white);
      const blackUser = this.chessUsername(game.black);
      const isStreamer = whiteUser === this.streamer || blackUser === this.streamer;
      if (!isStreamer || !game.url) continue;

      if (!newest || (game.start_time || 0) > (newest.start_time || 0)) {
        newest = game;
      }

      const opponentNick = whiteUser === this.streamer ? blackUser : whiteUser;
      if (!opponentNick || this.autoQueuedGames.has(game.url)) continue;

      // Ignora partidas que já existiam antes do monitor iniciar (ex.: várias
      // partidas diárias antigas). A tolerância cobre o intervalo entre o
      // start() e o primeiro poll.
      const startTime = Number(game.start_time) * 1000;
      if (Number.isFinite(startTime)
        && startTime < this.monitorStartedAt - GAME_START_TOLERANCE_MS) {
        continue;
      }

      // Marca antes do await para não duplicar em polls concorrentes.
      this.autoQueuedGames.add(game.url);
      const handled = await this.enqueueOpponent(opponentNick, game.url);
      if (!handled) {
        // Erro transitório (rede/Supabase): tenta de novo no próximo ciclo.
        this.autoQueuedGames.delete(game.url);
      } else if (this.autoQueuedGames.size > 500) {
        const first = this.autoQueuedGames.values().next().value;
        this.autoQueuedGames.delete(first);
      }
    }

    // Mantém a partida atual para a checagem de resultado. Só define quando
    // ainda não há uma acompanhada, para não perder o resultado de uma partida
    // que acabou de sair da lista de jogos ativos.
    if (!this.activeGameUrl && newest?.url) this.activeGameUrl = newest.url;
  }

  async enqueueOpponent(opponentNick, gameUrl) {
    try {
      const result = await this.queue.join(opponentNick, opponentNick, 'chess');
      if (result?.ok) {
        console.log(`[Chess] Desafiante ${opponentNick} entrou na fila (${gameUrl}).`);
        this.send?.('chess:opponent-queued', { opponent: opponentNick, gameUrl });
        return true;
      }

      // Já estava na fila: o filtro anti-duplicatas fez o trabalho.
      if (result?.msg?.includes('já está na fila')) {
        return true;
      }

      // Nick inválido não melhora com retry; pausa na fila sim.
      if (result?.msg?.includes('não encontrado')) {
        console.warn(`[Chess] Oponente ${opponentNick} não encontrado no Chess.com.`);
        return true;
      }

      console.warn(`[Chess] Não foi possível enfileirar ${opponentNick}: ${result?.msg}`);
      return false;
    } catch (err) {
      console.warn(`[Chess] Erro ao enfileirar ${opponentNick}: ${err.message}`);
      return false;
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

  /**
   * Usa o arquivo mensal para detectar o fim da partida mais recente.
   *
   * A PubAPI não expõe jogos ao vivo, mas assim que a partida termina ela
   * aparece no arquivo do mês com `end_time` preenchido. Comparamos esse valor
   * com o último já visto: se aumentou, uma partida acabou de terminar.
   */
  async checkLastFinishedGame(games) {
    const finished = (games || []).filter((game) => game.end_time);
    if (!finished.length) {
      // Nenhuma partida finalizada ainda: usa o início do monitor como linha
      // de base para detectar a primeira partida encerrada nesta sessão.
      if (!this.lastGameEndTime) {
        this.lastGameEndTime = Math.floor(this.monitorStartedAt / 1000);
      }
      return;
    }

    // Normalmente o último elemento é a partida mais recente, mas o arquivo
    // não garante a ordem — usamos o maior end_time.
    const latest = finished.reduce(
      (newest, game) => (game.end_time > newest.end_time ? game : newest)
    );

    // Primeiro poll: apenas memoriza a linha de base, sem disparar evento.
    if (!this.lastGameEndTime) {
      this.lastGameEndTime = latest.end_time;
      return;
    }

    if (latest.end_time <= this.lastGameEndTime) return;

    const whiteUser = this.chessUsername(latest.white);
    const blackUser = this.chessUsername(latest.black);
    const streamerIsWhite = whiteUser === this.streamer;

    if (!streamerIsWhite && blackUser !== this.streamer) {
      this.lastGameEndTime = latest.end_time;
      return;
    }

    const myResult = streamerIsWhite ? latest.white?.result : latest.black?.result;
    const opponentNick = streamerIsWhite ? blackUser : whiteUser;

    // Atualiza antes do await para não processar a mesma partida duas vezes
    // caso dois polls se sobreponham.
    this.lastGameEndTime = latest.end_time;

    if (!myResult || !opponentNick) return;

    const outcome = this.outcomeFromResult(myResult);
    console.log(`[Chess] Partida encerrada contra ${opponentNick}: ${outcome} (${myResult}).`);

    try {
      await this.queue.registerMatchEnd(opponentNick, outcome);
    } catch (err) {
      console.warn(`[Chess] Falha ao registrar fim de partida: ${err.message}`);
    }
  }

  /**
   * Converte o campo `result` do Chess.com (perspectiva do streamer) no
   * desfecho exibido no histórico.
   */
  outcomeFromResult(result) {
    if (result === 'win') return 'Vitória';

    if ([
      'agreed', 'repetition', 'stalemate', 'insufficient',
      '50move', 'timevsinsufficient',
    ].includes(result)) {
      return 'Empate';
    }

    // checkmated, timeout, resigned, abandoned, lose...
    return 'Derrota';
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
