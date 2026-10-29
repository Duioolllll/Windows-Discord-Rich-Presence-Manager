import { normalizeDomain, validateRule, type ActivityRule } from './core';

export type Settings = {
  autoStart: boolean; minimizeToTray: boolean; discordReconnect: boolean; idleEnabled: boolean;
  detectionIntervalMs: number; theme: 'system' | 'light' | 'dark'; language: 'en' | 'ko'; onboardingComplete: boolean; discordClientId: string;
  excludedApps: string[]; excludedDomains: string[]; detailedDomains: string[]; disabledAdapters: string[]; rules: ActivityRule[];
};
export const DEFAULT_SETTINGS: Settings = { autoStart: false, minimizeToTray: true, discordReconnect: true, idleEnabled: false, detectionIntervalMs: 1000, theme: 'system', language: 'en', onboardingComplete: false, discordClientId: '', excludedApps: [], excludedDomains: [], detailedDomains: [], disabledAdapters: [], rules: [] };
export function cleanSettings(input: unknown, fallbackOnboardingComplete = false): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings');
  const v = input as Record<string, unknown>;
  const bool = (key: keyof Settings) => typeof v[key] === 'boolean' ? v[key] as boolean : DEFAULT_SETTINGS[key] as boolean;
  const list = (key: keyof Settings, domain = false): string[] => {
    const raw = v[key]; if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 255 && !/[\x00-\x1f]/.test(x)).map(x => x.toLowerCase()).filter(x => !domain || normalizeDomain(x) !== null))].slice(0, 200);
  };
  const interval = typeof v.detectionIntervalMs === 'number' && Number.isInteger(v.detectionIntervalMs) && v.detectionIntervalMs >= 250 && v.detectionIntervalMs <= 10000 ? v.detectionIntervalMs : 1000;
  const id = typeof v.discordClientId === 'string' && (/^\d{15,20}$/.test(v.discordClientId) || v.discordClientId === '') ? v.discordClientId : '';
  const rules = Array.isArray(v.rules) ? v.rules.filter(validateRule).slice(0, 200) : [];
  return { autoStart: bool('autoStart'), minimizeToTray: bool('minimizeToTray'), discordReconnect: bool('discordReconnect'), idleEnabled: bool('idleEnabled'), detectionIntervalMs: interval, theme: v.theme === 'dark' || v.theme === 'light' ? v.theme : 'system', language: v.language === 'ko' ? 'ko' : 'en', onboardingComplete: typeof v.onboardingComplete === 'boolean' ? v.onboardingComplete : fallbackOnboardingComplete, discordClientId: id, excludedApps: list('excludedApps'), excludedDomains: list('excludedDomains', true), detailedDomains: list('detailedDomains', true), disabledAdapters: list('disabledAdapters'), rules };
}
/** Migrate pre-onboarding settings without interrupting existing configured users. */
export function restoreSettings(input: unknown): Settings {
  const id = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>).discordClientId : undefined;
  return cleanSettings(input, typeof id === 'string' && /^\d{15,20}$/.test(id));
}
