import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const html = readFileSync('src/ui/index.html', 'utf8');
const translations = readFileSync('src/ui/translations.js', 'utf8');
const application = readFileSync('src/ui/app.js', 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function launch(initial) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/' });
  let status = { settings: initial, paused: false, discordConnected: false, discordStatus: 'stopped', browserConnected: false, detectedApps: [], diagnostics: {} };
  let listener = () => {};
  const saves = [];
  dom.window.autoPresence = {
    getState: async () => status,
    onState: callback => { listener = callback; },
    saveSettings: async settings => {
      saves.push(settings);
      status = { ...status, settings, ...(settings.discordClientId && settings.discordClientId !== status.settings.discordClientId ? { discordStatus: 'connecting' } : {}) };
      listener(status);
      return status;
    },
    pause: async () => true,
    quit: async () => {},
    testRule: async () => ({ matches: false }),
  };
  dom.window.eval(translations);
  dom.window.eval(application);
  await flush();
  return { dom, document: dom.window.document, saves, update(next) { status = { ...status, ...next }; listener(status); }, current() { return status; } };
}

const initial = { language: 'en', onboardingComplete: false, discordClientId: '', discordReconnect: true };
describe('first-run language and Discord flow', () => {
  it('persists Korean, validates the ID, and waits for a confirmed connection', async () => {
    const app = await launch(initial);
    const { document: d, dom } = app;
    expect(d.querySelector('#onboarding').hidden).toBe(false);
    expect(d.querySelector('#language-step').hidden).toBe(false);
    d.querySelector('#onboarding-language').value = 'ko';
    d.querySelector('#onboarding-language').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(d.documentElement.lang).toBe('ko');
    d.querySelector('#onboarding-next').click();
    await flush();
    expect(app.current().settings.language).toBe('ko');
    const resumed = await launch(app.current().settings);
    expect(resumed.document.querySelector('#onboarding-language').value).toBe('ko');
    resumed.document.querySelector('#onboarding-next').click();
    await flush();
    expect(resumed.current().settings.language).toBe('ko');
    resumed.dom.window.close();
    expect(d.querySelector('#discord-step').hidden).toBe(false);
    expect(d.querySelector('#onboarding-finish').disabled).toBe(true);
    d.querySelector('#onboarding-discord-id').value = '123';
    d.querySelector('#onboarding-connect').click();
    expect(d.querySelector('#onboarding-error').hidden).toBe(false);
    expect(app.current().settings.discordClientId).toBe('');
    d.querySelector('#onboarding-discord-id').value = '123456789012345678';
    d.querySelector('#onboarding-connect').click();
    await flush();
    expect(app.current().settings.discordClientId).toBe('123456789012345678');
    expect(d.querySelector('#onboarding-finish').disabled).toBe(true);
    app.update({ discordStatus: 'connected', discordConnected: true });
    expect(d.querySelector('#onboarding-finish').disabled).toBe(false);
    d.querySelector('#onboarding-finish').click();
    await flush();
    expect(app.current().settings.onboardingComplete).toBe(true);
    expect(d.querySelector('#onboarding').hidden).toBe(true);
    expect(d.querySelector('.shell').hidden).toBe(false);
    const nextRun = await launch(app.current().settings);
    expect(nextRun.document.querySelector('#onboarding').hidden).toBe(true);
    expect(nextRun.document.documentElement.lang).toBe('ko');
    nextRun.dom.window.close();
    dom.window.close();
  });

  it('allows deferring connection and changing the language later', async () => {
    const app = await launch(initial);
    const { document: d, dom } = app;
    d.querySelector('#onboarding-next').click();
    await flush();
    d.querySelector('#onboarding-skip').click();
    await flush();
    expect(app.current().settings.onboardingComplete).toBe(true);
    expect(app.current().settings.discordClientId).toBe('');
    const form = d.querySelector('#settings-form');
    form.elements.language.value = 'ko';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(app.current().settings.language).toBe('ko');
    expect(d.documentElement.lang).toBe('ko');
    expect(d.querySelector('#activity-name').textContent).toBe('활동을 기다리는 중');
    dom.window.close();
  });
});

describe('running apps and browser status', () => {
  it('shows current apps and clearly disables browser-only features', async () => {
    const app = await launch({ ...initial, onboardingComplete: true, language: 'ko' });
    const { document: d, dom } = app;
    app.update({ browserDisabled: true, browserConnected: false, detectedApps: ['Code', 'obs64'] });
    expect(d.querySelector('#browser-status').textContent).toBe('사용 안 함');
    expect(d.querySelector('#browser-indicator').textContent).toBe('사용 안 함');
    expect(d.querySelector('.nav[data-page=websites]').hidden).toBe(true);
    expect(d.querySelector('#rule-domain').disabled).toBe(true);
    expect(d.querySelector('#rule-path').disabled).toBe(true);
    expect(d.querySelector('#diagnostic-list').textContent).toContain('사용 안 함');
    expect([...d.querySelectorAll('#apps-list li')].map(node => node.textContent)).toEqual(['Code', 'obs64']);
    app.update({ detectedApps: ['obs64'] });
    expect([...d.querySelectorAll('#apps-list li')].map(node => node.textContent)).toEqual(['obs64']);
    dom.window.close();
  });

  it('saves, edits and clears an image asset key on a custom rule', async () => {
    const app = await launch({ ...initial, onboardingComplete: true });
    const { document: d, dom } = app;
    app.update({ browserDisabled: true });
    d.querySelector('#rule-id').value = 'editor';
    d.querySelector('#rule-executable').value = 'Code';
    d.querySelector('#rule-details').value = 'Using editor';
    d.querySelector('#rule-image-key').value = 'vscode_icon';
    d.querySelector('#rule-display-name').value = 'Visual Studio Code';
    d.querySelector('#rule-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(app.current().settings.rules[0].presence.imageKey).toBe('vscode_icon');
    expect(app.current().settings.rules[0].presence.application).toBe('Visual Studio Code');
    d.querySelector('#rules-list button').click();
    expect(d.querySelector('#rule-image-key').value).toBe('vscode_icon');
    d.querySelector('#rule-image-key').value = 'https://images.example.com/code.png';
    d.querySelector('#rule-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(app.current().settings.rules[0].presence.imageKey).toBe('https://images.example.com/code.png');
    d.querySelector('#rules-list button').click();
    d.querySelector('#rule-image-key').value = 'https://127.0.0.1/private.png';
    d.querySelector('#rule-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(app.current().settings.rules[0].presence.imageKey).toBe('https://images.example.com/code.png');
    for (const invalid of ['https://@images.example.com/a.png', 'https://images.example.com/a.png?secret=1', 'https://images.example.com\\private.png']) {
      d.querySelector('#rule-image-key').value = invalid;
      d.querySelector('#rule-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(app.current().settings.rules[0].presence.imageKey).toBe('https://images.example.com/code.png');
    }
    d.querySelector('#rule-image-key').value = '';
    d.querySelector('#rule-display-name').value = '';
    d.querySelector('#rule-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(app.current().settings.rules[0].presence.imageKey).toBeUndefined();
    expect(app.current().settings.rules[0].presence.application).toBeUndefined();
    dom.window.close();
  });
});
