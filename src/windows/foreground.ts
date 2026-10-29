import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Local-only observation. Paths and titles are collected only on explicit request. */
export interface ForegroundObservation {
  windowId: string;
  processId: number;
  processName: string;
  idleMilliseconds: number;
  executablePath?: string;
  windowTitle?: string;
}

export interface ForegroundOptions {
  intervalMs?: number;
  includeExecutablePath?: boolean;
  includeWindowTitle?: boolean;
  onObservation(observation: ForegroundObservation | null): void;
  onError?(error: Error): void;
}

/** Validate the private child-process protocol before exposing an observation. */
export function parseForegroundObservation(line: string): ForegroundObservation | null {
  const raw: unknown = JSON.parse(line);
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid foreground observation');
  const x = raw as Record<string, unknown>;
  if (typeof x.windowId !== 'string' || !/^\d+$/.test(x.windowId) ||
      !Number.isSafeInteger(x.processId) || (x.processId as number) <= 0 ||
      typeof x.processName !== 'string' || x.processName.length === 0 || x.processName.length > 1024 ||
      !Number.isSafeInteger(x.idleMilliseconds) || (x.idleMilliseconds as number) < 0 ||
      (x.executablePath !== undefined && typeof x.executablePath !== 'string') ||
      (x.windowTitle !== undefined && typeof x.windowTitle !== 'string')) {
    throw new Error('Invalid foreground observation');
  }
  return {
    windowId: x.windowId,
    processId: x.processId as number,
    processName: x.processName,
    idleMilliseconds: x.idleMilliseconds as number,
    ...(typeof x.executablePath === 'string' ? { executablePath: x.executablePath } : {}),
    ...(typeof x.windowTitle === 'string' ? { windowTitle: x.windowTitle } : {}),
  };
}

// A long-lived helper avoids starting PowerShell on each poll. Polling also lets us
// observe idle time without a global input hook and works in an ordinary user session.
// Native window handles are emitted as decimal strings to avoid JS integer truncation.
function helperScript(interval: number, path: boolean, title: boolean): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AutoPresenceWindows {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder text, int length);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint length);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
}
'@
while ($true) {
  try {
    $h = [AutoPresenceWindows]::GetForegroundWindow()
    [uint32]$pidValue = 0
    if ($h -eq [IntPtr]::Zero) { [Console]::WriteLine('null'); Start-Sleep -Milliseconds ${interval}; continue }
    [void][AutoPresenceWindows]::GetWindowThreadProcessId($h, [ref]$pidValue)
    if ($pidValue -eq 0) { [Console]::WriteLine('null'); Start-Sleep -Milliseconds ${interval}; continue }
    $proc = [System.Diagnostics.Process]::GetProcessById([int]$pidValue)
    $info = New-Object 'AutoPresenceWindows+LASTINPUTINFO'
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
    if (-not [AutoPresenceWindows]::GetLastInputInfo([ref]$info)) { throw 'Idle information unavailable' }
    $now = [AutoPresenceWindows]::GetTickCount()
    $idle = ([int64]$now - [int64]$info.dwTime + 4294967296) % 4294967296
    $item = @{windowId = $h.ToInt64().ToString(); processId = $pidValue; processName = $proc.ProcessName; idleMilliseconds = $idle}
    if (${path ? '$true' : '$false'}) {
      $p = [AutoPresenceWindows]::OpenProcess(0x1000, $false, $pidValue)
      if ($p -ne [IntPtr]::Zero) {
        try {
          $buf = New-Object System.Text.StringBuilder 32768; [uint32]$length = $buf.Capacity
          if ([AutoPresenceWindows]::QueryFullProcessImageNameW($p, 0, $buf, [ref]$length)) { $item.executablePath = $buf.ToString() }
        } finally { [void][AutoPresenceWindows]::CloseHandle($p) }
      }
    }
    if (${title ? '$true' : '$false'}) {
      $buf = New-Object System.Text.StringBuilder 32768
      if ([AutoPresenceWindows]::GetWindowTextW($h, $buf, $buf.Capacity) -gt 0) { $item.windowTitle = $buf.ToString() }
    }
    [Console]::WriteLine(($item | ConvertTo-Json -Compress))
  } catch { [Console]::WriteLine('null') }
  Start-Sleep -Milliseconds ${interval}
}`;
}

export class ForegroundMonitor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly options: ForegroundOptions;
  private stopping = false;

  constructor(options: ForegroundOptions) {
    const interval = options.intervalMs ?? 1000;
    if (!Number.isInteger(interval) || interval < 250 || interval > 10000) throw new RangeError('intervalMs must be 250–10000');
    this.options = options;
  }

  /** Returns false when the current platform does not support this detector. */
  start(): boolean {
    if (this.child) return true;
    if (process.platform !== 'win32') return false;
    this.stopping = false;
    const script = helperScript(this.options.intervalMs ?? 1000, !!this.options.includeExecutablePath, !!this.options.includeWindowTitle);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
    this.child = child;
    child.stdin.end();
    // Drain stderr without exposing potentially sensitive data in logs.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (this.stopping || this.child !== child) return;
      let observation: ForegroundObservation | null;
      try { observation = parseForegroundObservation(line); }
      catch { this.options.onError?.(new Error('Invalid foreground detector output')); return; }
      if (observation) {
        if (!this.options.includeExecutablePath) delete observation.executablePath;
        if (!this.options.includeWindowTitle) delete observation.windowTitle;
      }
      this.options.onObservation(observation);
    });
    child.on('error', () => { if (!this.stopping && this.child === child) this.options.onError?.(new Error('Unable to start foreground detector')); });
    child.on('close', () => {
      lines.close();
      if (this.child === child) {
        this.child = undefined;
        if (!this.stopping) this.options.onError?.(new Error('Foreground detector stopped unexpectedly'));
      }
    });
    return true;
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}
