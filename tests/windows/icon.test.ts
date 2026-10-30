import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const fixture = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OoQEAAAgDILPZ7P9f6hkrBDrVs5dUAgICAgICAgICAgICAgIC6cADUSXsPY6pw24AAAAASUVORK5CYII=';
const mocks = vi.hoisted(() => ({ children: [] as any[], calls: [] as any[] }));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return { spawn: vi.fn((...args: unknown[]) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    mocks.calls.push(args); mocks.children.push(child); return child;
  }) };
});
import { parseIconPayload, ProcessIconProvider } from '../../src/windows/icon';

const first = {processId: 101, processName: 'Editor', startedAt: 1700000000000};
const second = {processId: 102, processName: 'Browser', startedAt: 1700000000001};
const third = {processId: 103, processName: '앱', startedAt: 1700000000002};
const fourth = {processId: 104, processName: 'Focus', startedAt: 1700000000003};
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function windows() { Object.defineProperty(process, 'platform', {configurable: true, value: 'win32'}); }
function complete(child: EventEmitter & {stdout: PassThrough}, data = fixture) { child.stdout.write(data); child.emit('close', 0); }

beforeEach(() => { mocks.children.length = 0; mocks.calls.length = 0; });
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); vi.useRealTimers(); });

describe('local process icon extraction', () => {
  it('accepts only small 32px PNG payloads for a local data URL', () => {
    expect(parseIconPayload(fixture)).toBe(`data:image/png;base64,${fixture}`);
    expect(parseIconPayload('')).toBeNull();
    expect(parseIconPayload('%%notbase64%%')).toBeNull();
    expect(parseIconPayload(Buffer.from('not a png').toString('base64'))).toBeNull();
    const bad = Buffer.from(fixture, 'base64'); bad.writeUInt32BE(4096, 16);
    expect(parseIconPayload(bad.toString('base64'))).toBeNull();
    expect(parseIconPayload('a'.repeat(200000))).toBeNull();
  });

  it('does not execute outside Windows or for unverified identities', async () => {
    if (originalPlatform.value !== 'win32') {
      const provider = new ProcessIconProvider();
      expect(await provider.getIcon(first)).toBeNull();
      expect(mocks.calls).toHaveLength(0); provider.dispose();
    }
    windows();
    const provider = new ProcessIconProvider();
    expect(await provider.getIcon({...first, startedAt: null})).toBeNull();
    expect(await provider.getIcon({...first, processName: '../bad'})).toBeNull();
    expect(mocks.calls).toHaveLength(0); provider.dispose();
  });

  it('limits concurrency, coalesces and caches requests, and validates PID identity in helper', async () => {
    windows(); const provider = new ProcessIconProvider(); provider.retain([first, second, third]);
    const p1 = provider.getIcon(first), duplicate = provider.getIcon(first), p2 = provider.getIcon(second), p3 = provider.getIcon(third);
    expect(mocks.calls).toHaveLength(2);
    const encoded = (mocks.calls[0][1] as string[]).at(-1)!;
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toContain('GetProcessById(101)');
    expect(script).toContain('$start -ne 1700000000000');
    expect(script).toContain('$proc.ProcessName -cne $expectedName');
    expect(script).toContain('$graphics.DrawIcon($icon, [System.Drawing.Rectangle]::new(0,0,32,32))');
    expect(script).not.toContain('$graphics.DrawIcon($icon, 0, 0, 32, 32)');
    expect(script).not.toContain('Editor');
    complete(mocks.children[0]);
    expect(await p1).toBe(`data:image/png;base64,${fixture}`);
    expect(await duplicate).toBe(`data:image/png;base64,${fixture}`);
    expect(mocks.calls).toHaveLength(3);
    expect(await provider.getIcon(first)).toBe(`data:image/png;base64,${fixture}`);
    complete(mocks.children[1]); complete(mocks.children[2]);
    expect(await p2).not.toBeNull(); expect(await p3).not.toBeNull(); provider.dispose();
  });

  it('moves the focused process ahead of queued background extractions', async () => {
    windows(); const provider = new ProcessIconProvider(); provider.retain([first, second, third, fourth]);
    const a = provider.getIcon(first), b = provider.getIcon(second);
    const c = provider.getIcon(third), d = provider.getIcon(fourth);
    expect(mocks.calls).toHaveLength(2);
    provider.prioritize(fourth);
    // Unknown or already-running processes must not disturb the queue.
    provider.prioritize(first);
    provider.prioritize({...fourth, startedAt: null});
    complete(mocks.children[0]); await a;
    expect(mocks.calls).toHaveLength(3);
    const script = Buffer.from((mocks.calls[2][1] as string[]).at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain('GetProcessById(104)');
    complete(mocks.children[1]); await b;
    expect(mocks.calls).toHaveLength(4);
    const remaining = Buffer.from((mocks.calls[3][1] as string[]).at(-1)!, 'base64').toString('utf16le');
    expect(remaining).toContain('GetProcessById(103)');
    complete(mocks.children[2]); complete(mocks.children[3]);
    await Promise.all([c, d]); provider.dispose();
  });

  it('cancels stale and queued jobs on retention change or disposal', async () => {
    windows(); const provider = new ProcessIconProvider(); provider.retain([first, second, third]);
    const a = provider.getIcon(first), b = provider.getIcon(second), c = provider.getIcon(third);
    provider.retain([second]);
    expect(await a).toBeNull(); expect(await c).toBeNull();
    expect(mocks.children[0].kill).toHaveBeenCalledOnce();
    provider.dispose(); expect(await b).toBeNull();
    expect(mocks.children[1].kill).toHaveBeenCalledOnce();
    expect(await provider.getIcon(second)).toBeNull();
  });

  it('times out and returns null without exposing child output', async () => {
    windows(); vi.useFakeTimers(); const provider = new ProcessIconProvider();
    const pending = provider.getIcon(first);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull(); expect(mocks.children[0].kill).toHaveBeenCalledOnce();
    expect(await provider.getIcon(first)).toBeNull(); expect(mocks.calls).toHaveLength(1);
    provider.dispose();
  });
});
