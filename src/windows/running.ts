import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** A local observation of a process with a visible top-level window in the current session. */
export interface RunningProcess {
  processId: number;
  processName: string;
  /** Process creation time in Unix milliseconds, or null when inaccessible. */
  startedAt: number | null;
}

export interface RunningProcessOptions {
  intervalMs?: number;
  onObservation(processes: RunningProcess[] | null): void;
  onError?(error: Error): void;
}

const MAX_PROCESSES = 2048;
const MAX_LINE_BYTES = 1024 * 1024;

/** Validate the child protocol, drop duplicates and never expose unknown fields. */
export function parseRunningSnapshot(line: string): RunningProcess[] | null {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('Running process snapshot too large');
  const raw: unknown = JSON.parse(line);
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid running process snapshot');
  const envelope = raw as Record<string, unknown>;
  if (envelope.version !== 1 || !Array.isArray(envelope.processes) || envelope.processes.length > MAX_PROCESSES) {
    throw new Error('Invalid running process snapshot');
  }
  const seen = new Map<number, RunningProcess>();
  for (const item of envelope.processes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid running process');
    const value = item as Record<string, unknown>;
    if (!Number.isSafeInteger(value.processId) || (value.processId as number) < 1 || (value.processId as number) > 0xffffffff ||
        typeof value.processName !== 'string' || value.processName.length < 1 || value.processName.length > 255 ||
        /[\x00-\x1f\x7f\\/]/.test(value.processName) ||
        (value.startedAt !== null && (!Number.isSafeInteger(value.startedAt) || (value.startedAt as number) < 0))) {
      throw new Error('Invalid running process');
    }
    const process: RunningProcess = {processId: value.processId as number, processName: value.processName, startedAt: value.startedAt as number | null};
    const previous = seen.get(process.processId);
    if (previous && (previous.processName !== process.processName || previous.startedAt !== process.startedAt)) {
      throw new Error('Conflicting running process');
    }
    if (!previous) seen.set(process.processId, process);
  }
  return [...seen.values()];
}

// EnumWindows enumerates top-level windows on the current desktop. IsWindowVisible
// includes minimized visible windows. Session IDs prevent cross-session observations.
// Neither titles nor executable paths are queried. An inaccessible process is skipped;
// a process whose start time cannot be read is included with startedAt: null.
function helperScript(interval: number): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AutoPresenceRunningWindows {
    public delegate bool EnumWindowsProc(IntPtr handle, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
    public static uint[] GetProcessIds() {
        uint ownSession;
        if (!ProcessIdToSessionId(GetCurrentProcessId(), out ownSession)) throw new InvalidOperationException("Session unavailable");
        var result = new HashSet<uint>();
        EnumWindowsProc callback = delegate(IntPtr h, IntPtr data) {
            if (!IsWindowVisible(h)) return true;
            uint pid, session;
            GetWindowThreadProcessId(h, out pid);
            if (pid > 0 && ProcessIdToSessionId(pid, out session) && session == ownSession) result.Add(pid);
            return true;
        };
        if (!EnumWindows(callback, IntPtr.Zero)) throw new InvalidOperationException("Window enumeration failed");
        var values = new uint[result.Count];
        result.CopyTo(values);
        Array.Sort(values);
        return values;
    }
}
'@
while ($true) {
  try {
    $items = @()
    foreach ($pidValue in [AutoPresenceRunningWindows]::GetProcessIds() | Select-Object -First ${MAX_PROCESSES}) {
      $proc = $null
      try {
        $proc = [System.Diagnostics.Process]::GetProcessById([int]$pidValue)
        $name = $proc.ProcessName
        if (-not $name -or $name.Length -gt 255) { continue }
        $startedAt = $null
        try { $startedAt = ([DateTimeOffset]$proc.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() } catch { }
        $items += @{ processId = [uint32]$pidValue; processName = $name; startedAt = $startedAt }
      } catch { } finally { if ($null -ne $proc) { $proc.Dispose() } }
    }
    $snapshot = @{ version = 1; processes = @($items) }
    [Console]::WriteLine((ConvertTo-Json -InputObject $snapshot -Compress -Depth 4))
  } catch { [Console]::WriteLine('null') }
  Start-Sleep -Milliseconds ${interval}
}`;
}

export class RunningProcessMonitor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;
  constructor(private readonly options: RunningProcessOptions) {
    const interval = options.intervalMs ?? 3000;
    if (!Number.isInteger(interval) || interval < 1000 || interval > 10000) throw new RangeError('intervalMs must be 1000–10000');
  }

  /** Returns false if this platform cannot enumerate Windows windows. */
  start(): boolean {
    if (this.child) return true;
    if (process.platform !== 'win32') return false;
    this.stopping = false;
    const encoded = Buffer.from(helperScript(this.options.intervalMs ?? 3000), 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {windowsHide: true});
    this.child = child;
    child.stdin.end();
    child.stderr.resume();
    const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
    lines.on('line', line => {
      if (this.stopping || this.child !== child) return;
      try { this.options.onObservation(parseRunningSnapshot(line)); }
      catch { this.options.onError?.(new Error('Invalid running process detector output')); }
    });
    child.on('error', () => { if (!this.stopping && this.child === child) this.options.onError?.(new Error('Unable to start running process detector')); });
    child.on('close', () => {
      lines.close();
      if (this.child === child) {
        this.child = undefined;
        if (!this.stopping) this.options.onError?.(new Error('Running process detector stopped unexpectedly'));
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
