/* ── Estado ──────────────────────────────────────────────────────────────── */
let queue       = [];
let isPaused    = false;
let dragSrcIdx  = null;

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

/* ── Init ────────────────────────────────────────────────────────────────── */
async function init() {
  const config = await window.chessHub.getConfig();
  if (config.streamerNick) {
    $('streamerNick').textContent = config.streamerNick;
  }
  if (config.supabaseEnabled) {
    $('statusSupabase').style.display = 'inline';
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
        Fila vazia — viewers usam <code>!jogar &lt;nick&gt;</code> no chat
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
    currentCard.innerHTML = `<div class="current-empty">Nenhum desafiante ativo</div>`;
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
  if (platform === 'payment') return `<span class="badge badge-vip">💳 Pago</span>`;
  return '';
}

function priorityBadge(priority) {
  if (priority === 1) return `<span class="badge badge-vip">Ultra VIP</span>`;
  if (priority === 2) return `<span class="badge badge-vip">⭐ VIP</span>`;
  if (priority === 3) return `<span class="badge badge-member">Membro</span>`;
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
  btnPause.textContent = state ? '▶ Retomar fila' : '⏸ Pausar fila';
  btnPause.classList.toggle('paused', state);
});

window.chessHub.on('chess:game-ended', ({ opponent, result }) => {
  gameResult.className = `game-result ${result}`;
  const emoji = result === 'vitória' ? '♛' : result === 'derrota' ? '♙' : '½';
  gameResult.textContent = `${emoji} Partida encerrada contra ${opponent} — ${result}`;
  gameResult.style.display = 'block';
});

window.chessHub.on('queue:vip-alert', ({ username, chessNick, amount_cents }) => {
  const valor = amount_cents ? ` (R$ ${(amount_cents / 100).toFixed(2)})` : '';
  vipToast.textContent = `⭐ ${username} entrou na fila VIP${valor}!`;
  vipToast.classList.add('visible');
  setTimeout(() => vipToast.classList.remove('visible'), 5000);
  playVipSound();
});

window.chessHub.on('chat:status', ({ platform, connected }) => {
  const el = platform === 'twitch' ? $('statusTwitch') : $('statusYoutube');
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
