/** Chrome/Firefox Native Messaging host. stdout is reserved for framed protocol responses. */
import net from 'node:net';
import { BrowserMessage, parseBrowserMessage } from './protocol';
import { BROWSER_PIPE } from './server';

const LIMIT = 8192;
let buffer = Buffer.alloc(0);
let expected: number | undefined;
let stopped = false;
let pending: BrowserMessage | undefined;
let forwarding = false;
// A busy browser cannot create an unbounded number of sockets; preserve only the latest update.
function forward(message: BrowserMessage): void {
  pending = message;
  if (forwarding) return;
  const next = pending;
  pending = undefined;
  forwarding = true;
  const socket = net.createConnection(BROWSER_PIPE);
  socket.on('error', () => { socket.destroy(); });
  socket.setTimeout(2000, () => socket.destroy());
  socket.on('connect', () => socket.end(JSON.stringify(next)));
  socket.on('close', () => { forwarding = false; if (pending) forward(pending); });
}
function fail(): void { stopped = true; process.stdin.pause(); process.exitCode = 1; }
process.stdin.on('data', (chunk: Buffer) => {
  if (stopped) return;
  buffer = Buffer.concat([buffer, chunk]);
  // Never retain an unbounded partial frame.
  if (buffer.length > 1024 * 1024) { fail(); return; }
  while (!stopped) {
    if (expected === undefined) {
      if (buffer.length < 4) return;
      expected = buffer.readUInt32LE(0);
      buffer = buffer.subarray(4);
      if (expected === 0 || expected > LIMIT) { fail(); return; }
    }
    if (buffer.length < expected) return;
    const payload = buffer.subarray(0, expected);
    buffer = buffer.subarray(expected);
    expected = undefined;
    try {
      const message = parseBrowserMessage(JSON.parse(payload.toString('utf8')));
      if (!message) continue;
      forward(message);
    } catch { /* malformed input */ }
  }
});
process.stdin.on('end', () => { if (expected !== undefined || buffer.length) process.exitCode = 1; });
process.stdin.on('error', fail);
