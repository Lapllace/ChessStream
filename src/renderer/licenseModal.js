/* ── Licença comercial ───────────────────────────────────────────────────────
 * Gate bloqueante: enquanto `license:check` não retornar `valid: true` a
 * interface fica coberta pelo #licenseModal e os bots não iniciam (o bloqueio
 * real acontece no main process).
 *
 * Este arquivo é um script clássico e compartilha o escopo global com app.js,
 * então usa `$`, `t` e `renderQueue` definidos lá.
 */

const LICENSE_REASON_TO_KEY = {
  no_key: 'licenseReasonNoKey',
  invalid_key: 'licenseReasonInvalidKey',
  invalid_hwid: 'licenseReasonInvalidHwid',
  not_found: 'licenseReasonNotFound',
  revoked: 'licenseReasonRevoked',
  expired: 'licenseReasonExpired',
  inactive: 'licenseReasonInactive',
  hwid_mismatch: 'licenseReasonHwidMismatch',
  hwid_changed: 'licenseReasonHwidChanged',
  offline_grace: 'licenseReasonOfflineGrace',
  network_error: 'licenseReasonNetworkError',
  not_configured: 'licenseReasonNotConfigured',
  check_failed: 'licenseReasonCheckFailed',
  needs_check: 'licenseReasonNeedsCheck',
  activated: 'licenseReasonActivated',
  active: 'licenseReasonActive',
  cached: 'licenseReasonCached',
};

/** Texto traduzido para um resultado de licença (usado também em settingsModal). */
function licenseReasonLabel(result) {
  if (!result) return t('licenseReasonCheckFailed', 'Não foi possível verificar a licença.');
  const key = LICENSE_REASON_TO_KEY[result.reason];
  const translated = key ? t(key, '') : '';
  return translated || result.message || t('licenseReasonCheckFailed', 'Não foi possível verificar a licença.');
}

(function initLicenseGate() {
  const licenseApi = window.chessHub?.license;
  const modal = $('licenseModal');
  if (!licenseApi || !modal) return;

  const input = $('license-key-input');
  const activateButton = $('btn-activate-license');
  const messageEl = $('license-message');
  const hwidEl = $('license-hwid');
  const copyButton = $('btn-copy-hwid');
  const buyButton = $('btn-buy-license');
  const retryButton = $('btn-retry-license');

  const RETRYABLE_REASONS = new Set(['network_error', 'check_failed']);

  let isActivating = false;
  let lastResult = null;
  let shortHwid = '';

  /* ── Mensagens ─────────────────────────────────────────────────────────── */

  function describeResult(result) {
    return licenseReasonLabel(result);
  }

  function setMessage(text, tone = '') {
    if (!messageEl) return;
    messageEl.textContent = text || '';
    messageEl.className = `license-message${tone ? ` ${tone}` : ''}`;
  }

  /* ── HWID ──────────────────────────────────────────────────────────────── */

  function renderHwid(short) {
    shortHwid = short || shortHwid;
    if (hwidEl) hwidEl.textContent = shortHwid || '—';
  }

  async function loadHwid() {
    try {
      const info = await licenseApi.getHwid();
      renderHwid(info?.short || '');
    } catch (error) {
      console.warn('[Licença] Não foi possível ler o HWID:', error);
      renderHwid('');
    }
  }

  async function copyHwid() {
    const value = shortHwid || hwidEl?.textContent || '';
    if (!value || value === '—') return;

    try {
      await navigator.clipboard.writeText(value);
      flashCopyButton(t('licenseCopied', 'Copiado!'));
    } catch {
      // Fallback para contextos onde a Clipboard API é bloqueada.
      const helper = document.createElement('textarea');
      helper.value = value;
      helper.setAttribute('readonly', 'readonly');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      try {
        document.execCommand('copy');
        flashCopyButton(t('licenseCopied', 'Copiado!'));
      } catch {
        flashCopyButton(t('licenseCopyFailed', 'Falhou'));
      } finally {
        helper.remove();
      }
    }
  }

  let copyTimer = null;
  function flashCopyButton(label) {
    if (!copyButton) return;
    copyButton.textContent = label;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyButton.textContent = t('licenseCopyHwid', 'Copiar');
    }, 1800);
  }

  /* ── Modal ─────────────────────────────────────────────────────────────── */

  function showModal(result) {
    lastResult = result || lastResult;
    modal.hidden = false;
    modal.classList.add('open');

    setMessage(describeResult(result), result?.valid ? 'success' : 'error');
    if (retryButton) retryButton.hidden = !RETRYABLE_REASONS.has(result?.reason);

    // Atualiza o badge das Configurações, caso esteja aberto.
    if (typeof updateLicenseBadge === 'function') updateLicenseBadge(result);

    setTimeout(() => input?.focus(), 30);
  }

  function hideModal() {
    modal.classList.remove('open');
    modal.hidden = true;
    setMessage('', '');
    if (retryButton) retryButton.hidden = true;

    if (typeof updateLicenseBadge === 'function') updateLicenseBadge(lastResult);
  }

  async function refreshQueue() {
    try {
      const fresh = await window.chessHub.getQueue();
      if (Array.isArray(fresh)) {
        queue = fresh;
        if (typeof renderQueue === 'function') renderQueue();
      }
    } catch (error) {
      console.warn('[Licença] Não foi possível atualizar a fila:', error);
    }
  }

  /* ── Ações ─────────────────────────────────────────────────────────────── */

  async function refreshLicense({ silent = false, force = false } = {}) {
    if (retryButton) retryButton.hidden = true;
    if (!silent) setMessage(t('licenseChecking', 'Verificando licença...'), 'info');

    let result;
    try {
      result = await licenseApi.check({ force });
    } catch (error) {
      result = {
        valid: false,
        reason: 'check_failed',
        message: error?.message || '',
      };
    }

    lastResult = result;
    if (result?.hwidShort) renderHwid(result.hwidShort);

    if (result?.valid) {
      hideModal();
      await refreshQueue();
      return result;
    }

    showModal(result);
    return result;
  }

  async function handleActivate() {
    if (isActivating) return;

    const key = String(input?.value || '').trim();
    if (!key) {
      setMessage(t('licenseReasonInvalidKey', 'Cole a chave de licença.'), 'error');
      input?.focus();
      return;
    }

    isActivating = true;
    activateButton.disabled = true;
    activateButton.textContent = t('licenseActivating', 'Ativando...');
    setMessage(t('licenseChecking', 'Verificando licença...'), 'info');

    try {
      const result = await licenseApi.activate(key);
      lastResult = result;

      if (result?.hwidShort) renderHwid(result.hwidShort);

      if (result?.valid) {
        if (input) input.value = '';
        setMessage(
          t('licenseReasonActivated', 'Licença ativada com sucesso! Iniciando os bots...'),
          'success'
        );
        if (typeof updateLicenseBadge === 'function') updateLicenseBadge(result);

        // Destrava a interface imediatamente; os bots sobem no main process.
        setTimeout(async () => {
          hideModal();
          await refreshQueue();
        }, 900);
        return;
      }

      setMessage(describeResult(result), 'error');
      if (typeof updateLicenseBadge === 'function') updateLicenseBadge(result);
      input?.focus();
      input?.select();
    } catch (error) {
      console.error('[Licença] Erro ao ativar:', error);
      setMessage(
        t('licenseReasonNetworkError', 'Não foi possível conectar ao servidor de licenças.'),
        'error'
      );
    } finally {
      isActivating = false;
      activateButton.disabled = false;
      activateButton.textContent = t('licenseActivate', 'Ativar licença');
    }
  }

  async function handlePurchase() {
    try {
      const result = await licenseApi.purchase();
      if (!result?.ok) {
        setMessage(t('licenseBuyFailed', 'Não foi possível abrir a página de compra.'), 'error');
      }
    } catch (error) {
      console.error('[Licença] Erro ao abrir a compra:', error);
      setMessage(t('licenseBuyFailed', 'Não foi possível abrir a página de compra.'), 'error');
    }
  }

  /* ── Eventos ───────────────────────────────────────────────────────────── */

  activateButton?.addEventListener('click', handleActivate);
  copyButton?.addEventListener('click', copyHwid);
  buyButton?.addEventListener('click', handlePurchase);
  retryButton?.addEventListener('click', () => refreshLicense({ force: true }));

  input?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    handleActivate();
  });

  // Normaliza visualmente enquanto o usuário cola a chave.
  input?.addEventListener('input', () => {
    const caretAtEnd = input.selectionStart === input.value.length;
    const normalized = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const groups = normalized.startsWith('CHESS')
      ? normalized.match(/^CHESS|.{1,4}/g) || []
      : normalized.match(/.{1,4}/g) || [];
    const formatted = groups.join('-').replace(/^CHESS-?/, 'CHESS-');
    if (formatted !== input.value) {
      input.value = formatted;
      if (caretAtEnd) input.setSelectionRange(formatted.length, formatted.length);
    }
  });

  // O main process emite o resultado sempre que revalida (boot/ativação).
  window.chessHub.on('license:status', (result) => {
    lastResult = result;
    if (result?.hwidShort) renderHwid(result.hwidShort);
    if (result?.valid) {
      if (!isActivating) hideModal();
    } else if (result && result.reason !== 'no_key') {
      // Não reabre o modal por um "no_key" emitido durante o boot se o
      // usuário já estiver digitando: o check inicial cuida da exibição.
      showModal(result);
    }
  });

  /* ── Boot ──────────────────────────────────────────────────────────────── */

  (async function boot() {
    await loadHwid();
    await refreshLicense();
  })();
})();
