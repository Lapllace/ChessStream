const settingsApi = window.chessHub.settings;

async function openSettings() {
  const config = await settingsApi.get();
  const fields = {
    'cfg-chess-nick': config.chessStreamerNick,
    'cfg-twitch-client-id': config.twitchClientId,
    'cfg-twitch-ch': config.twitchChannel,
    'cfg-yt-key': config.youtubeApiKey,
    'cfg-yt-channel': config.youtubeChannelId,
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
      youtubeApiKey: $('cfg-yt-key').value.trim(),
      youtubeChannelId: $('cfg-yt-channel').value.trim(),
      mpAccessToken: $('cfg-mp-token').value.trim(),
      mpMinValue: parseFloat($('cfg-mp-min').value) || 5,
      supabaseUrl: $('cfg-supabase-url').value.trim(),
      supabaseAnonKey: $('cfg-supabase-key').value.trim(),
    });
    if (!result.ok) throw new Error('Não foi possível salvar as configurações.');
    button.textContent = 'Salvo!';
    setTimeout(closeSettings, 800);
  } catch (error) {
    console.error('[Settings] Erro ao salvar:', error);
    button.textContent = 'Erro ao salvar';
    button.disabled = false;
  }
}

async function loginTwitch() {
  const button = $('btn-twitch-login');
  const status = $('twitch-status');
  button.disabled = true;
  button.textContent = 'Aguardando login...';
  try {
    const result = await settingsApi.twitchLogin();
    status.textContent = result.ok ? 'Conectado' : 'Falhou';
    status.className = result.ok ? 'badge badge-green' : 'badge badge-red';
    button.textContent = result.ok ? 'Reconectar Twitch' : 'Tentar novamente';
  } catch (error) {
    console.error('[Settings] Erro no login Twitch:', error);
    status.textContent = 'Falhou';
    status.className = 'badge badge-red';
    button.textContent = 'Tentar novamente';
  } finally {
    button.disabled = false;
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
window.chessHub.on('bots:restarted', () => console.log('[Settings] Bots reiniciados.'));
