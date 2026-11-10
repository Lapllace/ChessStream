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

  // Config
  getConfig:    () => ipcRenderer.invoke('config:get'),
  settings: {
    get:         ()     => ipcRenderer.invoke('settings:get'),
    save:        (data) => ipcRenderer.invoke('settings:save', data),
    twitchLogin: ()     => ipcRenderer.invoke('twitch:login'),
  },

  // Eventos do main → renderer
  on: (event, callback) => {
    ipcRenderer.on(event, (_, data) => callback(data));
  },
  off: (event) => {
    ipcRenderer.removeAllListeners(event);
  },
});
