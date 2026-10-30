import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// These fakes exercise the real main-process selection, rules, activity engine,
// and Discord payload conversion. No Windows APIs, Electron UI, or Discord client
// are launched by this test.
const fake = vi.hoisted(() => ({
  foreground: undefined as any,
  running: undefined as any,
  rpc: undefined as any,
  iconProvider: undefined as any,
  window: undefined as any,
  handlers: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, (...args: any[]) => any>(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('electron', () => {
  class BrowserWindow {
    webContents = { send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() };
    constructor() { fake.window = this; }
    loadFile = vi.fn(); once = vi.fn(); on = vi.fn(); show = vi.fn(); hide = vi.fn(); isDestroyed = () => false;
  }
  class Tray { setToolTip = vi.fn(); setContextMenu = vi.fn(); on = vi.fn(); }
  return {
    app: { whenReady: () => Promise.resolve(), on: (name: string, handler: (...args: any[]) => void) => fake.events.set(name, handler), getPath: () => '/fake-user', quit: vi.fn(), isPackaged: false },
    BrowserWindow, Tray, Menu: { buildFromTemplate: vi.fn(() => ({})) }, nativeImage: { createFromDataURL: vi.fn(() => ({})), createFromPath: vi.fn(() => ({})) },
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => fake.handlers.set(name, handler) },
  };
});
vi.mock('node:fs/promises', () => ({ readFile: fake.readFile, writeFile: fake.writeFile }));
vi.mock('../src/windows/foreground', () => ({ ForegroundMonitor: class {
  constructor(public options: any) { fake.foreground = this; }
  start() { return true; } stop() {}
} }));
vi.mock('../src/windows/running', () => ({ RunningProcessMonitor: class {
  constructor(public options: any) { fake.running = this; }
  start() { return true; } stop() {}
} }));
vi.mock('../src/windows/icon', () => ({ ProcessIconProvider: class {
  getIcon = vi.fn(async (_process: any): Promise<string | null> => null);
  retain = vi.fn();
  prioritize = vi.fn();
  dispose = vi.fn();
  constructor() { fake.iconProvider = this; }
} }));
// If the browser bridge is ever imported through any path, application startup fails this integration test.
vi.mock('../src/native/server', () => { throw new Error('Browser server unexpectedly loaded'); });
vi.mock('../src/native/host', () => { throw new Error('Browser host unexpectedly loaded'); });
vi.mock('../src/discord', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/discord')>();
  return { DiscordPresence: class {
    payloads: any[] = [];
    constructor(public options: any) { fake.rpc = this; }
    setActivity(activity: any) { this.payloads.push(actual.toDiscordActivity(activity)); }
    start() { this.options.onStatus?.('connected'); }
    stop = vi.fn(async () => {});
  } };
});

const code = { processId: 100, processName: 'Code.exe', startedAt: 1 };
const figma = { processId: 200, processName: 'Figma.exe', startedAt: 2 };
const chrome = { processId: 300, processName: 'chrome.exe', startedAt: 3 };
const focused = (item: typeof code) => ({ windowId: String(item.processId), processId: item.processId, processName: item.processName, idleMilliseconds: 0 });
const advance = async () => vi.advanceTimersByTimeAsync(1000);

describe('main process integration with fakes', () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fake.foreground = undefined; fake.running = undefined; fake.rpc = undefined; fake.iconProvider = undefined; fake.window = undefined; fake.handlers.clear(); fake.events.clear();
    fake.readFile.mockResolvedValue(JSON.stringify({onboardingComplete: true, discordClientId: '123456789012345678'}));
    fake.writeFile.mockResolvedValue(undefined);
  });
  afterEach(() => { fake.events.get('before-quit')?.({preventDefault: vi.fn()}); vi.useRealTimers(); vi.clearAllMocks(); });

  it('selects focused eligible app, retains it through unrelated focus, switches and clears on exits, and delivers name/icon to RPC', async () => {
    await import('../src/main');
    await vi.waitFor(() => expect(fake.rpc).toBeDefined());
    expect(fake.foreground).toBeDefined(); expect(fake.running).toBeDefined();
    const getState = () => fake.handlers.get('state:get')!();
    expect(getState()).toMatchObject({browserConnected: false, browserDisabled: true, diagnostics: { browser: 'disabled' }});
    fake.running.options.onObservation([code, figma, chrome]);
    fake.foreground.options.onObservation(focused(code));
    await advance();
    expect(getState().activity).toMatchObject({application:'Visual Studio Code', details:'Running Visual Studio Code'});
    expect(fake.rpc.payloads.at(-1)).toMatchObject({name:'Visual Studio Code', details:'Running Visual Studio Code', assets:{large_image:expect.stringContaining('/visual-studio-code/visual-studio-code.png')}});
    expect(getState().detectedApps).toEqual(['Figma', 'Visual Studio Code']);

    const sent = fake.rpc.payloads.length;
    fake.foreground.options.onObservation(focused(chrome));
    await advance();
    expect(getState().activity.application).toBe('Visual Studio Code');
    expect(fake.rpc.payloads).toHaveLength(sent);

    fake.running.options.onObservation([figma, chrome]);
    await advance();
    expect(getState().activity.application).toBe('Figma');
    expect(fake.rpc.payloads.at(-1)).toMatchObject({name:'Figma', assets:{large_image:expect.stringContaining('/figma/figma.png')}});

    fake.running.options.onObservation([chrome]);
    await advance();
    expect(getState().activity).toBeNull();
    expect(getState().detectedApps).toEqual([]);
    expect(fake.rpc.payloads.at(-1)).toBeNull();
  });

  it('renders local process icons while sending only public activity assets to Discord and ignores stale results', async () => {
    await import('../src/main');
    await vi.waitFor(() => expect(fake.rpc).toBeDefined());
    const iconCode = 'data:image/png;base64,LOCALCODE';
    const iconFigma = 'data:image/png;base64,LOCALFIGMA';
    const pending = new Map<number, (value: string | null) => void>();
    fake.iconProvider.getIcon.mockImplementation((item: typeof code) => new Promise(resolve => pending.set(item.processId, resolve)));
    const getState = () => fake.handlers.get('state:get')!();
    fake.running.options.onObservation([code, figma]);
    fake.foreground.options.onObservation(focused(code));
    expect(pending.has(code.processId)).toBe(true);
    expect(pending.has(figma.processId)).toBe(true);
    pending.get(code.processId)!(iconCode);
    await advance();
    expect(getState().runningApps).toContainEqual({name:'Visual Studio Code', icon:iconCode});
    expect(getState().activityIcon).toBe(iconCode);
    expect(fake.window.webContents.send).toHaveBeenCalledWith('state:changed', expect.objectContaining({activityIcon:iconCode}));
    expect(fake.rpc.payloads.at(-1)).toMatchObject({name:'Visual Studio Code', assets:{large_image:expect.stringContaining('/visual-studio-code/visual-studio-code.png')}});
    expect(JSON.stringify(fake.rpc.payloads)).not.toContain('data:image/');
    expect(JSON.stringify(getState().activity)).not.toContain('data:image/');

    // A late icon lookup for an exited process must not repopulate the UI.
    fake.running.options.onObservation([code]);
    pending.get(figma.processId)!(iconFigma);
    await Promise.resolve(); await Promise.resolve();
    expect(getState().runningApps).toEqual([{name:'Visual Studio Code', icon:iconCode}]);
    expect(JSON.stringify(getState())).not.toContain(iconFigma);
    fake.running.options.onObservation([]);
    expect(getState().runningApps).toEqual([]);
    expect(getState().activityIcon).toBeNull();
    expect(fake.iconProvider.retain).toHaveBeenLastCalledWith([]);
    expect(JSON.stringify(fake.rpc.payloads)).not.toContain('data:image/');
  });

  it('uses an available icon from duplicate display names when another app is selected', async () => {
    await import('../src/main');
    await vi.waitFor(() => expect(fake.rpc).toBeDefined());
    const otherCode = {processId: 101, processName: 'Code.exe', startedAt: 4};
    const availableIcon = 'data:image/png;base64,SECONDCODE';
    fake.iconProvider.getIcon.mockImplementation(async (item: typeof code) => item.processId === otherCode.processId ? availableIcon : null);
    fake.running.options.onObservation([code, otherCode, figma]);
    fake.foreground.options.onObservation(focused(figma));
    await advance();
    const state = fake.handlers.get('state:get')!();
    expect(state.activity.application).toBe('Figma');
    expect(state.runningApps).toContainEqual({name:'Visual Studio Code', icon:availableIcon});
    expect(state.runningApps.filter((item: {name: string}) => item.name === 'Visual Studio Code')).toHaveLength(1);
    expect(JSON.stringify(fake.rpc.payloads)).not.toContain(availableIcon);
  });

  it('stops icon work on pause and rejects a late result before requesting again on resume', async () => {
    await import('../src/main');
    await vi.waitFor(() => expect(fake.rpc).toBeDefined());
    const pending: Array<(value: string | null) => void> = [];
    fake.iconProvider.getIcon.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const getState = () => fake.handlers.get('state:get')!();
    fake.running.options.onObservation([code]);
    fake.foreground.options.onObservation(focused(code));
    expect(pending).toHaveLength(1);
    fake.handlers.get('activity:pause')!({}, true);
    expect(fake.iconProvider.retain).toHaveBeenLastCalledWith([]);
    fake.running.options.onObservation([code, figma]);
    await advance();
    expect(pending).toHaveLength(1);
    const stale = 'data:image/png;base64,STALE';
    pending[0](stale);
    await Promise.resolve(); await Promise.resolve();
    expect(JSON.stringify(getState())).not.toContain(stale);
    expect(fake.rpc.payloads.at(-1)).toBeNull();
    fake.handlers.get('activity:pause')!({}, false);
    expect(pending.length).toBeGreaterThan(1);
    const fresh = 'data:image/png;base64,FRESH';
    pending[1](fresh);
    await advance();
    expect(getState().activityIcon).toBe(fresh);
    expect(JSON.stringify(fake.rpc.payloads)).not.toContain('data:image/');
  });

  it('clears RPC on unavailable foreground if idle detection is enabled', async () => {
    fake.readFile.mockResolvedValue(JSON.stringify({onboardingComplete:true, discordClientId:'123456789012345678', idleEnabled:true}));
    await import('../src/main');
    await vi.waitFor(() => expect(fake.rpc).toBeDefined());
    fake.running.options.onObservation([code]);
    fake.foreground.options.onObservation(focused(code));
    await advance();
    expect(fake.handlers.get('state:get')!().activity.application).toBe('Visual Studio Code');
    fake.foreground.options.onObservation(null);
    expect(fake.handlers.get('state:get')!().activity).toBeNull();
    expect(fake.rpc.payloads.at(-1)).toBeNull();
  });

  it('retries a disconnected Discord connection when unchanged settings are saved', async () => {
    await import('../src/main');
    await vi.waitFor(() => expect(fake.rpc).toBeDefined());
    const old = fake.rpc;
    old.options.onStatus('disconnected');
    const settings = fake.handlers.get('state:get')!().settings;
    await fake.handlers.get('settings:save')!({}, settings);
    expect(old.stop).toHaveBeenCalledOnce();
    expect(fake.rpc).not.toBe(old);
    expect(fake.rpc.options.clientId).toBe('123456789012345678');
  });
});

it('main module does not statically or dynamically load the browser native server', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: string[] = [];
  const walk = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, walk);
  };
  walk(file);
  expect(imports.filter(value => /(?:^|\/)native\/(?:server|host)(?:\.[cm]?[jt]s)?$/.test(value))).toEqual([]);
});
