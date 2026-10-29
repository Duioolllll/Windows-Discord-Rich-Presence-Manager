import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordPresence, toDiscordActivity } from '../../src/discord/index.ts';

function packet(op: number, data: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0); header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for expected RPC message');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('presence redacts URLs from image fields and uses Discord epoch seconds', () => {
  assert.deepEqual(toDiscordActivity({ application: 'VS Code', details: 'Editing code', state: 'TypeScript', imageKey: 'https://bad.example/x', startedAt: 1700000000000, confidence: 'generic' }), {
    details: 'VS Code — Editing code', state: 'TypeScript', instance: false, timestamps: { start: 1700000000 },
  });
  assert.throws(() => new DiscordPresence({ clientId: '' }), /client ID/);
});

test('handshake, ACK, deduplication, reconnection and clear over local IPC', async () => {
  if (process.platform === 'win32') return; // This test uses a Unix-domain test server.
  const dir = await mkdtemp(join(tmpdir(), 'autopresence-rpc-'));
  const path = join(dir, 'discord-ipc-0');
  const received: Array<Record<string, any>> = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 8 && data.length >= 8 + data.readUInt32LE(4)) {
        const op = data.readUInt32LE(0);
        const length = data.readUInt32LE(4);
        const msg = JSON.parse(data.subarray(8, 8 + length).toString());
        data = data.subarray(8 + length);
        if (op === 0) socket.write(packet(1, { cmd: 'DISPATCH', evt: 'READY' }));
        if (op === 1) {
          received.push(msg);
          socket.write(packet(1, { cmd: msg.cmd, nonce: msg.nonce, data: {} }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const statuses: string[] = [];
  const client = new DiscordPresence({ clientId: '123456789012345678', socketPaths: [path], timeoutMs: 500, reconnectDelayMs: 20, onStatus: (s) => statuses.push(s) });
  try {
    const activity = { application: 'Editor', details: 'Working', confidence: 'generic' as const };
    client.setActivity(activity); client.start();
    await until(() => received.length === 1);
    assert.equal(received[0].args.activity.details, 'Editor — Working');
    client.setActivity(activity);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(received.length, 1);
    for (const socket of sockets) socket.destroy();
    await until(() => received.length === 2);
    assert.equal(received[1].args.activity.details, 'Editor — Working');
    assert.ok(statuses.includes('disconnected'));
    await client.stop();
    await until(() => received.length === 3);
    assert.equal(received[2].args.activity, null);
    assert.equal(client.getStatus(), 'stopped');
  } finally {
    await client.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('disabled reconnect stops after initial failure and permits a manual restart', async () => {
  if (process.platform === 'win32') return;
  const dir = await mkdtemp(join(tmpdir(), 'autopresence-rpc-no-retry-'));
  const path = join(dir, 'discord-ipc-0');
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('data', (bytes) => {
      if (bytes.readUInt32LE(0) === 0) socket.write(packet(1, { cmd: 'DISPATCH', evt: 'READY' }));
    });
  });
  const client = new DiscordPresence({ clientId: '123456789012345678', socketPaths: [path], reconnect: false, timeoutMs: 100, reconnectDelayMs: 20 });
  try {
    client.start();
    await until(() => client.getStatus() === 'disconnected');
    await new Promise<void>((resolve) => server.listen(path, resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, 0);
    client.start();
    await until(() => client.getStatus() === 'connected');
    assert.equal(connections, 1);
    for (const socket of sockets) socket.destroy();
    await until(() => client.getStatus() === 'disconnected');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, 1);
  } finally {
    await client.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
