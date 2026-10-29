import { describe, expect, it } from 'vitest';
import { cleanSettings, DEFAULT_SETTINGS, restoreSettings } from '../src/settings';

describe('onboarding settings', () => {
  it('starts a new installation with onboarding incomplete', () => {
    const next = cleanSettings({});
    expect(next.language).toBe('en');
    expect(next.onboardingComplete).toBe(false);
    expect(next.discordClientId).toBe('');
  });

  it('migrates a configured old installation and preserves an unfinished explicit setup', () => {
    const old = restoreSettings({ discordClientId: '123456789012345678', excludedApps: ['EDITOR.EXE'] });
    expect(old.onboardingComplete).toBe(true);
    expect(old.excludedApps).toEqual(['editor.exe']);
    expect(restoreSettings({ discordClientId: '' }).onboardingComplete).toBe(false);
    expect(restoreSettings({ discordClientId: '123456789012345678', onboardingComplete: false }).onboardingComplete).toBe(false);
  });

  it('persists Korean and completion through a JSON save and reload', () => {
    const saved = cleanSettings({ ...DEFAULT_SETTINGS, language: 'ko', onboardingComplete: true, discordClientId: '123456789012345678' });
    const loaded = restoreSettings(JSON.parse(JSON.stringify(saved)));
    expect(loaded.language).toBe('ko');
    expect(loaded.onboardingComplete).toBe(true);
    expect(loaded.discordClientId).toBe('123456789012345678');
    expect(cleanSettings({ ...loaded, language: 'en' }).language).toBe('en');
  });

  it('uses safe defaults for invalid language, ID and onboarding types', () => {
    const result = restoreSettings({ language: 'fr', discordClientId: 'bad', onboardingComplete: 'true', detectionIntervalMs: -1 });
    expect(result.language).toBe('en');
    expect(result.discordClientId).toBe('');
    expect(result.onboardingComplete).toBe(false);
    expect(result.detectionIntervalMs).toBe(1000);
    expect(() => restoreSettings(null)).toThrow('Invalid settings');
  });
});
