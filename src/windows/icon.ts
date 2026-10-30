import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RunningProcess } from './running';

const MAX_PNG_BYTES = 128 * 1024;
const MAX_STDOUT_BYTES = Math.ceil(MAX_PNG_BYTES * 4 / 3) + 4096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Accept only small PNGs produced by the helper; return a renderer-safe data URL. */
export function parseIconPayload(output: string): string | null {
  const encoded = output.trim();
  if (!encoded || encoded.length > MAX_STDOUT_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  const png = Buffer.from(encoded, 'base64');
  if (png.length < 33 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width !== 32 || height !== 32) return null;
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** A known creation time prevents a reused PID from being attributed to an old app. */
function identity(process: RunningProcess): string | null {
  if (!process || typeof process !== 'object' || !Number.isSafeInteger(process.processId) || process.processId <= 0 || process.processId > 0xffffffff ||
      typeof process.processName !== 'string' || process.processName.length < 1 || process.processName.length > 255 ||
      /[\x00-\x1f\x7f\\/]/.test(process.processName) || !Number.isSafeInteger(process.startedAt) || (process.startedAt as number) < 0) return null;
  return JSON.stringify([process.processId, process.startedAt, process.processName]);
}

// The executable path is read only inside this private helper and never written to
// stdout. Remote, mapped-network and removable drives are refused before icon IO.
// User-controlled data is inserted only as numeric literals or base64-encoded UTF-8.
function iconScript(process: RunningProcess): string {
  const name64 = Buffer.from(process.processName, 'utf8').toString('base64');
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$proc = $null; $icon = $null; $bitmap = $null; $graphics = $null; $stream = $null
try {
  Add-Type -AssemblyName System.Drawing
  $expectedName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${name64}'))
  $proc = [System.Diagnostics.Process]::GetProcessById(${process.processId})
  $start = ([DateTimeOffset]$proc.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  if ($start -ne ${process.startedAt} -or $proc.ProcessName -cne $expectedName) { exit 0 }
  $path = $proc.MainModule.FileName
  if ($path -notmatch '^[A-Za-z]:\\') { exit 0 }
  $root = [System.IO.Path]::GetPathRoot($path)
  $drive = New-Object System.IO.DriveInfo $root
  if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) { exit 0 }
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
  if ($null -eq $icon) { exit 0 }
  $bitmap = New-Object System.Drawing.Bitmap 32,32
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.DrawIcon($icon, [System.Drawing.Rectangle]::new(0,0,32,32))
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($stream.Length -gt ${MAX_PNG_BYTES}) { exit 0 }
  $proc.Refresh()
  if ($proc.HasExited -or ([DateTimeOffset]$proc.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() -ne ${process.startedAt} -or $proc.ProcessName -cne $expectedName) { exit 0 }
  [Console]::WriteLine([Convert]::ToBase64String($stream.ToArray()))
} catch { } finally {
  if ($null -ne $graphics) { $graphics.Dispose() }
  if ($null -ne $bitmap) { $bitmap.Dispose() }
  if ($null -ne $icon) { $icon.Dispose() }
  if ($null -ne $stream) { $stream.Dispose() }
  if ($null -ne $proc) { $proc.Dispose() }
}`;
}

type Job = {key: string; process: RunningProcess; resolve: (result: string | null) => void};
type Entry = {value: string | null; expires: number};

/** Local, bounded icon lookup; callers should invoke retain() for each latest snapshot. */
export class ProcessIconProvider {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly running = new Map<string, {child: ChildProcessWithoutNullStreams; cancel: () => void}>();
  private queue: Job[] = [];
  private retained: Set<string> | null = null;
  private stopped = false;

  getIcon(process: RunningProcess): Promise<string | null> {
    if (this.stopped || globalThis.process.platform !== 'win32') return Promise.resolve(null);
    const key = identity(process);
    if (!key || (this.retained && !this.retained.has(key))) return Promise.resolve(null);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) { this.cache.delete(key); this.cache.set(key, cached); return Promise.resolve(cached.value); }
    if (cached) this.cache.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.queue.length >= 256) return Promise.resolve(null);
    const promise = new Promise<string | null>(resolve => { this.queue.push({key, process: {...process}, resolve}); });
    this.pending.set(key, promise);
    void promise.then(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    this.pump();
    return promise;
  }

  /** Move an already queued lookup ahead of background lookups without interrupting active ones. */
  prioritize(process: RunningProcess): void {
    if (this.stopped) return;
    const key = identity(process);
    if (!key) return;
    const index = this.queue.findIndex(job => job.key === key);
    if (index > 0) this.queue.unshift(this.queue.splice(index, 1)[0]);
  }

  /** Stop work for processes no longer present and remove their cached icons. */
  retain(processes: readonly RunningProcess[]): void {
    this.retained = new Set(processes.map(identity).filter((key): key is string => key !== null));
    for (const key of this.cache.keys()) if (!this.retained.has(key)) this.cache.delete(key);
    const next: Job[] = [];
    for (const job of this.queue) { if (this.retained.has(job.key)) next.push(job); else job.resolve(null); }
    this.queue = next;
    for (const [key, job] of this.running) if (!this.retained.has(key)) job.cancel();
  }

  dispose(): void {
    this.stopped = true;
    for (const job of this.queue) job.resolve(null);
    this.queue = [];
    for (const job of this.running.values()) job.cancel();
    this.cache.clear();
  }

  private pump(): void {
    while (!this.stopped && this.running.size < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      const encoded = Buffer.from(iconScript(job.process), 'utf16le').toString('base64');
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {windowsHide: true}); }
      catch { job.resolve(null); continue; }
      let stdout = Buffer.alloc(0), done = false;
      const finish = (value: string | null) => {
        if (done) return; done = true; clearTimeout(timer);
        this.running.delete(job.key);
        if (this.stopped || (this.retained && !this.retained.has(job.key))) value = null;
        else {
          this.cache.set(job.key, {value, expires: Date.now() + (value ? 300000 : 30000)});
          while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
        }
        job.resolve(value); this.pump();
      };
      const timer = setTimeout(() => { child.kill(); finish(null); }, 5000);
      this.running.set(job.key, {child, cancel: () => { child.kill(); finish(null); }});
      child.stdin.end(); child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length > MAX_STDOUT_BYTES) { child.kill(); finish(null); return; }
        stdout = Buffer.concat([stdout, chunk]);
      });
      child.on('error', () => finish(null));
      child.on('close', code => finish(code === 0 ? parseIconPayload(stdout.toString('ascii')) : null));
    }
  }
}
