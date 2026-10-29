/** Public information eligible for publication to Discord. */
export interface Activity {
  application: string;
  details: string;
  state?: string;
  imageKey?: string;
  startedAt?: number;
  confidence: 'confirmed' | 'generic';
}

export interface SiteSignals {
  /** A media element's observed playback state, not inferred from its URL. */
  media?: 'playing' | 'paused';
  /** These must be set only by an adapter observing an explicit UI event/state. */
  editing?: boolean;
  prototype?: boolean;
  database?: boolean;
}

export interface ActivityContext {
  domain: string;
  /** Explicit, per-site user consent is required for path and DOM signals. */
  detailedAllowed: boolean;
  path?: string;
  signals?: SiteSignals;
}

export interface ActivityAdapter {
  id: string;
  matches(context: ActivityContext): boolean;
  detect(context: ActivityContext): Activity | null;
}

export type ActivitySource = 'desktop-confirmed' | 'browser-confirmed' | 'browser-domain' | 'desktop' | 'unknown';
export interface ActivityCandidate {
  /** Identity of the foreground window that generated the observation. */
  windowId: string;
  source: ActivitySource;
  activity: Activity;
}
export interface ActivitySnapshot {
  foregroundWindowId: string | null;
  candidates: readonly ActivityCandidate[];
  idle: boolean;
  idleDetectionEnabled: boolean;
  paused?: boolean;
}
