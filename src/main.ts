import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ActivityEngine, applyRules, detectSiteActivity, normalizeDomain, validateRule, matchesRule, type Activity, type ActivityCandidate, type ActivityRule, type RuleContext } from './core';
import { ForegroundMonitor, type ForegroundObservation } from './windows/foreground';
import { DiscordPresence, type DiscordStatus } from './discord';
import { startBrowserServer } from './native/server';
import type { BrowserMessage, BrowserName, BrowserSignal } from './native/protocol';
import type { Server } from 'node:net';

type Settings = {
  autoStart: boolean; minimizeToTray: boolean; discordReconnect: boolean; idleEnabled: boolean;
  detectionIntervalMs: number; theme: 'system' | 'light' | 'dark'; language: string; discordClientId: string;
  excludedApps: string[]; excludedDomains: string[]; detailedDomains: string[]; disabledAdapters: string[]; rules: ActivityRule[];
};
const defaults: Settings = { autoStart: false, minimizeToTray: true, discordReconnect: true, idleEnabled: false, detectionIntervalMs: 1000, theme: 'system', language: 'en', discordClientId: '', excludedApps: [], excludedDomains: [], detailedDomains: [], disabledAdapters: [], rules: [] };
let settings: Settings = { ...defaults }, paused = false, quitting = false;
let window: BrowserWindow | null = null, tray: Tray | null = null, monitor: ForegroundMonitor | null = null, server: Server | null = null, rpc: DiscordPresence | null = null;
let discordStatus: DiscordStatus = 'stopped', foreground: ForegroundObservation | null = null, activity: Activity | null = null;
const browserMessages = new Map<BrowserName, {message: Extract<BrowserMessage,{kind:'activity'}>, at: number}>();
const engine = new ActivityEngine(1000);
const detectedApps: string[] = [], events: string[] = [];
let timer: NodeJS.Timeout | null = null;

function cleanSettings(input: unknown): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings');
  const v = input as Record<string, unknown>;
  const bool = (key: keyof Settings) => typeof v[key] === 'boolean' ? v[key] as boolean : defaults[key] as boolean;
  const list = (key: keyof Settings, domain = false): string[] => {
    const raw = v[key]; if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 255 && !/[\x00-\x1f]/.test(x)).map(x => x.toLowerCase()).filter(x => !domain || normalizeDomain(x) !== null))].slice(0, 200);
  };
  const interval = typeof v.detectionIntervalMs === 'number' && Number.isInteger(v.detectionIntervalMs) && v.detectionIntervalMs >= 250 && v.detectionIntervalMs <= 10000 ? v.detectionIntervalMs : 1000;
  const id = typeof v.discordClientId === 'string' && (/^\d{15,20}$/.test(v.discordClientId) || v.discordClientId === '') ? v.discordClientId : '';
  const rules = Array.isArray(v.rules) ? v.rules.filter(validateRule).slice(0, 200) : [];
  return { autoStart: bool('autoStart'), minimizeToTray: bool('minimizeToTray'), discordReconnect: bool('discordReconnect'), idleEnabled: bool('idleEnabled'), detectionIntervalMs: interval, theme: v.theme === 'dark' || v.theme === 'light' ? v.theme : 'system', language: 'en', discordClientId: id, excludedApps: list('excludedApps'), excludedDomains: list('excludedDomains', true), detailedDomains: list('detailedDomains', true), disabledAdapters: list('disabledAdapters'), rules };
}
function state() { return { settings, paused, activity, discordConnected: discordStatus === 'connected', browserConnected: [...browserMessages.values()].some(x => Date.now() - x.at < 15000), detectedApps, events, diagnostics: { engineReady: true, windowsAvailable: !!monitor, platform: process.platform, detector: monitor ? 'started' : 'unavailable', discord: discordStatus, browser: server ? 'listening' : 'unavailable' } }; }
function publish() { if (window && !window.isDestroyed()) window.webContents.send('state:changed', state()); }
function isDomainIn(domain: string, list: string[]) { return list.some(d => domain === d || domain.endsWith('.' + d)); }
function browserFor(name: string): BrowserName | null { const n = name.toLowerCase().replace(/\.exe$/, ''); return n === 'chrome' ? 'chrome' : n === 'msedge' ? 'edge' : n === 'firefox' ? 'firefox' : null; }
function detailsForSignal(signal: BrowserSignal | undefined): {details: string; application: string} | null {
  const map: Partial<Record<BrowserSignal, {details:string; application:string}>> = {
    'github-repository': {application:'GitHub',details:'Browsing a repository'}, 'github-issue': {application:'GitHub',details:'Viewing issues'}, 'github-pull-request': {application:'GitHub',details:'Viewing pull requests'}, 'github-code': {application:'GitHub',details:'Browsing code'}, 'github-actions': {application:'GitHub',details:'Viewing Actions'}, 'figma-file': {application:'Figma',details:'Viewing a design file'}, 'figma-prototype': {application:'Figma',details:'Viewing a prototype'}, 'youtube-playing': {application:'YouTube',details:'Watching a video'}, 'youtube-paused': {application:'YouTube',details:'Video paused'}, 'youtube-playlist': {application:'YouTube',details:'Browsing a playlist'}, 'google-docs-document': {application:'Google Docs',details:'Working in Google Docs'}
  }; return signal ? map[signal] ?? null : null;
}
function refresh() {
  if (timer) clearTimeout(timer); timer = null;
  const candidates: ActivityCandidate[] = [];
  let context: RuleContext = { detailedAllowed: false, titleAllowed: false };
  if (foreground) {
    const name = foreground.processName;
    context = { executableName: name, application: name, detailedAllowed: false, titleAllowed: false };
    if (!settings.excludedApps.some(x => x.replace(/\.exe$/, '') === name.toLowerCase().replace(/\.exe$/, ''))) {
      let a: Activity = { application: name, details: `Using ${name}`, confidence: 'generic' };
      const browser = browserFor(name), entry = browser && browserMessages.get(browser);
      let source: ActivityCandidate['source'] = 'desktop';
      if (entry && Date.now() - entry.at < 15000 && !isDomainIn(entry.message.domain, settings.excludedDomains)) {
        const domain = entry.message.domain, allowed = isDomainIn(domain, settings.detailedDomains);
        context = { ...context, domain, detailedAllowed: allowed };
        a = detectSiteActivity({domain, detailedAllowed: false}, settings.disabledAdapters) ?? a;
        source = 'browser-domain';
        const detail = allowed && entry.message.signal ? detailsForSignal(entry.message.signal) : null;
        if (detail && !settings.disabledAdapters.includes(detail.application.toLowerCase())) { a = { ...detail, confidence: 'confirmed' }; source = 'browser-confirmed'; }
      } else if (entry && Date.now() - entry.at < 15000 && isDomainIn(entry.message.domain, settings.excludedDomains)) {
        // Excluded domains must not be replaced by generic browser activity.
        a = null as unknown as Activity;
      }
      if (a) { const custom = applyRules(settings.rules, context, a); if (custom !== null) candidates.push({windowId: foreground.windowId, source, activity: custom ?? a}); }
    }
  }
  const result = engine.evaluate({ foregroundWindowId: foreground?.windowId ?? null, candidates, paused, idleDetectionEnabled: settings.idleEnabled, idle: !!foreground && foreground.idleMilliseconds >= 300000 });
  activity = result.activity; if (result.changed) { rpc?.setActivity(activity); events.unshift(activity ? `Activity: ${activity.application}` : 'Activity cleared'); events.splice(20); }
  publish(); const delay = engine.nextDelay(); if (delay !== null) timer = setTimeout(refresh, Math.max(delay, 1));
}
function startMonitor() {
  monitor?.stop(); monitor = new ForegroundMonitor({intervalMs: settings.detectionIntervalMs, onObservation(value) { foreground = value; if (value && !detectedApps.includes(value.processName)) {detectedApps.unshift(value.processName); detectedApps.splice(30);} refresh(); }, onError() { foreground = null; refresh(); }});
  if (!monitor.start()) monitor = null;
}
async function configureDiscord() {
  await rpc?.stop(); rpc = null; discordStatus = 'stopped';
  if (settings.discordClientId) { rpc = new DiscordPresence({clientId: settings.discordClientId, reconnect: settings.discordReconnect, onStatus(status) {discordStatus = status; publish();}}); rpc.setActivity(activity); rpc.start(); }
}
function createWindow() {
  window = new BrowserWindow({ width: 1200, height: 800, minWidth: 780, minHeight: 580, show: false, webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(join(__dirname, 'ui', 'index.html')); window.once('ready-to-show', () => window?.show());
  window.on('close', event => { if (!quitting && settings.minimizeToTray && tray) { event.preventDefault(); window?.hide(); }});
  window.on('closed', () => { window = null; });
}
async function main() {
  try { settings = cleanSettings(JSON.parse(await readFile(join(app.getPath('userData'), 'settings.json'), 'utf8'))); } catch { settings = { ...defaults }; }
  createWindow();
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVQ4T2NkoBAwUqifgboGhjGqGQ0YAAB5JwIRcGvkdQAAAABJRU5ErkJggg==');
  try { tray = new Tray(icon); tray.setToolTip('AutoPresence'); tray.setContextMenu(Menu.buildFromTemplate([{label:'Open', click: () => window?.show()}, {label:'Pause / Resume', click: () => {paused = !paused; refresh();}}, {label:'Quit', click: () => {quitting = true; app.quit();}}])); tray.on('double-click', () => window?.show()); } catch { tray = null; }
  ipcMain.handle('state:get', () => state());
  ipcMain.handle('settings:save', async (_e, value: unknown) => { const next = cleanSettings(value); await writeFile(join(app.getPath('userData'), 'settings.json'), JSON.stringify(next, null, 2), {mode:0o600}); settings = next; if (process.platform === 'win32' && app.isPackaged) app.setLoginItemSettings({openAtLogin: settings.autoStart}); startMonitor(); await configureDiscord(); refresh(); return state(); });
  ipcMain.handle('activity:pause', (_e, value: unknown) => { if (typeof value !== 'boolean') throw new Error('Invalid pause state'); paused = value; refresh(); return state(); });
  ipcMain.handle('rule:test', (_e, value: unknown) => { if (!validateRule(value)) return {matches: false, message: 'Invalid rule.'}; const browser = foreground && browserFor(foreground.processName); const entry = browser && browserMessages.get(browser); const domain = entry && Date.now() - entry.at < 15000 ? entry.message.domain : undefined; const context: RuleContext = {executableName: foreground?.processName, application: foreground?.processName, domain, detailedAllowed: !!domain && isDomainIn(domain, settings.detailedDomains), titleAllowed: false}; const matches = matchesRule(value, context); return {matches, message: matches ? 'Rule matches the current observation.' : 'Rule does not match the current observation; path and title are unavailable.'}; });
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
  startMonitor(); await configureDiscord();
  try { server = await startBrowserServer(message => { if (message.kind === 'clear') browserMessages.delete(message.browser); else browserMessages.set(message.browser, {message, at: Date.now()}); refresh(); }); } catch { server = null; }
  refresh();
}
app.whenReady().then(main).catch(() => app.quit());
app.on('window-all-closed', () => { if (!tray || !settings.minimizeToTray) app.quit(); });
app.on('before-quit', () => { quitting = true; monitor?.stop(); server?.close(); void rpc?.stop(); if (timer) clearTimeout(timer); });
