const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pickFile: () => ipcRenderer.invoke("pick-file"),
  getFfmpegPath: () => ipcRenderer.invoke("get-ffmpeg-path"),
  exportClip: (opts) => ipcRenderer.invoke("export-clip", opts),
  onExportProgress: (cb) => ipcRenderer.on("export-progress", (_e, p) => cb(p)),
  getBiliStream: (opts) => ipcRenderer.invoke("bili-get-stream", opts),
  injectBiliHooks: () => ipcRenderer.invoke("inject-bili-hooks"),
  getSources: () => ipcRenderer.invoke("get-sources"),
  saveRecordingTo: (bytes, defaultName) => ipcRenderer.invoke("save-recording-to", bytes, defaultName),
  openLogin: (url) => ipcRenderer.invoke("open-login", url),
  onLoginClosed: (cb) => ipcRenderer.on("login-closed", () => cb()),
  getLoginState: () => ipcRenderer.invoke("get-login-state"),
  genSubtitles: (opts) => ipcRenderer.invoke("gen-subtitles", opts),
  onAsrProgress: (cb) => ipcRenderer.on("asr-progress", (_e, p) => cb(p)),
  aiAnalyze: (opts) => ipcRenderer.invoke("ai-analyze", opts),
  aiLoadConfig: () => ipcRenderer.invoke("ai-load-config"),
  aiSaveConfig: (cfg) => ipcRenderer.invoke("ai-save-config", cfg),
  aiListModels: (opts) => ipcRenderer.invoke("ai-list-models", opts),
  onAiProgress: (cb) => ipcRenderer.on("ai-progress", (_e, p) => cb(p)),
});
