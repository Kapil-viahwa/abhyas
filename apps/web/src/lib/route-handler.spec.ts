import { describe, expect, it } from 'vitest';

import { guardFormPost } from './route-handler';

/**
 * The guard every cookie-authenticated write passes, proved without a browser.
 *
 * A cross-site page can make the browser send the `abhyas_csrf` cookie, but it cannot
 * read it, so it cannot fill the form field; and a browser always names the origin it
 * posted from. Each test below removes one of those two things — and the pair — and
 * expects the request to be refused before it reaches the API.
 */

const WEB_URL = 'http://localhost:3000';
const CSRF_VALUE = 'csrf-value-for-the-test';
const SAME_ORIGIN = { origin: WEB_URL, cookie: `abhyas_csrf=${CSRF_VALUE}` };

function formPost(body: Record<string, string>, headers: Record<string, string> = {}): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) {
    form.set(name, value);
  }

  return new Request(`${WEB_URL}/api/auth/login`, { method: 'POST', body: form, headers });
}

describe('cookie-authenticated write guard', () => {
  it('accepts a form post from this origin that echoes the cookie', async () => {
    const guard = await guardFormPost(formPost({ csrfToken: CSRF_VALUE, email: 'a@example.com' }, SAME_ORIGIN));

    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.form.get('email')).toBe('a@example.com');
    }
  });

  it('refuses a post from a foreign origin, even with the right value', async () => {
    const guard = await guardFormPost(
      formPost({ csrfToken: CSRF_VALUE }, { origin: 'https://evil.example', cookie: `abhyas_csrf=${CSRF_VALUE}` }),
    );

    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(403);
    }
  });

  it('refuses a post that names no origin at all', async () => {
    const guard = await guardFormPost(formPost({ csrfToken: CSRF_VALUE }, { cookie: `abhyas_csrf=${CSRF_VALUE}` }));

    expect(guard.ok).toBe(false);
  });

  it('refuses a post without the form value, which is what a cross-site page can produce', async () => {
    const guard = await guardFormPost(formPost({ email: 'a@example.com' }, SAME_ORIGIN));

    expect(guard.ok).toBe(false);
  });

  it('refuses a post whose form value does not match the cookie', async () => {
    const guard = await guardFormPost(formPost({ csrfToken: 'guessed-value' }, SAME_ORIGIN));

    expect(guard.ok).toBe(false);
  });

  it('refuses the right value when there is no cookie to compare it with', async () => {
    const guard = await guardFormPost(formPost({ csrfToken: CSRF_VALUE }, { origin: WEB_URL }));

    expect(guard.ok).toBe(false);
  });

  it('refuses a body that is not a form at all', async () => {
    const guard = await guardFormPost(
      new Request(`${WEB_URL}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ csrfToken: CSRF_VALUE }),
        headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      }),
    );

    expect(guard.ok).toBe(false);
  });
});
