/* The only messages leaving the extension contain a host name and, when explicitly
 * enabled, a small predefined activity label. Never send a URL or a page title. */
'use strict';
const api = globalThis.browser || globalThis.chrome;
const browserName = /Firefox\//.test(navigator.userAgent) ? 'firefox' : (/Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome');
const nativeName = 'com.autopresence.browser';
let port;
let generation = 0;
let media = null;
let injectedKey = null;
let previous = '';
let lastSent = 0;
function connect() {
  if (port) return port;
  try {
    const current = api.runtime.connectNative(nativeName);
    port = current;
    current.onDisconnect.addListener(() => { if (port === current) port = null; });
    return current;
  } catch { return null; }
}
function post(message) {
  const now = Date.now();
  const serialized = JSON.stringify(message);
  if (serialized === previous && now - lastSent < 5000) return;
  try {
    const p = connect();
    if (p) { p.postMessage(message); previous = serialized; lastSent = now; }
  } catch { port = null; }
}
const clear = () => post({ version: 1, kind: 'clear', browser: browserName });
const belongs = (host, domain) => host === domain || host.endsWith('.' + domain);
function classify(host, path, enabled, playback) {
  if (belongs(host, 'github.com') && enabled.includes('github.com')) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 2) {
      if (parts[2] === 'issues') return 'github-issue';
      if (parts[2] === 'pull' || parts[2] === 'pulls') return 'github-pull-request';
      if (parts[2] === 'actions') return 'github-actions';
      if (parts[2] === 'blob' || parts[2] === 'tree') return 'github-code';
      // A two-segment GitHub URL alone does not prove it is a repository.
    }
  }
  if (belongs(host, 'figma.com') && enabled.includes('figma.com')) {
    if (/^\/proto\//.test(path)) return 'figma-prototype';
    if (/^\/(?:design|file)\//.test(path)) return 'figma-file';
  }
  if (belongs(host, 'youtube.com') && enabled.includes('youtube.com')) {
    if (path === '/watch' && playback === 'playing') return 'youtube-playing';
    if (path === '/watch' && playback === 'paused') return 'youtube-paused';
    if (path === '/playlist') return 'youtube-playlist';
  }
  if (host === 'docs.google.com' && enabled.includes('docs.google.com') && /^\/document\//.test(path)) return 'google-docs-document';
  return undefined;
}
async function refresh() {
  const current = ++generation;
  try {
    const window = await api.windows.getLastFocused({ populate: true });
    if (current !== generation) return;
    const tab = window?.tabs?.find(t => t.active);
    if (!window?.focused || !tab || tab.incognito || typeof tab.url !== 'string') { media = null; clear(); return; }
    const url = new URL(tab.url);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) { media = null; clear(); return; }
    const host = url.hostname.toLowerCase();
    const stored = await api.storage.local.get('detailDomains');
    if (current !== generation) return;
    const enabled = Array.isArray(stored.detailDomains) ? stored.detailDomains.filter(s => typeof s === 'string') : [];
    if (!media || media.tabId !== tab.id || media.url !== tab.url) media = null;
    const signal = classify(host, url.pathname, enabled, media?.status);
    post({ version: 1, kind: 'activity', browser: browserName, domain: host, ...(signal ? { signal } : {}) });
    if (enabled.includes('youtube.com') && belongs(host, 'youtube.com') && url.pathname === '/watch' && Number.isInteger(tab.id)) {
      const hasPermission = await api.permissions.contains({ origins: ['https://*.youtube.com/*'] });
      const key = `${tab.id}:${tab.url}`;
      if (hasPermission && injectedKey !== key && current === generation) {
        injectedKey = key;
        try {
          if (api.scripting) await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['youtube.js'] });
          else await api.tabs.executeScript(tab.id, { file: 'youtube.js' });
        } catch { if (injectedKey === key) injectedKey = null; /* restricted page or navigated tab */ }
      }
    }
  } catch { if (current === generation) clear(); }
}
api.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'youtube-media' || !['playing', 'paused'].includes(message.status) || !sender.tab?.active || sender.tab.incognito || typeof sender.tab.url !== 'string') return;
  try {
    const u = new URL(sender.tab.url);
    if (u.protocol !== 'https:' || !belongs(u.hostname, 'youtube.com') || u.pathname !== '/watch') return;
    media = { tabId: sender.tab.id, url: sender.tab.url, status: message.status };
    void refresh();
  } catch { /* invalid sender URL */ }
});
api.tabs.onActivated.addListener(() => { media = null; void refresh(); });
api.tabs.onUpdated.addListener((_id, change, tab) => { if (tab.active && (change.url || change.status === 'complete')) { media = null; injectedKey = null; void refresh(); } });
api.windows.onFocusChanged.addListener(() => { media = null; void refresh(); });
api.storage.onChanged.addListener(() => { media = null; previous = ''; void refresh(); });
void refresh();
setInterval(() => { void refresh(); }, 5000);
