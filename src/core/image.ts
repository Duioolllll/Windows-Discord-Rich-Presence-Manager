import { isIP } from 'node:net';

/** Discord asset key or an explicitly supplied public HTTPS image reference. */
export function validateImageReference(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x20\x7f-\x9f\\]/.test(value)) return false;
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(value)) return true;
  if (/[?#]/.test(value) || /^https:\/\/[^/]*@/i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    if (host.startsWith('[') || host.endsWith('.') || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)) return false;
    // Require a public DNS name; literal IP addresses are not accepted.
    if (isIP(host)) return false;
    return true;
  } catch { return false; }
}
