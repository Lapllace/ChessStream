const settingsApi = window.chessHub.settings;
let isTwitchLoggingIn = false;

async function openSettings() {
  const config = await settingsApi.get();
  const fields = {
    'cfg-chess-nick': config.chessStreamerNick,
    'cfg-twitch-client-id': config.twitchClientId,
    'cfg-twitch-ch': config.twitchChannel,
    'cfg-twitch-username': config.twitchUsername,
    'cfg-tiktok-username': config.tiktokUsername,
    'cfg-mp-token': config.mpAccessToken,
    'cfg-mp-min': config.mpMinValue || 5,
    'cfg-supabase-url': config.supabaseUrl,
    'cfg-supabase-key': config.supabaseAnonKey,
    'cfg-language': config.language || 'pt',
    'cfg-livepix-client-id': config.livepixClientId,
    'cfg-livepix-base': config.livepixWebhookBaseUrl,
    'cfg-livepix-webhook': config.livepixWebhookUrl,
  };
  for (const [id, value] of Object.entries(fields)) $(id).value = value || '';

  // O segredo nunca sai do processo principal: mostramos só o placeholder.
  const livepixSecret = $('cfg-livepix-client-secret');
  if (livepixSecret) {
    livepixSecret.value = '';
    livepixSecret.placeholder = config.livepixConfigured
      ? t('livepixSecretSavedPlaceholder', 'Salvo — deixe em branco para manter')
      : t('livepixSecretPlaceholder', 'Client Secret do LivePix');
  }
  updateLivepixStatus(Boolean(config.livepixConfigured), config.livepixWebhookUrl);

  const twitchStatus = $('twitch-status');
  twitchStatus.textContent = config.hasTwitchToken ? 'Conectado' : 'Não conectado';
  twitchStatus.className = config.hasTwitchToken ? 'badge badge-green' : 'badge badge-red';
  $('settings-modal').classList.add('open');
  document.querySelector('.tab-btn')?.click();

  const youtubeStatus = $('youtube-status');
  youtubeStatus.textContent = config.youtubeConnected
    ? `Conectado: ${config.youtubeChannelName || config.youtubeChannelId}`
    : 'Não conectado';
  youtubeStatus.className = config.youtubeConnected
    ? 'badge badge-green'
    : 'badge badge-red';
}

function updateLivepixStatus(configured, webhookUrl = '', error = '') {
  const status = $('livepix-status');
  if (!status) return;

  status.title = error || '';
  if (error) {
    status.textContent = t('livepixSyncError', 'Erro ao sincronizar');
    status.className = 'badge badge-red';
    return;
  }

  status.textContent = configured
    ? t('livepixConnected', 'Configurado')
    : t('livepixNotConfigured', 'Não configurado');
  status.className = configured ? 'badge badge-green' : 'badge badge-red';

  const webhookInput = $('cfg-livepix-webhook');
  if (webhookInput && webhookUrl) webhookInput.value = webhookUrl;
}

async function copyLivepixWebhook() {
  const input = $('cfg-livepix-webhook');
  const button = $('btn-copy-livepix-webhook');
  const value = (input?.value || '').trim();
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
  } catch {
    input.removeAttribute('readonly');
    input.select();
    document.execCommand('copy');
    input.setAttribute('readonly', 'readonly');
  }

  if (button) {
    button.textContent = t('copied', 'Copiado!');
    setTimeout(() => {
      button.textContent = t('btnCopyWebhook', 'Copiar');
    }, 1500);
  }
}

async function saveSettings() {
  const button = $('btn-save-settings');
  const language = $('cfg-language')?.value || 'pt';
  const livepixSecret = $('cfg-livepix-client-secret')?.value.trim() || '';
  button.disabled = true;
  button.textContent = t('saving', 'Salvando...');
  try {
    const payload = {
      chessStreamerNick: $('cfg-chess-nick').value.trim(),
      twitchClientId: $('cfg-twitch-client-id').value.trim(),
      twitchChannel: $('cfg-twitch-ch').value.trim(),
      twitchUsername: $('cfg-twitch-username').value.trim(),
      tiktokUsername: $('cfg-tiktok-username').value.trim(),
      mpAccessToken: $('cfg-mp-token').value.trim(),
      mpMinValue: parseFloat($('cfg-mp-min').value) || 5,
      supabaseUrl: $('cfg-supabase-url').value.trim(),
      supabaseAnonKey: $('cfg-supabase-key').value.trim(),
      livepixClientId: $('cfg-livepix-client-id').value.trim(),
      livepixWebhookBaseUrl: $('cfg-livepix-base').value.trim(),
      language,
    };

    // Campo vazio não apaga o segredo salvo (o main também protege isso).
    if (livepixSecret) payload.livepixClientSecret = livepixSecret;

    const result = await settingsApi.save(payload);
    if (!result.ok) throw new Error('Não foi possível salvar as configurações.');

    // Aplica o novo idioma sem esperar reiniciar o app.
    applyLanguage(language);
    if (typeof renderQueue === 'function') renderQueue();

    const livepix = result.livepix || {};
    if (livepix.webhookUrl) {
      const webhookInput = $('cfg-livepix-webhook');
      if (webhookInput) webhookInput.value = livepix.webhookUrl;
    }

    if (livepix.configured && !livepix.synced) {
      updateLivepixStatus(true, livepix.webhookUrl, livepix.error || 'Falha ao publicar no Supabase');
      button.textContent = t('savedLocally', 'Salvo localmente');
      button.disabled = false;
      setTimeout(() => {
        if (!button.disabled) button.textContent = t('save', 'Salvar');
      }, 2500);
      return;
    }

    updateLivepixStatus(Boolean(livepix.configured), livepix.webhookUrl);
    if (livepixSecret) $('cfg-livepix-client-secret').value = '';

    button.textContent = t('saved', 'Salvo!');
    setTimeout(() => {
      closeSettings();
      button.textContent = t('save', 'Salvar');
      button.disabled = false;
    }, 800);
  } catch (error) {
    console.error('[Settings] Erro ao salvar:', error);
    button.textContent = t('savingError', 'Erro ao salvar');
    button.disabled = false;
  }
}

async function loginTwitch() {
  if (isTwitchLoggingIn) return;

  const button = $('btn-twitch-login');
  const status = $('twitch-status');
  const clientIdInput = $('cfg-twitch-client-id');
  const clientId = clientIdInput.value.trim();

  // O Client ID é obrigatório para montar a URL de autorização da Twitch.
  if (!clientId) {
    status.textContent = '❌ Client ID obrigatório';
    status.className = 'badge badge-red';
    clientIdInput.focus();
    window.alert('Informe o Client ID da Twitch antes de conectar.');
    return;
  }

  isTwitchLoggingIn = true;
  button.disabled = true;
  button.textContent = 'AGUARDANDO LOGIN...';
  try {
    const result = await settingsApi.twitchLogin(clientId);

    if (result?.ok && result.token) {
      const usernameInput = $('cfg-twitch-username');
      const channelInput = $('cfg-twitch-ch');

      if (result.username) {
        usernameInput.value = result.username;
        if (!channelInput.value.trim()) channelInput.value = result.username;
      }

      // Persiste o token (já sanitizado com "oauth:") e o Client ID.
      // O handler settings:save reinicia os bots com as novas credenciais.
      const saveResult = await settingsApi.save({
        twitchClientId: result.clientId || clientId,
        twitchOAuthToken: result.token,
        ...(usernameInput.value.trim() && {
          twitchUsername: usernameInput.value.trim(),
        }),
        ...(channelInput.value.trim() && {
          twitchChannel: channelInput.value.trim(),
        }),
      });

      if (!saveResult?.ok) {
        throw new Error('Não foi possível salvar o token da Twitch.');
      }

      status.textContent = 'CONECTADO';
      status.className = 'badge badge-green';
    } else if (result?.error === 'timeout') {
      status.textContent = '⏱ Tempo esgotado';
      status.className = 'badge badge-red';
    } else if (result?.error === 'cancelled') {
      status.textContent = 'Cancelado';
      status.className = 'badge badge-red';
    } else {
      status.textContent = `❌ Erro: ${result?.error || 'Token não recebido'}`;
      status.className = 'badge badge-red';
    }
  } catch (error) {
    console.error('[Settings] Erro no login Twitch:', error);
    status.textContent = `❌ ${error.message || 'Falha inesperada'}`;
    status.className = 'badge badge-red';
  } finally {
    isTwitchLoggingIn = false;
    button.disabled = false;
    button.textContent = 'LOGIN TWITCH';
  }
}

function closeSettings() {
  $('settings-modal').classList.remove('open');
}

$('btn-settings').addEventListener('click', openSettings);
$('btn-close-settings').addEventListener('click', closeSettings);
$('btn-cancel-settings').addEventListener('click', closeSettings);
$('btn-save-settings').addEventListener('click', saveSettings);
$('btn-twitch-login').addEventListener('click', loginTwitch);

const copyWebhookButton = $('btn-copy-livepix-webhook');
if (copyWebhookButton) {
  copyWebhookButton.addEventListener('click', copyLivepixWebhook);
}
async function loginTikTok() {
  const button = $('btn-tiktok-login');
  if (!button) return;

  button.disabled = true;
  button.textContent = 'AGUARDANDO LOGIN...';
  try {
    const result = await settingsApi.tiktokLogin($('cfg-tiktok-username').value.trim());
    if (result?.ok) {
      window.alert('Conta TikTok autenticada com sucesso! O chat será lido sem bloqueios.');
      button.textContent = 'TIKTOK CONECTADO';
      button.style.background = '#00f59b';
      button.style.color = '#000';
    } else {
      button.textContent = 'CONECTAR CONTA TIKTOK';
    }
  } catch (error) {
    console.error('[Settings] Erro no login TikTok:', error);
    button.textContent = 'CONECTAR CONTA TIKTOK';
  } finally {
    button.disabled = false;
  }
}

if ($('btn-tiktok-login')) {
  $('btn-tiktok-login').addEventListener('click', loginTikTok);
}

async function loginGoogle() {
  const button = $('btn-google-login');
  const status = $('youtube-status');
  button.disabled = true;
  button.textContent = 'Aguardando login...';
  let result;
  try {
    result = await settingsApi.googleLogin();
    status.textContent = result.ok
      ? `Conectado: ${result.channelName}`
      : 'Falhou';
    status.className = result.ok ? 'badge badge-green' : 'badge badge-red';
    button.textContent = result.ok ? 'Trocar conta Google' : 'Tentar novamente';
  } catch (error) {
    console.error('[Settings] Erro no login Google:', error);
    status.textContent = 'Falhou';
    status.className = 'badge badge-red';
    button.textContent = 'Tentar novamente';
  } finally {
    button.disabled = false;
  }
}

$('btn-google-login').addEventListener('click', loginGoogle);
window.chessHub.on('bots:restarted', () => console.log('[Settings] Bots reiniciados.'));

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    document.querySelectorAll('.tab-btn').forEach((tabButton) => {
      tabButton.classList.toggle('active', tabButton.dataset.target === target);
    });
    document.querySelectorAll('.settings-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.tab === target);
    });
  });
});
