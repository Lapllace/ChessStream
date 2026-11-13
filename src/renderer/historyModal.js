/* ── Modal de histórico ──────────────────────────────────────────────────── */

function historyPlatformBadge(platform) {
  if (platform === 'twitch')  return '<span class="badge badge-twitch">Twitch</span>';
  if (platform === 'youtube') return '<span class="badge badge-youtube">YouTube</span>';
  if (platform === 'tiktok')  return '<span class="badge badge-tiktok">TikTok</span>';
  if (platform === 'payment') return '<span class="badge badge-vip">💳 Pago</span>';
  return '<span class="badge">Chess.com</span>';
}

function formatHistoryTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function renderHistory(history) {
  const list = $('history-list');

  if (!history.length) {
    list.innerHTML = '<li class="history-empty">Nenhum jogador passou por aqui hoje.</li>';
    return;
  }

  list.innerHTML = history
    .slice()
    .reverse()
    .map((entry) => {
      const time = formatHistoryTime(entry.exitedAt);
      return `
        <li class="history-item">
          <div class="history-info">
            <div class="history-name">${escHtml(entry.username || '—')}</div>
            <div class="history-chess">♟ ${escHtml(entry.chessNick || '—')}</div>
          </div>
          ${historyPlatformBadge(entry.platform)}
          ${time ? `<span class="history-time">${time}</span>` : ''}
        </li>`;
    })
    .join('');
}

async function openHistory() {
  const modal = $('history-modal');
  const list = $('history-list');

  modal.classList.add('open');
  list.innerHTML = '<li class="history-empty">Carregando...</li>';

  try {
    const history = await window.chessHub.getHistory();
    renderHistory(Array.isArray(history) ? history : []);
  } catch (error) {
    console.error('[History] Erro ao carregar histórico:', error);
    list.innerHTML = '<li class="history-empty">Não foi possível carregar o histórico.</li>';
  }
}

function closeHistory() {
  $('history-modal').classList.remove('open');
}

$('btn-history').addEventListener('click', openHistory);
$('btn-close-history').addEventListener('click', closeHistory);
$('history-modal').addEventListener('click', (event) => {
  if (event.target === $('history-modal')) closeHistory();
});
