import { describe, expect, it } from 'vitest';

import { KATEX_OPTIONS, renderLatex } from './latex';

describe('latex rendering', () => {
  it('renders ordinary maths as KaTeX markup', () => {
    const html = renderLatex('x^2 + y^2');

    expect(html).toContain('katex');
    expect(html).toContain('mathnormal');
  });

  it('keeps trust disabled and both work limits in place', () => {
    expect(KATEX_OPTIONS.trust).toBe(false);
    expect(KATEX_OPTIONS.strict).toBe('error');
    expect(KATEX_OPTIONS.throwOnError).toBe(false);
    expect(KATEX_OPTIONS.maxSize).toBe(50);
    expect(KATEX_OPTIONS.maxExpand).toBe(1000);
  });

  it('never renders a link, an image or a class attribute from an author macro', () => {
    const dangerous = [
      '\\href{javascript:alert(1)}{click}',
      '\\url{javascript:alert(1)}',
      '\\includegraphics{https://evil.example/steal.png}',
      '\\htmlClass{evil}{text}',
    ];

    for (const latex of dangerous) {
      const html = renderLatex(latex);

      expect(html).not.toContain('<a ');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('class="evil"');
      expect(html).not.toContain('javascript:alert(1)\u0022');
    }
  });

  it('shows a refused expression as escaped text, not as markup', () => {
    const html = renderLatex('\\includegraphics{<script>alert(1)</script>}');

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });

  it('renders nothing for an empty expression', () => {
    expect(renderLatex('   ')).toBe('');
  });
});
