// The only bridge between the page and the window host. Deliberately tiny: the
// page can describe where the player should sit and ask for it to be adopted,
// and nothing else.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("womboShell", {
  isShell: true,
  setStageBounds: (bounds) => ipcRenderer.invoke("stage:bounds", bounds),
  attachDolphin: () => ipcRenderer.invoke("dolphin:attach"),
  focusDolphin: () => ipcRenderer.invoke("dolphin:focus"),
  dolphinDetached: () => ipcRenderer.invoke("dolphin:detached"),
  // Fired when the host adopts a Dolphin it found on its own - e.g. one started
  // from a browser tab rather than from this window.
  onAdopted: (cb) => ipcRenderer.on("dolphin:adopted", () => cb()),
  // Dolphin's title is its only live telemetry; the speed % says whether it is
  // still fast-forwarding to the clip or actually playing it.
  stats: () => ipcRenderer.invoke("dolphin:stats"),
  setPlayerVisible: (v) => ipcRenderer.invoke("dolphin:visible", v),
  // Dolphin's own pause hotkey is unreachable, so pausing freezes the process.
  setPaused: (v) => ipcRenderer.invoke("dolphin:paused", v),
  // Slippi's own seek bar: seeks in place and reports the true current frame.
  seekInfo: () => ipcRenderer.invoke("dolphin:seekinfo"),
  seekTo: (frame) => ipcRenderer.invoke("dolphin:seek", frame),
});
