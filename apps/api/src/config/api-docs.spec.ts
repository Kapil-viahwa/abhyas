import { describe, expect, it } from 'vitest';

import { API_DOCS_PATH, apiDocsEnabled } from './api-docs';

describe('API documentation exposure', () => {
  it('is served in development and test', () => {
    expect(apiDocsEnabled('development')).toBe(true);
    expect(apiDocsEnabled('test')).toBe(true);
  });

  it('is not served in production', () => {
    expect(apiDocsEnabled('production')).toBe(false);
  });

  it('mounts the document at the path the smoke test curls', () => {
    expect(API_DOCS_PATH).toBe('api/docs');
  });
});
