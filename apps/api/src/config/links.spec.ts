import { describe, expect, it } from 'vitest';

import { DEFAULT_WEB_URL, webUrlFor } from './links';

describe('web URL for email links', () => {
  it('falls back to localhost in development and test', () => {
    expect(webUrlFor('development', undefined)).toBe(DEFAULT_WEB_URL);
    expect(webUrlFor('test', '')).toBe(DEFAULT_WEB_URL);
  });

  it('strips trailing slashes and keeps a https origin', () => {
    expect(webUrlFor('production', 'https://abhyas.example.com/')).toBe('https://abhyas.example.com');
    expect(webUrlFor('development', 'http://localhost:3000//')).toBe('http://localhost:3000');
  });

  it('refuses to boot production without a public URL', () => {
    expect(() => webUrlFor('production', undefined)).toThrow(/WEB_URL is required in production/);
  });

  it('refuses a plain http link in production', () => {
    expect(() => webUrlFor('production', 'http://abhyas.example.com')).toThrow(/must use https/);
  });

  it('refuses a value that is not an http(s) origin', () => {
    expect(() => webUrlFor('development', 'javascript:alert(1)')).toThrow(/absolute http\(s\) URL/);
    expect(() => webUrlFor('development', 'not a url')).toThrow(/absolute http\(s\) URL/);
  });
});
