const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  invoke: (action, payload) =>
    ipcRenderer.invoke("desktop:action", action, payload),
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("desktop:state", listener);
    return () => ipcRenderer.removeListener("desktop:state", listener);
  },
  subscribeSurface: (callback) => {
    const listener = (_event, surface) => callback(surface);
    ipcRenderer.on("desktop:surface", listener);
    return () => ipcRenderer.removeListener("desktop:surface", listener);
  },
  subscribeVisibility: (callback) => {
    const listener = (_event, visible) => callback(visible);
    ipcRenderer.on("desktop:visibility", listener);
    return () => ipcRenderer.removeListener("desktop:visibility", listener);
  },
});
