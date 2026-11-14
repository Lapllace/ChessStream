const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chessHub', {
  // Fila
  getQueue:     ()         => ipcRenderer.invoke('queue:get'),
  next:         ()         => ipcRenderer.invoke('queue:next'),
  skip:         ()         => ipcRenderer.invoke('queue:skip'),
  remove:       (username) => ipcRenderer.invoke('queue:remove', username),
  reorder:      (ids)      => ipcRenderer.invoke('queue:reorder', ids),
  pause:        ()         => ipcRenderer.invoke('queue:pause'),
  resume:       ()         => ipcRenderer.invoke('queue:resume'),
  promote:      (username) => ipcRenderer.invoke('queue:promote', username),
  manualAdd:    (nick)     => ipcRenderer.invoke('queue:manual-add', nick),
  getHistory:   ()         => ipcRenderer.invoke('history:get'),

  // Config
  getConfig:    () => ipcRenderer.invoke('config:get'),
  settings: {
    get:         ()     => ipcRenderer.invoke('settings:get'),
    save:        (data) => ipcRenderer.invoke('settings:save', data),
    twitchLogin: (clientId) => ipcRenderer.invoke('twitch:login', clientId),
    googleLogin: () => ipcRenderer.invoke('google:login'),
    tiktokLogin: (username) => ipcRenderer.invoke('tiktok:login', username),
  },

  // Licença (assinatura mensal, sem vínculo por máquina)
  license: {
    activate: (key) => ipcRenderer.invoke('license:activate', key),
    get:      ()    => ipcRenderer.invoke('license:get'),
    openApp:  ()    => ipcRenderer.invoke('license:open-app'),
    // Compatibilidade com o badge do modal de Configurações.
    status:   ()    => ipcRenderer.invoke('license:status'),
  },

  // Eventos do main → renderer
  on: (event, callback) => {
    ipcRenderer.on(event, (_, data) => callback(data));
  },
  off: (event) => {
    ipcRenderer.removeAllListeners(event);
  },
});
