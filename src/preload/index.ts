import { contextBridge, ipcRenderer } from "electron";

// Two shapes only, and one funnel channel: the renderer names a command, main decides
// whether that command exists. No paths, no handles, no node.
const unottr = {
  invoke: (channel: string, args?: unknown): Promise<unknown> =>
    ipcRenderer.invoke("unottr", channel, args),

  on(event: string, cb: (payload: unknown) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    const wire = `unottr:${event}`;
    ipcRenderer.on(wire, listener);
    return () => {
      ipcRenderer.off(wire, listener);
    };
  },
};

contextBridge.exposeInMainWorld("unottr", unottr);
