import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ActivityEngine, applyRules, eligibleProcesses, runningActivity, selectRunningProcess, validateRule, matchesRule, type Activity, type ActivityCandidate, type RuleContext } from './core';
import { ForegroundMonitor, type ForegroundObservation } from './windows/foreground';
import { DiscordPresence, type DiscordStatus } from './discord';
import { RunningProcessMonitor, type RunningProcess } from './windows/running';
import { DEFAULT_SETTINGS, cleanSettings, restoreSettings, type Settings } from './settings';

let settings: Settings = { ...DEFAULT_SETTINGS }, paused = false, quitting = false;
let window: BrowserWindow | null = null, tray: Tray | null = null, monitor: ForegroundMonitor | null = null, runningMonitor: RunningProcessMonitor | null = null, rpc: DiscordPresence | null = null;
let discordStatus: DiscordStatus = 'stopped', foreground: ForegroundObservation | null = null, activity: Activity | null = null;
let runningProcesses: RunningProcess[] | null = null;
let selectedPid: number | null = null;
const engine = new ActivityEngine(1000);
const events: string[] = [];
let timer: NodeJS.Timeout | null = null, monitorRetry: NodeJS.Timeout | null = null;
let shutdownStarted = false, shutdownComplete = false;

function state() {
  const visible = eligibleProcesses(runningProcesses ?? [], settings.excludedApps, process.pid);
  const detectedApps = [...new Set(visible.map(item => runningActivity(item).application))].sort((a, b) => a.localeCompare(b));
  return { settings, paused, activity, discordConnected: discordStatus === 'connected', discordStatus, browserConnected: false, browserDisabled: true, detectedApps, events, diagnostics: { engineReady: true, windowsAvailable: !!runningMonitor && runningProcesses !== null, platform: process.platform, detector: runningMonitor ? 'started' : 'unavailable', discord: discordStatus, browser: 'disabled' } };
}
function publish() { if (window && !window.isDestroyed()) window.webContents.send('state:changed', state()); }
function refresh() {
  if (timer) clearTimeout(timer); timer = null;
  const eligible = eligibleProcesses(runningProcesses ?? [], settings.excludedApps, process.pid);
  // Apply user exclusions before selecting; an excluded process must not hide others.
  const activities = new Map<number, Activity>();
  for (const item of eligible) {
    const base = runningActivity(item);
    const context: RuleContext = {executableName: item.processName, application: base.application, detailedAllowed: false, titleAllowed: false};
    const custom = applyRules(settings.rules, context, base);
    if (custom !== null) activities.set(item.processId, custom ?? base);
  }
  const selectable = eligible.filter(item => activities.has(item.processId));
  const selected = selectRunningProcess(selectable, foreground?.processId ?? null, selectedPid);
  selectedPid = selected?.processId ?? null;
  const identity = selected ? `process:${selected.processId}:${selected.startedAt ?? 'unknown'}` : null;
  const candidates: ActivityCandidate[] = selected && identity
    ? [{windowId: identity, source: 'desktop', activity: activities.get(selected.processId)!}] : [];
  const result = engine.evaluate({ foregroundWindowId: identity, candidates, paused: paused || !settings.onboardingComplete, idleDetectionEnabled: settings.idleEnabled, idle: !foreground || foreground.idleMilliseconds >= 300000 });
  activity = result.activity;
  if (result.changed) { rpc?.setActivity(activity); events.unshift(activity ? `Activity: ${activity.application}` : 'Activity cleared'); events.splice(20); }
  publish(); const delay = engine.nextDelay(); if (delay !== null) timer = setTimeout(refresh, Math.max(delay, 1));
}
function retryMonitors() {
  if (!quitting && !monitorRetry) monitorRetry = setTimeout(() => { monitorRetry = null; startMonitor(); }, 5000);
}
function startMonitor() {
  if (monitorRetry) { clearTimeout(monitorRetry); monitorRetry = null; }
  monitor?.stop(); runningMonitor?.stop(); foreground = null; runningProcesses = null; selectedPid = null;
  monitor = new ForegroundMonitor({intervalMs: settings.detectionIntervalMs, onObservation(value) { foreground = value; refresh(); }, onError() { foreground = null; refresh(); retryMonitors(); }});
  if (!monitor.start()) monitor = null;
  runningMonitor = new RunningProcessMonitor({intervalMs: Math.max(1000, settings.detectionIntervalMs), onObservation(value) { runningProcesses = value; refresh(); }, onError() { runningProcesses = null; refresh(); retryMonitors(); }});
  if (!runningMonitor.start()) runningMonitor = null;
  refresh();
}
async function configureDiscord() {
  await rpc?.stop(); rpc = null; discordStatus = 'stopped';
  if (settings.discordClientId) { rpc = new DiscordPresence({clientId: settings.discordClientId, reconnect: settings.discordReconnect, onStatus(status) {discordStatus = status; publish();}}); rpc.setActivity(activity); rpc.start(); }
}
function createWindow() {
  window = new BrowserWindow({ width: 1200, height: 800, minWidth: 780, minHeight: 580, show: false, icon: join(__dirname, 'assets', 'icon.png'), webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(join(__dirname, 'ui', 'index.html')); window.once('ready-to-show', () => window?.show());
  window.on('close', event => { if (!quitting && settings.minimizeToTray && tray) { event.preventDefault(); window?.hide(); }});
  window.on('closed', () => { window = null; });
}
async function main() {
  try {
    const saved: unknown = JSON.parse(await readFile(join(app.getPath('userData'), 'settings.json'), 'utf8'));
    settings = restoreSettings(saved);
  } catch { settings = { ...DEFAULT_SETTINGS }; }
  createWindow();
  const icon = nativeImage.createFromPath(join(__dirname, 'assets', 'icon.png'));
  try { tray = new Tray(icon); tray.setToolTip('AutoPresence'); tray.setContextMenu(Menu.buildFromTemplate([{label:'Open', click: () => window?.show()}, {label:'Pause / Resume', click: () => {paused = !paused; refresh();}}, {label:'Quit', click: () => {quitting = true; app.quit();}}])); tray.on('double-click', () => window?.show()); } catch { tray = null; }
  ipcMain.handle('state:get', () => state());
  ipcMain.handle('settings:save', async (_e, value: unknown) => { const next = cleanSettings(value, settings.onboardingComplete); const previous = settings; await writeFile(join(app.getPath('userData'), 'settings.json'), JSON.stringify(next, null, 2), {mode:0o600}); settings = next; if (process.platform === 'win32' && app.isPackaged && previous.autoStart !== next.autoStart) app.setLoginItemSettings({openAtLogin: settings.autoStart}); if (previous.detectionIntervalMs !== next.detectionIntervalMs) startMonitor(); if (previous.discordClientId !== next.discordClientId || previous.discordReconnect !== next.discordReconnect || (next.discordClientId && discordStatus === 'disconnected')) await configureDiscord(); refresh(); return state(); });
  ipcMain.handle('activity:pause', (_e, value: unknown) => { if (typeof value !== 'boolean') throw new Error('Invalid pause state'); paused = value; refresh(); return state(); });
  ipcMain.handle('rule:test', (_e, value: unknown) => { if (!validateRule(value)) return {matches: false, message: 'Invalid rule.'}; const selected = runningProcesses?.find(item => item.processId === selectedPid); const context: RuleContext = {executableName: selected?.processName, application: selected ? runningActivity(selected).application : undefined, detailedAllowed: false, titleAllowed: false}; const matches = matchesRule(value, context); return {matches, message: matches ? 'Rule matches the current observation.' : 'Rule does not match the current observation; path and title are unavailable.'}; });
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
  startMonitor(); await configureDiscord();
  refresh();
}
app.whenReady().then(main).catch(() => app.quit());
app.on('window-all-closed', () => { if (!tray || !settings.minimizeToTray) app.quit(); });
app.on('before-quit', event => {
  quitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  monitor?.stop(); runningMonitor?.stop();
  if (timer) clearTimeout(timer);
  if (monitorRetry) clearTimeout(monitorRetry);
  void Promise.resolve(rpc?.stop()).catch(() => {}).finally(() => { shutdownComplete = true; app.quit(); });
});
