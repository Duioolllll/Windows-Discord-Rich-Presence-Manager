import { describe, expect, it } from 'vitest';
import { parseRunningSnapshot, RunningProcessMonitor } from '../../src/windows/running';

const wrap = (processes: unknown[]) => JSON.stringify({version: 1, processes});
const process = {processId: 31, processName: 'Editor', startedAt: 1710000000000};

describe('Windows running application snapshots', () => {
  it('returns validated unique process metadata without leaking unknown fields', () => {
    expect(parseRunningSnapshot(wrap([{...process, title: 'private'}, process, {processId: 42, processName: '앱', startedAt: null}]))).toEqual([
      process, {processId: 42, processName: '앱', startedAt: null},
    ]);
    expect(parseRunningSnapshot(wrap([]))).toEqual([]);
    expect(parseRunningSnapshot('null')).toBeNull();
  });

  it('rejects invalid envelopes, malicious paths, missing or invalid fields, and conflicting duplicates', () => {
    for (const input of ['{}', '{"version":2,"processes":[]}', '[]', 'not JSON', wrap([{...process, processId: 0}]), wrap([{...process, processName: '../Editor'}]), wrap([{...process, processName: 'bad\nname'}]), wrap([{...process, startedAt: -1}]), wrap([{processId: 1, processName: 'Editor'}]), wrap([process, {...process, processName: 'Other'}])]) {
      expect(() => parseRunningSnapshot(input)).toThrow();
    }
    expect(() => parseRunningSnapshot(wrap(Array(2049).fill(process)))).toThrow();
  });

  it('validates polling limits and safely reports unsupported platforms', () => {
    expect(() => new RunningProcessMonitor({intervalMs: 999, onObservation() {}})).toThrow(RangeError);
    expect(() => new RunningProcessMonitor({intervalMs: 10001, onObservation() {}})).toThrow(RangeError);
    if (globalThis.process.platform !== 'win32') {
      const monitor = new RunningProcessMonitor({onObservation() { throw new Error('Unexpected observation'); }});
      expect(monitor.start()).toBe(false);
      monitor.stop();
    }
  });
});
