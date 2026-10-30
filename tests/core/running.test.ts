import { describe, expect, it } from 'vitest';
import { eligibleProcesses, runningActivity, selectRunningProcess, validateImageReference, validateRule, applyRules } from '../../src/core';

const items = [
  {processId: 1, processName: 'Code', startedAt: 100},
  {processId: 2, processName: 'Spotify', startedAt: 200},
  {processId: 3, processName: 'chrome', startedAt: 300},
  {processId: 4, processName: 'AutoPresence', startedAt: 400},
];
describe('running applications', () => {
  it('filters browsers, own app and user exclusions', () => {
    expect(eligibleProcesses(items, ['Spotify.exe'], 4).map(p => p.processId)).toEqual([1]);
  });
  it('uses foreground first, retains last running app, and replaces it when closed', () => {
    const visible = eligibleProcesses(items, [], 4);
    expect(selectRunningProcess(visible, 1, 2)?.processId).toBe(1);
    expect(selectRunningProcess(visible, 3, 1)?.processId).toBe(1);
    expect(selectRunningProcess(visible.filter(p => p.processId !== 1), null, 1)?.processId).toBe(2);
    expect(selectRunningProcess([], null, 1)).toBeNull();
  });
  it('uses a friendly name and a public pinned icon only for supported apps', () => {
    expect(runningActivity(items[0])).toMatchObject({application: 'Visual Studio Code', details: 'Running Visual Studio Code'});
    expect(validateImageReference(runningActivity(items[0]).imageKey)).toBe(true);
    expect(runningActivity({processId: 5, processName: 'myapp', startedAt: null})).toEqual({application:'myapp',details:'Running myapp',confidence:'generic'});
  });
  it('permits a custom visible app name and safe image override', () => {
    const base = runningActivity(items[0]);
    const rule = {id:'code', enabled:true, match:{executableName:'Code'}, presence:{application:'My editor', details:'Editing', imageKey:'https://images.example.com/logo.png'}};
    expect(validateRule(rule)).toBe(true);
    expect(applyRules([rule], {executableName:'Code.exe', detailedAllowed:false, titleAllowed:false}, base)).toMatchObject(rule.presence);
    expect(validateRule({...rule,presence:{...rule.presence, imageKey:'https://localhost/icon.png'}})).toBe(false);
  });
  it('rejects URLs that are not publicly named HTTPS images', () => {
    for (const value of ['http://example.com/image.png','https://127.0.0.1/a','https://[::1]/a','https://@example.com/a','https://a.example/a?token=1','https://example.com/a#fragment','https://a.example/\u0085']) expect(validateImageReference(value)).toBe(false);
  });
});
