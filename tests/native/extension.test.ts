import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('extension/background.js', 'utf8');
async function runBackground(options: { url?: string; incognito?: boolean; focused?: boolean; domains?: string[] }) {
  const messages: unknown[] = [];
  const event = () => ({ addListener: () => {} });
  const tab = { id: 1, active: true, url: options.url ?? 'https://github.com/owner/private-repo/pull/42', incognito: options.incognito ?? false };
  const chrome = {
    windows: { getLastFocused: async () => ({ focused: options.focused ?? true, tabs: [tab] }), onFocusChanged: event() },
    tabs: { onActivated: event(), onUpdated: event() },
    runtime: { connectNative: () => ({ postMessage: (v: unknown) => messages.push(v), onDisconnect: event() }), onMessage: event() },
    storage: { local: { get: async () => ({ detailDomains: options.domains ?? [] }) }, onChanged: event() },
    permissions: { contains: async () => false },
  };
  vm.runInNewContext(source, { chrome, navigator: { userAgent: 'Chrome/140' }, URL, setInterval: () => 0, Date });
  await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
  return JSON.parse(JSON.stringify(messages[0]));
}
describe('extension privacy defaults', () => {
  it('sends only the domain by default, even when the page URL contains private information', async () => {
    expect(await runBackground({})).toEqual({ version: 1, kind: 'activity', browser: 'chrome', domain: 'github.com' });
  });
  it('sends an abstract PR signal only after opting in', async () => {
    expect(await runBackground({ domains: ['github.com'] })).toEqual({ version: 1, kind: 'activity', browser: 'chrome', domain: 'github.com', signal: 'github-pull-request' });
  });
  it('clears state for private or unfocused tabs', async () => {
    expect(await runBackground({ incognito: true })).toEqual({ version: 1, kind: 'clear', browser: 'chrome' });
    expect(await runBackground({ focused: false })).toEqual({ version: 1, kind: 'clear', browser: 'chrome' });
  });
});
