// LocalLeaf preload: the only bridge between the sandboxed renderer and Electron.
// Mirrors the surface the UI expects (invoke / events / dialogs / window title / drop paths).

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("localleaf", {
  invoke: (cmd, args) => ipcRenderer.invoke("localleaf:invoke", cmd, args ?? {}),

  /** Subscribes to backend/UI events; returns an unsubscribe function. */
  listen: (event, handler) => {
    const listener = (_e, msg) => {
      if (msg?.event === event) handler({ payload: msg.payload });
    };
    ipcRenderer.on("localleaf:event", listener);
    return () => ipcRenderer.removeListener("localleaf:event", listener);
  },

  dialog: {
    open: (opts) => ipcRenderer.invoke("localleaf:dialog", "open", opts),
    save: (opts) => ipcRenderer.invoke("localleaf:dialog", "save", opts),
    ask: (message, opts) => ipcRenderer.invoke("localleaf:dialog", "ask", { message, ...opts }),
  },

  setTitle: (title) => ipcRenderer.invoke("localleaf:setTitle", title),

  /** Absolute path of a File dropped from the OS file manager (HTML5 drag & drop). */
  pathForFile: (file) => webUtils.getPathForFile(file),
});
