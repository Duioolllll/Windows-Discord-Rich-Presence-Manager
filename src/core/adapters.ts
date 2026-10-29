import type { Activity, ActivityAdapter, ActivityContext } from './types.js';

/** Domain names only; reject URLs, credentials, whitespace, Unicode and malformed labels. */
export function normalizeDomain(value: string): string | null {
  const domain = value.toLowerCase().replace(/\.$/, '');
  if (domain.length > 253 || !domain.includes('.') || !/^[a-z0-9.-]+$/.test(domain)) return null;
  if (!domain.split('.').every(label => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  return domain;
}
function belongs(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith('.' + parent);
}
function activity(application: string, details: string, confidence: Activity['confidence'] = 'generic'): Activity {
  return { application, details, confidence };
}
function pathname(context: ActivityContext): string {
  if (!context.detailedAllowed || !context.path || !context.path.startsWith('/') || context.path.length > 2048) return '';
  // Never use a query, fragment, or raw path in the returned activity.
  return context.path.split(/[?#]/, 1)[0];
}
const adapters: ActivityAdapter[] = [
  {
    id: 'github', matches: c => belongs(c.domain, 'github.com'), detect: c => {
      const p = pathname(c);
      if (/^\/[^/]+\/[^/]+\/pull(?:\/|$)/i.test(p)) return activity('GitHub', 'Viewing pull requests', 'confirmed');
      if (/^\/[^/]+\/[^/]+\/issues(?:\/|$)/i.test(p)) return activity('GitHub', 'Viewing issues', 'confirmed');
      if (/^\/[^/]+\/[^/]+\/actions(?:\/|$)/i.test(p)) return activity('GitHub', 'Viewing Actions', 'confirmed');
      if (/^\/[^/]+\/[^/]+\/(?:blob|tree)(?:\/|$)/i.test(p)) return activity('GitHub', 'Browsing code', 'confirmed');
      return activity('GitHub', 'Browsing GitHub');
    },
  },
  {
    id: 'figma', matches: c => belongs(c.domain, 'figma.com'), detect: c => {
      if (c.detailedAllowed && c.signals?.prototype) return activity('Figma', 'Viewing a prototype', 'confirmed');
      if (c.detailedAllowed && c.signals?.editing) return activity('Figma', 'Editing a design', 'confirmed');
      if (/^\/(?:design|file)\//i.test(pathname(c))) return activity('Figma', 'Viewing a design file', 'confirmed');
      return activity('Figma', 'Using Figma');
    },
  },
  {
    id: 'notion', matches: c => belongs(c.domain, 'notion.so') || belongs(c.domain, 'notion.site'), detect: c => {
      if (c.detailedAllowed && c.signals?.editing) return activity('Notion', 'Editing a document', 'confirmed');
      if (c.detailedAllowed && c.signals?.database) return activity('Notion', 'Viewing a database', 'confirmed');
      return activity('Notion', 'Using Notion');
    },
  },
  {
    id: 'youtube', matches: c => belongs(c.domain, 'youtube.com') || belongs(c.domain, 'youtu.be'), detect: c => {
      if (c.detailedAllowed && c.signals?.media === 'playing') return activity('YouTube', 'Watching a video', 'confirmed');
      if (c.detailedAllowed && c.signals?.media === 'paused') return activity('YouTube', 'Video paused', 'confirmed');
      if (/^\/playlist(?:\/|$)/i.test(pathname(c))) return activity('YouTube', 'Browsing a playlist', 'confirmed');
      return activity('YouTube', 'Using YouTube');
    },
  },
  { id: 'google-docs', matches: c => c.domain === 'docs.google.com', detect: () => activity('Google Docs', 'Working in Google Docs') },
  { id: 'chatgpt', matches: c => c.domain === 'chatgpt.com', detect: () => activity('ChatGPT', 'Using ChatGPT') },
  { id: 'canva', matches: c => belongs(c.domain, 'canva.com'), detect: () => activity('Canva', 'Using Canva') },
];

/** Disabled adapters fall back to domain-only activity. No path, title or query is published. */
export function detectSiteActivity(context: ActivityContext, disabledIds: readonly string[] = []): Activity | null {
  const domain = normalizeDomain(context.domain);
  if (!domain) return null;
  const safe = { ...context, domain };
  const adapter = adapters.find(a => !disabledIds.includes(a.id) && a.matches(safe));
  return adapter?.detect(safe) ?? activity(domain, `Browsing ${domain}`);
}
export const siteAdapterIds = Object.freeze(adapters.map(a => a.id));
