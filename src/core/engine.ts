import type { Activity, ActivityCandidate, ActivitySnapshot, ActivitySource } from './types.js';

const priority: Record<ActivitySource, number> = {
  'desktop-confirmed': 5, 'browser-confirmed': 4, 'browser-domain': 3, desktop: 2, unknown: 1,
};
function key(activity: Activity | null): string {
  return activity ? JSON.stringify([activity.application, activity.details, activity.state ?? null, activity.imageKey ?? null, activity.confidence]) : '';
}
function select(snapshot: ActivitySnapshot): ActivityCandidate | null {
  if (snapshot.paused || (snapshot.idleDetectionEnabled && snapshot.idle) || !snapshot.foregroundWindowId) return null;
  return snapshot.candidates
    .filter(c => c.windowId === snapshot.foregroundWindowId && c.activity.application && c.activity.details &&
      ((c.source !== 'desktop-confirmed' && c.source !== 'browser-confirmed') || c.activity.confidence === 'confirmed'))
    .reduce<ActivityCandidate | null>((best, candidate) => !best || priority[candidate.source] > priority[best.source] ? candidate : best, null);
}

export interface EngineResult { activity: Activity | null; changed: boolean; }
/** Feed complete snapshots after every observation and again at the pending deadline. */
export class ActivityEngine {
  private current: Activity | null = null;
  private windowId: string | null = null;
  private pendingKey = '';
  private pendingSince = 0;
  constructor(private readonly debounceMs = 1000) {
    if (!Number.isFinite(debounceMs) || debounceMs < 0) throw new Error('Invalid debounce duration');
  }
  evaluate(snapshot: ActivitySnapshot, now = Date.now()): EngineResult {
    if (!Number.isFinite(now)) throw new Error('Invalid time');
    const previous = key(this.current);
    const candidate = select(snapshot);
    // An activity from an old foreground window must never remain published during debounce.
    if (!candidate || this.windowId !== snapshot.foregroundWindowId) {
      this.current = null;
      this.pendingKey = '';
      this.windowId = snapshot.foregroundWindowId;
    }
    if (!candidate) return { activity: null, changed: previous !== '' };
    const nextKey = key(candidate.activity);
    if (nextKey === key(this.current)) {
      this.pendingKey = '';
    } else {
      if (this.pendingKey !== nextKey || now < this.pendingSince) {
        this.pendingKey = nextKey;
        this.pendingSince = now;
      }
      if (now - this.pendingSince >= this.debounceMs) {
        // The selected interval starts at the transition, not at a source-provided timestamp.
        this.current = { ...candidate.activity, startedAt: this.pendingSince };
        this.pendingKey = '';
      }
    }
    return { activity: this.current ? { ...this.current } : null, changed: previous !== key(this.current) };
  }
  /** Milliseconds until a pending transition should be re-evaluated. */
  nextDelay(now = Date.now()): number | null {
    return this.pendingKey ? Math.max(0, this.pendingSince + this.debounceMs - now) : null;
  }
}
