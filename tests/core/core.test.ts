import { test } from 'vitest';
import assert from 'node:assert/strict';
import { detectSiteActivity, normalizeDomain } from '../../src/core/adapters.js';
import { ActivityEngine } from '../../src/core/engine.js';
import { applyRules, validateRule, wildcardMatch } from '../../src/core/rules.js';

const act = (application, details, confidence = 'generic') => ({ application, details, confidence });
const candidate = (windowId, source, activity) => ({ windowId, source, activity });
const snapshot = (id, candidates, extra = {}) => ({ foregroundWindowId: id, candidates, idle: false, idleDetectionEnabled: true, ...extra });

test('domain validation and conservative consent default never expose path or query', () => {
  assert.equal(normalizeDomain('GitHub.COM.'), 'github.com');
  for (const invalid of ['https://github.com', 'github.com.evil/', 'a..com', '-bad.com', 'example.com:443']) assert.equal(normalizeDomain(invalid), null);
  const input = {domain: 'github.com', path: '/secret/project/pull/42?token=secret', detailedAllowed: false};
  assert.deepEqual(detectSiteActivity(input), act('GitHub', 'Browsing GitHub'));
  const allowed = detectSiteActivity({...input, detailedAllowed: true});
  assert.deepEqual(allowed, act('GitHub', 'Viewing pull requests', 'confirmed'));
  assert.ok(!JSON.stringify(allowed).includes('secret'));
  assert.deepEqual(detectSiteActivity({domain:'news.example.com', detailedAllowed:false}), act('news.example.com', 'Browsing news.example.com'));
  assert.deepEqual(detectSiteActivity({domain:'github.com', detailedAllowed:true}, ['github']), act('github.com', 'Browsing github.com'));
});

test('site signals need consent and only observed media claims playback', () => {
  assert.deepEqual(detectSiteActivity({domain:'youtube.com', path:'/watch', detailedAllowed:true}), act('YouTube', 'Using YouTube'));
  assert.deepEqual(detectSiteActivity({domain:'youtube.com', detailedAllowed:false, signals:{media:'playing'}}), act('YouTube', 'Using YouTube'));
  assert.deepEqual(detectSiteActivity({domain:'youtube.com', detailedAllowed:true, signals:{media:'playing'}}), act('YouTube', 'Watching a video', 'confirmed'));
  assert.deepEqual(detectSiteActivity({domain:'figma.com', detailedAllowed:true, path:'/design/abc/private-name'}), act('Figma', 'Viewing a design file', 'confirmed'));
  assert.deepEqual(detectSiteActivity({domain:'notion.so', detailedAllowed:true}), act('Notion', 'Using Notion'));
});

test('engine respects foreground, priority, debounce, deduplication and timestamps', () => {
  const engine = new ActivityEngine(1000);
  const generic = candidate('window1', 'desktop', act('Browser', 'Using Browser'));
  const website = candidate('window1', 'browser-confirmed', act('YouTube', 'Watching a video', 'confirmed'));
  const background = candidate('window2', 'desktop-confirmed', act('Editor', 'Editing', 'confirmed'));
  const s = snapshot('window1', [generic, website, background]);
  assert.deepEqual(engine.evaluate(s, 100), {activity:null, changed:false});
  assert.equal(engine.nextDelay(500), 600);
  assert.deepEqual(engine.evaluate(s, 1100), {activity:{...website.activity, startedAt:100}, changed:true});
  assert.deepEqual(engine.evaluate(s, 1200), {activity:{...website.activity, startedAt:100}, changed:false});
  const s2 = snapshot('window2', [generic, website, background]);
  assert.deepEqual(engine.evaluate(s2, 1300), {activity:null, changed:true});
  assert.deepEqual(engine.evaluate(s2, 2300), {activity:{...background.activity, startedAt:1300}, changed:true});
  assert.deepEqual(engine.evaluate(snapshot('window2', [background], {idle:true}), 2400), {activity:null, changed:true});
});

test('transient changes debounce, idle can be disabled, pause clears, and confidence is not escalated', () => {
  const engine = new ActivityEngine(10);
  const a = candidate('1', 'desktop', act('Editor', 'Using editor'));
  const fake = candidate('1', 'desktop-confirmed', act('Editor', 'Editing', 'generic'));
  const s = snapshot('1', [a, fake], {idle:true, idleDetectionEnabled:false});
  engine.evaluate(s, 0);
  assert.deepEqual(engine.evaluate(s, 10).activity, {...a.activity, startedAt:0});
  const changed = candidate('1', 'desktop-confirmed', act('Editor', 'Editing', 'confirmed'));
  assert.equal(engine.evaluate(snapshot('1',[changed]), 11).activity.details, 'Using editor');
  assert.equal(engine.evaluate(s, 15).activity.details, 'Using editor');
  assert.equal(engine.evaluate(snapshot('1',[a],{paused:true}), 16).activity, null);
});

test('rules use bounded wildcards, consent gates, exact domain boundaries and first match', () => {
  const rule = { id:'custom', enabled:true, match:{domain:'figma.com', pathPattern:'/design/*'}, presence:{details:'Designing'} };
  assert.equal(validateRule(rule), true);
  assert.equal(validateRule({...rule, match:{pathPattern:'x?*'}}), false);
  assert.equal(validateRule({...rule, match:{domain:'https://figma.com'}}), false);
  assert.equal(wildcardMatch('/design/*', '/design/abc'), true);
  const base = act('Figma','Using Figma');
  const ctx = {domain:'www.figma.com', path:'/design/abc?private=1', detailedAllowed:true, titleAllowed:false};
  assert.equal(applyRules([rule], ctx, base).details, 'Designing');
  assert.equal(applyRules([rule], {...ctx,detailedAllowed:false}, base), undefined);
  assert.equal(applyRules([rule], {...ctx,domain:'evilfigma.com'}, base), undefined);
  assert.equal(applyRules([{...rule, exclude:true}], ctx, base), null);
  const title = {...rule, match:{titlePattern:'*secret*'}};
  assert.equal(applyRules([title], {...ctx,title:'secret',titleAllowed:false}, base), undefined);
});
