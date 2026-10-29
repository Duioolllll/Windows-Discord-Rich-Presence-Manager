import { describe, expect, it } from 'vitest';
import { parseBrowserMessage } from '../../src/native/protocol';

describe('browser native message validation', () => {
  it('accepts a domain-only message without altering the information', () => {
    const message = { version: 1, kind: 'activity', browser: 'chrome', domain: 'github.com' };
    expect(parseBrowserMessage(message)).toEqual(message);
  });
  it('accepts an allowlisted observed signal only for its own domain', () => {
    expect(parseBrowserMessage({ version: 1, kind: 'activity', browser: 'edge', domain: 'www.youtube.com', signal: 'youtube-playing' })).not.toBeNull();
    expect(parseBrowserMessage({ version: 1, kind: 'activity', browser: 'edge', domain: 'notyoutube.com', signal: 'youtube-playing' })).toBeNull();
    expect(parseBrowserMessage({ version: 1, kind: 'activity', browser: 'edge', domain: 'github.com', signal: 'youtube-playing' })).toBeNull();
  });
  it('refuses raw URLs, page titles, arbitrary commands, unknown fields and invalid hostnames', () => {
    const base = { version: 1, kind: 'activity', browser: 'firefox', domain: 'github.com' };
    for (const item of [
      { ...base, url: 'https://github.com/private/repo' },
      { ...base, title: 'private document' },
      { ...base, command: 'run' },
      { ...base, domain: 'github.com/private' },
      { ...base, domain: 'EXAMPLE.COM' },
      { ...base, signal: '__proto__' },
    ]) expect(parseBrowserMessage(item)).toBeNull();
  });
  it('validates disconnect messages and rejects data attached to them', () => {
    expect(parseBrowserMessage({ version: 1, kind: 'clear', browser: 'firefox' })).not.toBeNull();
    expect(parseBrowserMessage({ version: 1, kind: 'clear', browser: 'firefox', domain: 'example.com' })).toBeNull();
    expect(parseBrowserMessage({ version: 1, kind: 'clear', browser: 'other' })).toBeNull();
  });
});
