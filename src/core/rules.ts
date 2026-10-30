import { normalizeDomain } from './adapters.js';
import { validateImageReference } from './image.js';
import type { Activity } from './types.js';

export interface RuleMatch {
  executableName?: string;
  executablePath?: string;
  application?: string;
  domain?: string;
  pathPattern?: string;
  titlePattern?: string;
  activityType?: string;
}
export interface ActivityRule {
  id: string;
  enabled: boolean;
  match: RuleMatch;
  presence: { details: string; state?: string; imageKey?: string; application?: string };
  exclude?: boolean;
}
export interface RuleContext {
  executableName?: string;
  executablePath?: string;
  application?: string;
  domain?: string;
  path?: string;
  title?: string;
  activityType?: string;
  detailedAllowed: boolean;
  titleAllowed: boolean;
}

/** Simple wildcard only: no regular expressions, code execution, or unbounded patterns. */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern.length > 256 || value.length > 2048) return false;
  const p = pattern.toLowerCase(), v = value.toLowerCase();
  let i = 0, j = 0, star = -1, retry = 0;
  while (j < v.length) {
    if (i < p.length && p[i] === v[j]) { i++; j++; }
    else if (p[i] === '*') { star = i++; retry = j; }
    else if (star !== -1) { i = star + 1; j = ++retry; }
    else return false;
  }
  while (p[i] === '*') i++;
  return i === p.length;
}
const allowedMatch = new Set(['executableName', 'executablePath', 'application', 'domain', 'pathPattern', 'titlePattern', 'activityType']);
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validateRule(value: unknown): value is ActivityRule {
  if (!isRecord(value) || !isRecord(value.match) || !isRecord(value.presence)) return false;
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) || typeof value.enabled !== 'boolean') return false;
  if (value.exclude !== undefined && typeof value.exclude !== 'boolean') return false;
  const entries = Object.entries(value.match);
  if (!entries.length || entries.some(([k,v]) => !allowedMatch.has(k) || typeof v !== 'string' || v.length < 1 || v.length > 256 || /[\u0000-\u001f]/.test(v))) return false;
  if (typeof value.match.domain === 'string' && !normalizeDomain(value.match.domain)) return false;
  if (typeof value.match.pathPattern === 'string' && (!value.match.pathPattern.startsWith('/') || /[?#]/.test(value.match.pathPattern))) return false;
  if (value.presence.application !== undefined && (typeof value.presence.application !== 'string' || !value.presence.application.trim())) return false;
  if (typeof value.presence.details !== 'string' || !value.presence.details.trim() || value.presence.details.length > 128 || /[\u0000-\u001f]/.test(value.presence.details)) return false;
  if (value.presence.imageKey !== undefined && !validateImageReference(value.presence.imageKey)) return false;
  for (const name of ['state', 'application']) {
    const field = value.presence[name];
    if (field !== undefined && (typeof field !== 'string' || field.length > 128 || /[\u0000-\u001f]/.test(field))) return false;
  }
  return true;
}
export function matchesRule(rule: ActivityRule, context: RuleContext): boolean {
  if (!validateRule(rule) || !rule.enabled) return false;
  const m = rule.match;
  const eq = (a: string | undefined, b: string | undefined) => a === undefined || (b !== undefined && a.toLowerCase() === b.toLowerCase());
  const executable = (v: string | undefined) => v?.toLowerCase().replace(/\.exe$/, '');
  if (!eq(executable(m.executableName), executable(context.executableName)) || !eq(m.executablePath, context.executablePath) ||
      !eq(m.application, context.application) || !eq(m.activityType, context.activityType)) return false;
  if (m.domain) {
    const domain = context.domain && normalizeDomain(context.domain);
    const expected = normalizeDomain(m.domain);
    if (!domain || !expected || (domain !== expected && !domain.endsWith('.' + expected))) return false;
  }
  if (m.pathPattern && (!context.detailedAllowed || !context.path || !wildcardMatch(m.pathPattern, context.path.split(/[?#]/, 1)[0]))) return false;
  if (m.titlePattern && (!context.titleAllowed || !context.title || !wildcardMatch(m.titlePattern, context.title))) return false;
  return true;
}
/** First matching rule wins. Null means explicitly excluded; undefined means no match. */
export function applyRules(rules: readonly ActivityRule[], context: RuleContext, base: Activity): Activity | null | undefined {
  const rule = rules.find(r => matchesRule(r, context));
  if (!rule) return undefined;
  if (rule.exclude) return null;
  return { ...base, ...rule.presence, confidence: base.confidence };
}
