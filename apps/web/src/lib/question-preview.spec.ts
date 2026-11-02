import { describe, expect, it } from 'vitest';

import { questionPreview } from './question-preview';

describe('question preview', () => {
  it('strips markup and leaves readable text', () => {
    expect(questionPreview('<p>What is <b>7</b> × 8?</p>')).toBe('What is 7 × 8?');
  });

  it('decodes the entities an author typed, so the line reads as written', () => {
    expect(questionPreview('<p>a &lt; b and R&amp;D</p>')).toBe('a < b and R&D');
  });

  it('turns a script or an event-handler image into inert text', () => {
    const preview = questionPreview('<img src=x onerror=alert(1)><script>alert(1)</script>Diagram');

    // The value is a plain string placed in a text node: it carries no tag, so no browser
    // can run or load anything from it.
    expect(preview).toBe('Diagram');
    expect(preview).not.toContain('<');
    expect(preview).not.toContain('onerror');
  });

  it('truncates a long line and marks it', () => {
    const preview = questionPreview(`<p>${'x'.repeat(200)}</p>`, 20);

    expect(preview).toBe(`${'x'.repeat(20)}…`);
  });
});
