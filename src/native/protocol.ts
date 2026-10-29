/** The browser boundary intentionally never carries page titles, paths or URLs. */
export type BrowserName = 'chrome' | 'edge' | 'firefox';
export type BrowserSignal = 'github-repository' | 'github-issue' | 'github-pull-request' | 'github-code' | 'github-actions' | 'figma-file' | 'figma-prototype' | 'youtube-playing' | 'youtube-paused' | 'youtube-playlist' | 'google-docs-document';
export type BrowserMessage =
  | { version: 1; kind: 'clear'; browser: BrowserName }
  | { version: 1; kind: 'activity'; browser: BrowserName; domain: string; signal?: BrowserSignal };

const signals: Record<BrowserSignal, string[]> = {
  'github-repository': ['github.com'], 'github-issue': ['github.com'], 'github-pull-request': ['github.com'], 'github-code': ['github.com'], 'github-actions': ['github.com'],
  'figma-file': ['figma.com'], 'figma-prototype': ['figma.com'],
  'youtube-playing': ['youtube.com'], 'youtube-paused': ['youtube.com'], 'youtube-playlist': ['youtube.com'],
  'google-docs-document': ['docs.google.com'],
};

/** Reject unknown fields and invalid classifications, including raw URLs and paths. */
export function parseBrowserMessage(value: unknown): BrowserMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !['chrome', 'edge', 'firefox'].includes(v.browser as string)) return null;
  if (v.kind === 'clear') {
    if (Object.keys(v).some(k => !['version', 'kind', 'browser'].includes(k))) return null;
    return { version: 1, kind: 'clear', browser: v.browser as BrowserName };
  }
  if (v.kind !== 'activity' || Object.keys(v).some(k => !['version', 'kind', 'browser', 'domain', 'signal'].includes(k))) return null;
  if (typeof v.domain !== 'string' || v.domain.length > 253 || v.domain !== v.domain.toLowerCase() || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(v.domain)) return null;
  const domain = v.domain;
  if (v.signal !== undefined) {
    if (typeof v.signal !== 'string' || !Object.hasOwn(signals, v.signal)) return null;
    const allowed = signals[v.signal as BrowserSignal];
    if (!allowed.some(allowedDomain => domain === allowedDomain || domain.endsWith('.' + allowedDomain))) return null;
  }
  return { version: 1, kind: 'activity', browser: v.browser as BrowserName, domain: v.domain, ...(v.signal === undefined ? {} : { signal: v.signal as BrowserSignal }) };
}
