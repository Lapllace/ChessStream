const settingsApi = window.chessHub.settings;
let isTwitchLoggingIn = false;

async function openSettings() {
  const config = await settingsApi.get();
  const fields = {
    'cfg-chess-nick': config.chessStreamerNick,
    'cfg-twitch-client-id': config.twitchClientId,
    'cfg-twitch-ch': config.twitchChannel,
    'cfg-twitch-username': config.twitchUsername,
    'cfg-mp-token': config.mpAccessToken,
    'cfg-mp-min': config.mpMinValue || 5,
    'cfg-supabase-url': config.supabaseUrl,
    'cfg-supabase-key': config.supabaseAnonKey,
  };
  for (const [id, value] of Object.entries(fields)) $(id).value = value || '';

  const twitchStatus = $('twitch-status');
  twitchStatus.textContent = config.twitchOAuthToken ? 'Conectado' : 'Não conectado';
  twitchStatus.className = config.twitchOAuthToken ? 'badge badge-green' : 'badge badge-red';
  $('settings-modal').classList.add('open');
  document.querySelector('.tab-btn')?.click();

  const youtubeStatus = $('youtube-status');
  youtubeStatus.textContent = config.youtubeAccessToken
    ? `Conectado: ${config.youtubeChannelName || config.youtubeChannelId}`
    : 'Não conectado';
  youtubeStatus.className = config.youtubeAccessToken
    ? 'badge badge-green'
    : 'badge badge-red';
}

async function saveSettings() {
  const button = $('btn-save-settings');
  button.disabled = true;
  button.textContent = 'Salvando...';
  try {
    const result = await settingsApi.save({
      chessStreamerNick: $('cfg-chess-nick').value.trim(),
      twitchClientId: $('cfg-twitch-client-id').value.trim(),
      twitchChannel: $('cfg-twitch-ch').value.trim(),
      twitchUsername: $('cfg-twitch-username').value.trim(),
      mpAccessToken: $('cfg-mp-token').value.trim(),
      mpMinValue: parseFloat($('cfg-mp-min').value) || 5,
      supabaseUrl: $('cfg-supabase-url').value.trim(),
      supabaseAnonKey: $('cfg-supabase-key').value.trim(),
    });
    if (!result.ok) throw new Error('Não foi possível salvar as configurações.');
    button.textContent = 'Salvo!';
    setTimeout(() => {
      closeSettings();
      button.textContent = 'Salvar';
      button.disabled = false;
    }, 800);
  } catch (error) {
    console.error('[Settings] Erro ao salvar:', error);
    button.textContent = 'Erro ao salvar';
    button.disabled = false;
  }
}

async function loginTwitch() {
  if (isTwitchLoggingIn) return;

  const button = $('btn-twitch-login');
  const status = $('twitch-status');
  isTwitchLoggingIn = true;
  button.disabled = true;
  button.textContent = 'AGUARDANDO LOGIN...';
  try {
    const result = await settingsApi.twitchLogin();

    if (result && (result.ok || result.success)) {
      status.textContent = 'CONECTADO';
      status.className = 'badge badge-green';
      if (result.username) {
        $('cfg-twitch-username').value = result.username;
        const channelInput = $('cfg-twitch-ch');
        if (channelInput && !channelInput.value.trim()) {
          channelInput.value = result.username;
        }
      }
      if (result.clientId) $('cfg-twitch-client-id').value = result.clientId;
    } else if (result?.error === 'timeout') {
      status.textContent = '⏱ Tempo esgotado';
      status.className = 'badge badge-red';
      button.textContent = 'LOGIN TWITCH';
    } else if (result?.error === 'cancelled') {
      status.textContent = 'Cancelado';
      status.className = 'badge badge-red';
      button.textContent = 'LOGIN TWITCH';
    } else {
      status.textContent = `❌ Erro: ${result?.error || 'desconhecido'}`;
      status.className = 'badge badge-red';
      button.textContent = 'LOGIN TWITCH';
    }
  } catch (error) {
    console.error('[Settings] Erro no login Twitch:', error);
    status.textContent = '❌ Falha inesperada';
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
