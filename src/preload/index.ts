import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type Api } from '../shared/api';

// Expose exactly the Api methods, nothing else, to the sandboxed renderer.
const api = Object.fromEntries(
  (Object.keys(IPC_CHANNELS) as (keyof Api)[]).map((key) => [
    key,
    (...args: unknown[]) => ipcRenderer.invoke(IPC_CHANNELS[key], ...args),
  ]),
) as unknown as Api;

contextBridge.exposeInMainWorld('api', api);
