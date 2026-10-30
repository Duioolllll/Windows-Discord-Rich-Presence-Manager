import type { RunningProcess } from '../windows/running';

const hidden = new Set([
  'autopresence', 'discord', 'explorer', 'shellexperiencehost', 'startmenuexperiencehost',
  'searchhost', 'searchapp', 'textinputhost', 'applicationframehost', 'systemsettings',
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium', 'iexplore',
]);
export const normalizeExecutable = (name: string): string => name.trim().toLowerCase().replace(/\.exe$/i, '');

/** Use running GUI apps only; never attribute a background process to a browser tab. */
export function eligibleProcesses(processes: readonly RunningProcess[], excluded: readonly string[], ownPid: number): RunningProcess[] {
  const ignored = new Set(excluded.map(normalizeExecutable));
  return processes.filter(p => p.processId !== ownPid && !hidden.has(normalizeExecutable(p.processName)) && !ignored.has(normalizeExecutable(p.processName)));
}

/** Active process first, then keep previous until it exits, then newest observed app. */
export function selectRunningProcess(processes: readonly RunningProcess[], foregroundPid: number | null, previousPid: number | null): RunningProcess | null {
  const active = processes.find(p => p.processId === foregroundPid);
  if (active) return active;
  const previous = processes.find(p => p.processId === previousPid);
  if (previous) return previous;
  return [...processes].sort((a, b) => (b.startedAt ?? -1) - (a.startedAt ?? -1) || a.processName.localeCompare(b.processName, 'en', {sensitivity: 'base'}) || a.processId - b.processId)[0] ?? null;
}

// Public static logos for a small set of common apps. Discord, not the local app,
// fetches these URLs. Unlisted apps use a name and text without a claimed logo.
const ICON_BASE = 'https://raw.githubusercontent.com/github/explore/c8d7bc516928a4f17845b767884a80cc53affd57/topics';
const profiles: Record<string, { name: string; imageKey?: string }> = {
  code: { name: 'Visual Studio Code', imageKey: `${ICON_BASE}/visual-studio-code/visual-studio-code.png` },
  'code - insiders': { name: 'Visual Studio Code Insiders', imageKey: `${ICON_BASE}/visual-studio-code/visual-studio-code.png` },
  figma: { name: 'Figma', imageKey: `${ICON_BASE}/figma/figma.png` },
  notion: { name: 'Notion', imageKey: `${ICON_BASE}/notion/notion.png` },
  spotify: { name: 'Spotify', imageKey: `${ICON_BASE}/spotify/spotify.png` },
  steam: { name: 'Steam', imageKey: `${ICON_BASE}/steam/steam.png` },
  winword: { name: 'Microsoft Word' },
  excel: { name: 'Microsoft Excel' },
  powerpnt: { name: 'Microsoft PowerPoint' },
  photoshop: { name: 'Adobe Photoshop' },
};
export function runningActivity(process: RunningProcess): import('./types').Activity {
  const profile = profiles[normalizeExecutable(process.processName)];
  const name = profile?.name || process.processName.replace(/\.exe$/i, '');
  return { application: name, details: `Running ${name}`, confidence: 'generic', ...(profile?.imageKey ? {imageKey: profile.imageKey} : {}) };
}
