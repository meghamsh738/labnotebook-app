const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: (options) => ipcRenderer.invoke('dialog:select-directory', options),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  ensureDirectories: (paths) => ipcRenderer.invoke('fs:ensure-directories', paths),
  requestGoogleDriveAccessToken: (options) => ipcRenderer.invoke('google-drive:request-token', options),
  disconnectGoogleDrive: (options) => ipcRenderer.invoke('google-drive:disconnect', options),
})
