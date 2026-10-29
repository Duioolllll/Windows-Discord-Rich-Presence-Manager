import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ForegroundMonitor, parseForegroundObservation } from '../../src/windows/foreground.ts';

test('parse observations without leaking unknown fields', () => {
  assert.deepEqual(parseForegroundObservation(JSON.stringify({windowId: '123', processId: 42, processName: 'editor', idleMilliseconds: 12, other: 'private'})), {
    windowId: '123', processId: 42, processName: 'editor', idleMilliseconds: 12,
  });
  assert.equal(parseForegroundObservation('null'), null);
});

test('reject invalid observations', () => {
  assert.throws(() => parseForegroundObservation('{"windowId":"oops","processId":1,"processName":"x","idleMilliseconds":0}'));
  assert.throws(() => parseForegroundObservation('{"windowId":"1","processId":0,"processName":"x","idleMilliseconds":0}'));
  assert.throws(() => parseForegroundObservation('garbage'));
});

test('detector is safely unavailable outside Windows and validates intervals', () => {
  assert.throws(() => new ForegroundMonitor({intervalMs: 0, onObservation() {}}), RangeError);
  if (process.platform !== 'win32') {
    const detector = new ForegroundMonitor({onObservation() { assert.fail('unexpected observation'); }});
    assert.equal(detector.start(), false);
    detector.stop();
  }
});
