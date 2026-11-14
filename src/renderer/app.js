/* ── Estado ──────────────────────────────────────────────────────────────── */
let queue       = [];
let isPaused    = false;
let dragSrcIdx  = null;
let matchHistory = [];
let currentLang = 'pt';

/* ── i18n ────────────────────────────────────────────────────────────────── */
function t(key, fallback = '') {
  const dictionary = window.translations || {};
  const language = dictionary[currentLang] || dictionary.pt || {};
  return language[key] ?? dictionary.pt?.[key] ?? fallback ?? key;
}

/**
 * Percorre o DOM aplicando as traduções.
 *
 * Suporta:
 *   data-i18n="chave"              → textContent
 *   data-i18n-placeholder="chave"  → placeholder
 *   data-i18n-title="chave"        → title (tooltip)
 *   data-i18n-aria-label="chave"   → aria-label
 */
function applyLanguage(lang) {
  const dictionary = window.translations || {};
  const resolved = dictionary[lang] ? lang : 'pt';
  const language = dictionary[resolved] || {};
  currentLang = resolved;

  document.documentElement.lang = {
    pt: 'pt-BR',
    en: 'en',
    es: 'es',
    ru: 'ru',
    de: 'de',
  }[resolved] || 'pt-BR';

  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const value = language[element.dataset.i18n];
    if (typeof value === 'string') element.textContent = value;
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
    const value = language[element.dataset.i18nPlaceholder];
    if (typeof value === 'string') element.placeholder = value;
  });

  document.querySelectorAll('[data-i18n-title]').forEach((element) => {
    const value = language[element.dataset.i18nTitle];
    if (typeof value === 'string') element.title = value;
  });

  document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
    const value = language[element.dataset.i18nAriaLabel];
    if (typeof value === 'string') element.setAttribute('aria-label', value);
  });

  // O botão de pausa tem dois rótulos possíveis; mantém o estado atual.
  if (isPaused) {
    const pauseButton = document.getElementById('btnPause');
    if (pauseButton && language.resumeQueue) {
      pauseButton.textContent = language.resumeQueue;
    }
  }
}

/* ── Elementos ───────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const queueList   = $('queueList');
const queueCount  = $('queueCount');
const currentCard = $('currentCard');
const gameResult  = $('gameResult');
const btnNext     = $('btnNext');
const btnSkip     = $('btnSkip');
const btnPause    = $('btnPause');
const vipToast    = $('vipToast');
const manualDrawer   = $('manualDrawer');
const manualToggle   = $('manualToggle');
const manualNick     = $('manualNick');
const manualAddBtn   = $('manualAddBtn');
const manualFeedback = $('manualFeedback');
let manualFeedbackTimer = null;

/* ── Init ────────────────────────────────────────────────────────────────── */
async function init() {
  // Aplica o idioma salvo antes de montar os textos dinâmicos.
  try {
    const settings = await window.chessHub.settings.get();
    applyLanguage(settings?.language || 'pt');
  } catch (error) {
    console.warn('[i18n] Não foi possível carregar o idioma salvo:', error);
    applyLanguage('pt');
  }

  const config = await window.chessHub.getConfig();
  if (config.streamerNick) {
    $('streamerNick').textContent = config.streamerNick;
  }

  queue = await window.chessHub.getQueue();
  renderQueue();
  bindEvents();
}

/* ── Render da fila ──────────────────────────────────────────────────────── */
function renderQueue() {
  queueCount.textContent = queue.length;

  if (queue.length === 0) {
    queueList.innerHTML = `
      <li class="queue-empty">
        ${escHtml(t('queueEmpty', 'Fila vazia — viewers usam !jogar <nick> no chat'))}
      </li>`;
    return;
  }

  queueList.innerHTML = '';
  queue.forEach((player, idx) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.dataset.username = player.username;
    li.dataset.priority = player.priority;
    li.draggable = true;

    const badgeHtml = platformBadge(player.platform) + priorityBadge(player.priority);

    li.innerHTML = `
      <span class="queue-pos">${idx + 1}</span>
      <div class="queue-info">
        <div class="queue-username">${escHtml(player.username)}</div>
        <div class="queue-chess">♟ ${escHtml(player.chess_nick)}</div>
      </div>
      <div class="queue-info" style="display:flex;gap:4px;flex-wrap:wrap">
        ${badgeHtml}
      </div>
      <div class="queue-actions">
        <button class="btn-icon promote" title="Promover para VIP" data-action="promote" data-username="${escHtml(player.username)}">⭐</button>
        <button class="btn-icon remove"  title="Remover da fila"  data-action="remove"  data-username="${escHtml(player.username)}">✕</button>
      </div>`;

    // Drag & Drop
    li.addEventListener('dragstart', onDragStart);
    li.addEventListener('dragover',  onDragOver);
    li.addEventListener('drop',      onDrop);
    li.addEventListener('dragend',   onDragEnd);

    // Botões inline
    li.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'remove')  handleRemove(btn.dataset.username);
      if (btn.dataset.action === 'promote') handlePromote(btn.dataset.username);
    });

    queueList.appendChild(li);
  });
}

/* ── Render do jogador atual ─────────────────────────────────────────────── */
function renderCurrentPlayer(player) {
  if (!player) {
    currentCard.innerHTML = `<div class="current-empty">${escHtml(t('currentEmpty', 'Nenhum desafiante ativo'))}</div>`;
    return;
  }

  currentCard.innerHTML = `
    <div class="current-player">
      <div class="player-name">${escHtml(player.username)}</div>
      <div class="player-nick">♟ ${escHtml(player.chess_nick)}</div>
      <div class="player-meta">
        ${platformBadge(player.platform)}
        ${priorityBadge(player.priority)}
      </div>
    </div>`;
}

/* ── Badges ──────────────────────────────────────────────────────────────── */
function platformBadge(platform) {
  if (platform === 'twitch')  return `<span class="badge badge-twitch">Twitch</span>`;
  if (platform === 'youtube') return `<span class="badge badge-youtube">YouTube</span>`;
  if (platform === 'tiktok')  return `<span class="badge badge-tiktok">TikTok</span>`;
  if (platform === 'chess')   return `<span class="badge badge-chess">Chess.com</span>`;
  if (platform === 'manual')  return `<span class="badge badge-manual">Manual</span>`;
  if (platform === 'livepix') return `<span class="badge badge-vip">LivePix</span>`;
  if (platform === 'payment') return `<span class="badge badge-vip">💳 Pago</span>`;
  return '';
}

function priorityBadge(priority) {
  const normalized = priority === 'vip' ? 2 : Number(priority);
  if (normalized === 1) return `<span class="badge badge-vip">Ultra VIP</span>`;
  if (normalized === 2) return `<span class="badge badge-vip">⭐ VIP</span>`;
  if (normalized === 3) return `<span class="badge badge-member">Membro</span>`;
  return '';
}

/* ── Handlers dos botões ─────────────────────────────────────────────────── */
function bindEvents() {
  btnNext.addEventListener('click', async () => {
    const player = await window.chessHub.next();
    renderCurrentPlayer(player);
    gameResult.style.display = 'none';
  });

  btnSkip.addEventListener('click', async () => {
    await window.chessHub.skip();
  });

  btnPause.addEventListener('click', async () => {
    if (isPaused) {
      await window.chessHub.resume();
    } else {
      await window.chessHub.pause();
    }
  });

  manualToggle.addEventListener('click', () => {
    const isOpen = manualDrawer.classList.toggle('open');
    manualToggle.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) manualNick.focus();
  });

  manualAddBtn.addEventListener('click', handleManualAdd);

  manualNick.addEventListener('keypress', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    handleManualAdd();
  });
}

async function handleManualAdd() {
  const nick = manualNick.value.trim();
  if (!nick) {
    manualNick.focus();
    return;
  }

  // Limpa imediatamente para permitir adicionar vários jogadores em sequência.
  manualNick.value = '';
  manualNick.focus();

  try {
    const result = await window.chessHub.manualAdd(nick);
    if (result?.ok) {
      showManualFeedback(result.msg || `✅ ${nick} adicionado à fila.`, true);
    } else {
      showManualFeedback(result?.msg || 'Não foi possível adicionar esse nick.', false);
    }
  } catch (error) {
    console.error('[Fila] Erro ao adicionar manualmente:', error);
    showManualFeedback('Não foi possível adicionar agora.', false);
  }
}

function showManualFeedback(message, success) {
  manualFeedback.textContent = message;
  manualFeedback.className = `manual-feedback visible ${success ? 'success' : 'error'}`;

  clearTimeout(manualFeedbackTimer);
  manualFeedbackTimer = setTimeout(() => {
    manualFeedback.className = 'manual-feedback';
  }, 4000);
}

async function handleRemove(username) {
  await window.chessHub.remove(username);
}

async function handlePromote(username) {
  await window.chessHub.promote(username);
}

/* ── Drag & Drop ─────────────────────────────────────────────────────────── */
function onDragStart(e) {
  dragSrcIdx = [...queueList.children].indexOf(this);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('drag-over'));
  this.classList.add('drag-over');
}

function onDrop(e) {
  e.stopPropagation();
  const targetIdx = [...queueList.children].indexOf(this);
  if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;

  const newOrder = [...queue];
  const [moved]  = newOrder.splice(dragSrcIdx, 1);
  newOrder.splice(targetIdx, 0, moved);

  queue = newOrder;
  renderQueue();

  window.chessHub.reorder(newOrder.map(p => p.username));
}

function onDragEnd() {
  this.classList.remove('dragging');
  document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('drag-over'));
  dragSrcIdx = null;
}

/* ── Eventos do processo principal ──────────────────────────────────────────*/
window.chessHub.on('queue:update', (newQueue) => {
  queue = newQueue;
  renderQueue();
});

window.chessHub.on('queue:current-player', (player) => {
  renderCurrentPlayer(player);
});

window.chessHub.on('queue:paused', (state) => {
  isPaused = state;
  btnPause.textContent = state ? t('resumeQueue', '▶ Retomar fila') : t('pauseQueue', '⏸ Pausar fila');
  btnPause.classList.toggle('paused', state);
});

window.chessHub.on('chess:game-ended', ({ opponent, result }) => {
  const cssResult = result === 'vitória' ? 'vitoria' : result;
  gameResult.className = `game-result ${cssResult}`;
  const emoji = result === 'vitória' ? '♛' : result === 'derrota' ? '♙' : '½';
  gameResult.textContent = `${emoji} Partida encerrada contra ${opponent} — ${result}`;
  gameResult.style.display = 'block';
});

window.chessHub.on('game:result', async ({ outcome, gameUrl }) => {
  // Atualiza o badge .game-result visível no painel principal.
  const badge = document.getElementById('gameResult');
  if (badge) {
    badge.textContent = outcome === 'vitoria' ? '✓ VITÓRIA'
      : outcome === 'empate' ? '= EMPATE'
      : '✗ DERROTA';
    badge.className = `game-result ${outcome}`;
    badge.style.display = 'block';
  }

  // Atualiza o último item do histórico com o resultado da partida.
  try {
    const history = await window.chessHub.getHistory();
    matchHistory = Array.isArray(history) ? history : [];
  } catch (error) {
    console.error('[History] Erro ao atualizar histórico:', error);
  }

  if (matchHistory.length > 0) {
    matchHistory[matchHistory.length - 1].outcome = outcome;
    matchHistory[matchHistory.length - 1].gameUrl = gameUrl;
  }

  // Re-renderiza o modal de histórico (a função vive em historyModal.js).
  if (typeof renderHistory === 'function') {
    renderHistory(matchHistory);
  }
});

window.chessHub.on('queue:vip-alert', ({ username, chessNick, amount_cents }) => {
  const valor = amount_cents ? ` (R$ ${(amount_cents / 100).toFixed(2)})` : '';
  vipToast.textContent = `⭐ ${username} entrou na fila VIP${valor}!`;
  vipToast.classList.add('visible');
  setTimeout(() => vipToast.classList.remove('visible'), 5000);
  playVipSound();
});

// Aviso de licença prestes a expirar (enviado no boot e na revalidação).
window.chessHub.on('license:warning', ({ daysLeft, expiresAt }) => {
  const banner = document.getElementById('licenseBanner');
  if (!banner) return;
  banner.textContent = daysLeft <= 1
    ? '⚠ Licença expira HOJE! Renove agora.'
    : `⚠ Licença expira em ${daysLeft} dia(s). Renove para continuar.`;
  banner.style.display = 'block';
});

window.chessHub.on('chat:status', ({ platform, connected }) => {
  const statusIds = {
    twitch: 'statusTwitch',
    youtube: 'statusYoutube',
    tiktok: 'statusTiktok',
    chess: 'statusChess',
  };
  const id = statusIds[platform];
  if (!id) return;
  const el = $(id);
  if (el) el.classList.toggle('connected', connected);
});

/* ── Som de VIP ──────────────────────────────────────────────────────────── */
function playVipSound() {
  try {
    const ctx  = new AudioContext();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type      = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch {}
}

/* ── Util ────────────────────────────────────────────────────────────────── */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Start ───────────────────────────────────────────────────────────────── */
init();

const particleCanvas = document.getElementById('particle-canvas');

function initParticles() {
  if (!particleCanvas) return;

  const context = particleCanvas.getContext('2d');
  const config = { particleColor: '#8a38d6', count: 35, maxSpeed: 0.5, maxSize: 3 };
  const particles = [];

  function resizeCanvas() {
    particleCanvas.width = window.innerWidth;
    particleCanvas.height = window.innerHeight;
  }

  class Particle {
    constructor() {
      this.reset(true);
    }

    reset(initial = false) {
      this.x = Math.random() * particleCanvas.width;
      this.y = initial ? Math.random() * particleCanvas.height : particleCanvas.height + 10;
      this.size = Math.floor(Math.random() * (config.maxSize - 1)) + 2;
      this.speed = Math.random() * config.maxSpeed + 0.15;
      this.baseOpacity = Math.random() * 0.5 + 0.2;
      this.opacity = this.baseOpacity;
    }

    update() {
      this.y -= this.speed;
      const fadeStart = particleCanvas.height * 0.7;
      this.opacity = this.y < fadeStart
        ? this.baseOpacity * (this.y / fadeStart)
        : this.baseOpacity;
      if (this.y < 0 || this.opacity <= 0) this.reset();
    }

    draw() {
      if (this.opacity <= 0) return;
      context.save();
      context.globalAlpha = Math.max(0, this.opacity);
      context.fillStyle = config.particleColor;
      context.shadowBlur = 4;
      context.shadowColor = config.particleColor;
      context.fillRect(Math.floor(this.x), Math.floor(this.y), this.size, this.size);
      context.restore();
    }
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  for (let index = 0; index < config.count; index += 1) particles.push(new Particle());

  function animateParticles() {
    context.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
    particles.forEach((particle) => {
      particle.update();
      particle.draw();
    });
    requestAnimationFrame(animateParticles);
  }

  animateParticles();
}

function runIntroAnimation() {
  const overlay = document.getElementById('intro-overlay');
  if (!overlay) return;
  const badge = document.getElementById('brilliant-badge');
  const shockwave = document.getElementById('shockwave');
  const appWrapper = document.getElementById('app-wrapper');
  if (!badge || !shockwave || !appWrapper) return;

  overlay.style.display = 'flex';
  overlay.style.opacity = '1';
  appWrapper.classList.remove('visible');
  badge.className = 'brilliant-badge';
  shockwave.className = 'shockwave';
  document.body.classList.remove('shake-screen');

  setTimeout(() => badge.classList.add('brilliant-drop'), 200);
  setTimeout(() => {
    document.body.classList.add('shake-screen');
    shockwave.classList.add('shockwave-active');
    badge.classList.add('brilliant-fade');
  }, 1400);
  setTimeout(() => {
    appWrapper.classList.add('visible');
    overlay.style.opacity = '0';
  }, 2000);
  setTimeout(() => {
    overlay.style.display = 'none';
  }, 3000);
}

function replayIntro() {
  runIntroAnimation();
}

initParticles();
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('intro-overlay')) runIntroAnimation();
});
