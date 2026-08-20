// The renderer's view of the bridge. `invoke` is generic here but `unknown` in the
// implementation — the cast lives in ipc/client.ts, which is the only caller.
export interface UnottrBridge {
  invoke<T>(channel: string, args?: unknown): Promise<T>;
  on<T>(event: string, cb: (payload: T) => void): () => void;
}

declare global {
  interface Window {
    unottr: UnottrBridge;
  }
}
