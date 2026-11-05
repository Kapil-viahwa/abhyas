import { describe, expect, it } from 'vitest';

import { normaliseEmail } from './email-identity';

describe('the identity a signup grant is paid against', () => {
  it('treats every Gmail spelling of one mailbox as one person', () => {
    expect(normaliseEmail('a+1@gmail.com')).toBe('a@gmail.com');
    expect(normaliseEmail('a.b@gmail.com')).toBe('ab@gmail.com');
    expect(normaliseEmail('a+1@googlemail.com')).toBe('a@gmail.com');
    expect(normaliseEmail('  A@Gmail.COM ')).toBe('a@gmail.com');
  });

  it('leaves every other domain alone apart from case', () => {
    expect(normaliseEmail('First.Last+tag@Example.com')).toBe('first.last+tag@example.com');
    expect(normaliseEmail(null)).toBeNull();
    expect(normaliseEmail('not-an-address')).toBeNull();
  });
});
