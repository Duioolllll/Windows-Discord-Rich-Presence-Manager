import net from 'node:net';
import { BrowserMessage, parseBrowserMessage } from './protocol';

/** Treat named-pipe input as untrusted, including input from local processes. */
export const BROWSER_PIPE = '\\\\.\\pipe\\autopresence-browser-v1';
const LIMIT = 8192;

/** Start once in the Electron main process. The caller must verify the message browser is in the foreground. */
export function startBrowserServer(onMessage: (message: BrowserMessage) => void): Promise<net.Server> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Browser named pipe requires Windows'));
  const server = net.createServer(socket => {
    let data = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > LIMIT) socket.destroy();
    });
    socket.on('end', () => {
      if (data.length === 0 || data.length > LIMIT) return;
      try {
        const message = parseBrowserMessage(JSON.parse(data.toString('utf8')));
        if (message) onMessage(message);
      } catch { /* untrusted input */ }
    });
  });
  server.maxConnections = 16;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(BROWSER_PIPE, () => { server.off('error', reject); server.on('error', () => {}); resolve(server); });
  });
}
