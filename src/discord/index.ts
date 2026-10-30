import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Activity } from '../core/types.js';
import { validateImageReference } from '../core/image.js';

/** The app ID identifies one Discord developer application, not the detected app. */
export type DiscordStatus = 'stopped' | 'connecting' | 'connected' | 'disconnected';
export interface DiscordPresenceOptions {
  clientId: string;
  onStatus?: (status: DiscordStatus, error?: string) => void;
  /** Overrides are useful for testing and explicitly selecting a local Discord client. */
  socketPaths?: string[];
  /** Reconnect automatically after a failure or disconnect (default: true). */
  reconnect?: boolean;
  reconnectDelayMs?: number;
  timeoutMs?: number;
}

type Payload = Record<string, unknown> | null;
type Reply = { evt?: string | null; cmd?: string; nonce?: string; data?: unknown };
const MAX_FRAME_BYTES = 1024 * 1024;

function frame(op: number, value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const bytes = Buffer.allocUnsafe(8 + body.length);
  bytes.writeUInt32LE(op, 0);
  bytes.writeUInt32LE(body.length, 4);
  body.copy(bytes, 8);
  return bytes;
}

function text(value: string, max = 128): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()).slice(0, max).join('');
}

/** Only supplied public text and validated image references can leave the process. */
export function toDiscordActivity(activity: Activity | null): Payload {
  if (!activity) return null;
  const application = text(activity.application);
  const details = text(activity.details);
  const published: Record<string, unknown> = {
    name: application,
    details,
    instance: false,
  };
  if (activity.state && text(activity.state)) published.state = text(activity.state);
  // Core timestamps are Unix milliseconds; Discord's documented IPC value is seconds.
  if (activity.startedAt && Number.isFinite(activity.startedAt) && activity.startedAt > 0) {
    published.timestamps = { start: Math.floor(activity.startedAt / 1000) };
  }
  // An asset key must exist on the Discord application; URLs are fetched by Discord.
  if (activity.imageKey && validateImageReference(activity.imageKey)) {
    published.assets = { large_image: activity.imageKey };
  }
  return published;
}

function defaultSocketPaths(): string[] {
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const directory = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp';
  return Array.from({ length: 10 }, (_, i) => join(directory, `discord-ipc-${i}`));
}

/** Local RPC integration. Does not read Discord tokens or use browser/user account credentials. */
export class DiscordPresence {
  private readonly options: DiscordPresenceOptions;
  private running = false;
  private socket: Socket | null = null;
  private status: DiscordStatus = 'stopped';
  private desired: Payload = null;
  private version = 0;
  private sentVersion = -1;
  private pumping = false;
  private wakeRetry: (() => void) | null = null;
  private pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(options: DiscordPresenceOptions) {
    if (!/^\d{15,20}$/.test(options.clientId)) throw new Error('A valid Discord application client ID is required');
    this.options = options;
  }

  getStatus(): DiscordStatus { return this.status; }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  /** Keeps the latest activity and replays it after reconnection. */
  setActivity(activity: Activity | null): void {
    const next = toDiscordActivity(activity);
    if (JSON.stringify(this.desired) === JSON.stringify(next)) return;
    this.desired = next;
    this.version++;
    if (this.status === 'connected') void this.pump();
  }

  /** Clear the current presence, then close the pipe. A timeout bounds shutdown. */
  async stop(): Promise<void> {
    if (!this.running) { this.setStatus('stopped'); return; }
    this.running = false;
    this.wakeRetry?.();
    if (this.socket && this.status === 'connected') {
      try { await this.sendCommand(null); } catch { /* Discord may have exited. */ }
    }
    this.socket?.destroy();
    this.socket = null;
    this.failPending(new Error('RPC stopped'));
    this.setStatus('stopped');
  }

  private setStatus(status: DiscordStatus, error?: string): void {
    this.status = status;
    this.options.onStatus?.(status, error);
  }

  private async run(): Promise<void> {
    while (this.running) {
      this.setStatus('connecting');
      let connected = false;
      for (const path of this.options.socketPaths ?? defaultSocketPaths()) {
        if (!this.running) break;
        try {
          const socket = await this.connect(path);
          if (!this.running) { socket.destroy(); break; }
          connected = true;
          this.socket = socket;
          await this.session(socket);
          break;
        } catch { /* Try the next local Discord IPC endpoint. */ }
      }
      if (!this.running) break;
      if (this.options.reconnect === false) this.running = false;
      this.setStatus('disconnected', connected ? 'Discord connection closed' : 'Discord desktop client not available');
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.wakeRetry = null; resolve(); }, this.options.reconnectDelayMs ?? 5000);
        this.wakeRetry = () => { clearTimeout(timer); this.wakeRetry = null; resolve(); };
      });
    }
  }

  private connect(path: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Connection timed out')); }, this.options.timeoutMs ?? 3000);
      socket.once('error', onError);
      socket.once('connect', () => { clearTimeout(timer); socket.removeListener('error', onError); resolve(socket); });
      function onError(error: Error): void { clearTimeout(timer); reject(error); }
    });
  }

  private session(socket: Socket): Promise<void> {
    return new Promise((resolve) => {
      let bytes = Buffer.alloc(0);
      let ready = false;
      const handshakeTimer = setTimeout(() => socket.destroy(), this.options.timeoutMs ?? 3000);
      const finish = () => {
        clearTimeout(handshakeTimer);
        if (this.socket === socket) this.socket = null;
        this.failPending(new Error('Discord connection closed'));
        this.sentVersion = -1;
        resolve();
      };
      socket.on('error', () => { socket.destroy(); });
      socket.once('close', finish);
      socket.on('data', (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        while (bytes.length >= 8) {
          const op = bytes.readUInt32LE(0);
          const length = bytes.readUInt32LE(4);
          if (length > MAX_FRAME_BYTES) { socket.destroy(); return; }
          if (bytes.length < 8 + length) break;
          const body = bytes.subarray(8, 8 + length);
          bytes = bytes.subarray(8 + length);
          if (op === 2) { socket.destroy(); return; }
          if (op === 3) {
            try { socket.write(frame(4, JSON.parse(body.toString('utf8')))); }
            catch { socket.destroy(); return; }
            continue;
          }
          if (op !== 1) continue;
          let reply: Reply;
          try { reply = JSON.parse(body.toString('utf8')) as Reply; } catch { socket.destroy(); return; }
          if (!ready && reply.cmd === 'DISPATCH' && reply.evt === 'READY') {
            ready = true;
            clearTimeout(handshakeTimer);
            this.sentVersion = -1;
            this.setStatus('connected');
            void this.pump();
          }
          if (reply.nonce) {
            const pending = this.pending.get(reply.nonce);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(reply.nonce);
              if (reply.evt === 'ERROR') pending.reject(new Error('Discord rejected activity'));
              else pending.resolve();
            }
          }
        }
      });
      socket.write(frame(0, { v: 1, client_id: this.options.clientId }));
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running && this.status === 'connected' && this.sentVersion !== this.version) {
        const target = this.version;
        await this.sendCommand(this.desired);
        this.sentVersion = target;
      }
    } catch {
      // A rejected or unacknowledged command must not be reported as published.
      this.socket?.destroy();
    } finally { this.pumping = false; }
  }

  private sendCommand(activity: Payload): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('Discord is disconnected'));
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(nonce); reject(new Error('Discord RPC timed out')); }, this.options.timeoutMs ?? 3000);
      this.pending.set(nonce, { resolve, reject, timer });
      socket.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce }), (error?: Error | null) => {
        if (error) {
          const pending = this.pending.get(nonce);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(nonce); pending.reject(error); }
        }
      });
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
