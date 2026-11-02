import { describe, expect, it } from 'vitest';

import {
  ContentRejectedError,
  MAX_NESTING_DEPTH,
  decodeEntities,
  mediaIdsIn,
  normalizeText,
  plainText,
  sanitizeLatex,
  sanitizeOptionalContent,
  sanitizeQuestionContent,
  sanitizeStoredContent,
} from './sanitize';

/**
 * The payload suite. Every entry is a known XSS or mutation-XSS shape, and the expected
 * value is exactly what the sanitiser must store: text-only markup, or nothing at all.
 *
 * The same input is run against the question text, against an option and against the
 * explanation, because all three reach the same sanitiser and all three reach a student.
 */
interface Payload {
  readonly name: string;
  readonly input: string;
  /** The stored output, or null when nothing survives and the value is refused. */
  readonly expected: string | null;
}

const PAYLOADS: readonly Payload[] = [
  { name: 'script element', input: '<script>alert(1)</script>', expected: null },
  { name: 'uppercase script', input: '<SCRIPT>alert(1)</SCRIPT>', expected: null },
  { name: 'case-mangled script', input: '<ScRiPt>alert(1)</sCrIpT>', expected: null },
  { name: 'script with a remote source', input: '<script src="https://evil.example/x.js"></script>', expected: null },
  { name: 'null-byte script', input: '<scr\u0000ipt>alert(1)</scr\u0000ipt>', expected: null },
  { name: 'img onerror', input: '<img src=x onerror=alert(1)>', expected: null },
  { name: 'img with a remote source', input: '<img src="https://evil.example/x.png">', expected: null },
  { name: 'svg onload', input: '<svg onload="alert(1)"></svg>', expected: null },
  { name: 'svg carrying a script', input: '<svg><script>alert(1)</script></svg>', expected: null },
  { name: 'math namespace confusion', input: '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', expected: null },
  { name: 'noscript breakout', input: '<noscript>alert(1)</noscript>', expected: null },
  { name: 'style breakout', input: '<style>body{background:url(javascript:alert(1))}</style>', expected: null },
  { name: 'iframe with a javascript URL', input: '<iframe src="javascript:alert(1)"></iframe>', expected: null },
  { name: 'object with a javascript URL', input: '<object data="javascript:alert(1)"></object>', expected: null },
  { name: 'embed with a javascript URL', input: '<embed src="javascript:alert(1)">', expected: null },
  { name: 'nested form', input: '<form action="javascript:alert(1)"><input name="x"></form>', expected: null },
  { name: 'comment-wrapped img', input: '<!--<img src=x onerror=alert(1)>-->', expected: null },
  { name: 'anchor with a javascript URL', input: '<a href="javascript:alert(1)">click</a>', expected: 'click' },
  { name: 'anchor with a data URL', input: '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', expected: 'x' },
  { name: 'anchor with an entity-encoded scheme', input: '<a href="&#106;avascript:alert(1)">click</a>', expected: 'click' },
  { name: 'div wrapper', input: '<div><p>wrapped</p></div>', expected: '<p>wrapped</p>' },
  { name: 'table markup', input: '<table><tr><td>x</td></tr></table>', expected: 'x' },
  { name: 'attribute breakout on a paragraph', input: '<p class="x" style="color:red" id="y" onclick="alert(1)">Text</p>', expected: '<p>Text</p>' },
  { name: 'handler only', input: '<p onclick=alert(1)>x</p>', expected: '<p>x</p>' },
  { name: 'style expression', input: '<p style="x:expression(alert(1))">y</p>', expected: '<p>y</p>' },
  { name: 'emphasis kept', input: '<p><b>bold</b> <i>it</i></p>', expected: '<p><b>bold</b> <i>it</i></p>' },
  { name: 'text beside a script', input: '<p>text</p><script>alert(1)</script>', expected: '<p>text</p>' },
  { name: 'entity-encoded script', input: '&lt;script&gt;alert(1)&lt;/script&gt;', expected: '&lt;script&gt;alert(1)&lt;/script&gt;' },
  { name: 'ampersand entity', input: '<p>R&amp;D</p>', expected: '<p>R&amp;D</p>' },
  { name: 'less-than entity', input: '<p>a &lt; b</p>', expected: '<p>a &lt; b</p>' },
  { name: 'bare ampersand', input: '<p>plain & bold</p>', expected: '<p>plain &amp; bold</p>' },
  { name: 'javascript URL in an image attribute', input: '<p>see</p><img data-media-id="not-a-uuid" src="javascript:alert(1)">', expected: '<p>see</p>' },
  { name: 'xmp fallback container', input: '<xmp><img src=x onerror=alert(1)></xmp>', expected: null },
  { name: 'noembed fallback container', input: '<noembed><img src=x onerror=alert(1)></noembed>', expected: null },
  { name: 'noframes fallback container', input: '<noframes><script>alert(1)</script></noframes>', expected: null },
  { name: 'title element', input: '<title>alert(1)</title>', expected: null },
  { name: 'head with a script', input: '<head><title>x</title><script>alert(1)</script></head>', expected: null },
  { name: 'zero-width space inside text', input: '<p>safe\u200btext</p>', expected: '<p>safetext</p>' },
];

const IMAGE_ID = '9f1b7a3e-0c2d-4e5f-8a9b-1c2d3e4f5a6b';

describe('question content sanitiser', () => {
  it('runs the whole payload suite against the question text', () => {
    for (const payload of PAYLOADS) {
      if (payload.expected === null) {
        expect(() => sanitizeQuestionContent(payload.input), payload.name).toThrow(ContentRejectedError);
      } else {
        expect(sanitizeQuestionContent(payload.input), payload.name).toBe(payload.expected);
      }
    }
  });

  it('runs the whole payload suite against an option', () => {
    for (const payload of PAYLOADS) {
      if (payload.expected === null) {
        expect(() => sanitizeQuestionContent(payload.input, 'option 1'), payload.name).toThrow(ContentRejectedError);
      } else {
        expect(sanitizeQuestionContent(payload.input, 'option 1'), payload.name).toBe(payload.expected);
      }
    }
  });

  it('runs the whole payload suite against the explanation', () => {
    for (const payload of PAYLOADS) {
      const stored = sanitizeOptionalContent(payload.input, 'explanation');
      expect(stored, payload.name).toBe(payload.expected === null ? null : payload.expected);
    }
  });

  it('keeps a reference to our own uploaded image and strips everything else from it', () => {
    const stored = sanitizeQuestionContent(`<p>See</p><img data-media-id="${IMAGE_ID}" src="https://evil.example/x.png">`);

    expect(stored).toContain(`data-media-id="${IMAGE_ID}"`);
    expect(stored).not.toContain('src=');
    expect(stored).not.toContain('evil.example');
    expect(mediaIdsIn(stored)).toEqual([IMAGE_ID]);
  });

  it('drops an image whose id is not one of ours, even when it carries a URL', () => {
    const stored = sanitizeQuestionContent('<p>See</p><img data-media-id="../../etc/passwd" src="https://evil.example/x.png">');

    expect(stored).toBe('<p>See</p>');
    expect(mediaIdsIn(stored)).toEqual([]);
  });

  it('drops an image and keeps the text beside it', () => {
    const stored = sanitizeQuestionContent('<img src=x onerror=alert(1)><p>safe</p>');

    expect(stored).toContain('<p>safe</p>');
    expect(stored).not.toContain('onerror');
    expect(stored).not.toContain('src=');
  });

  it('treats a line break as a line break', () => {
    const stored = sanitizeQuestionContent('<p>A<br onmouseover="alert(1)">B</p>');

    expect(stored).toMatch(/^<p>A<br\s*\/?>B<\/p>$/);
  });

  it('is a fixed point: sanitising the sanitised output changes nothing', () => {
    const inputs = [
      '<p>Plain <b>bold</b> and <i>italic</i></p>',
      '<div><p>wrapped</p></div>',
      `<p>See</p><img data-media-id="${IMAGE_ID}" alt="diagram">`,
      '<p>a &lt; b and R&amp;D</p>',
      '<p onclick="alert(1)">x<script>alert(1)</script></p>',
    ];

    for (const input of inputs) {
      const once = sanitizeQuestionContent(input);
      expect(sanitizeQuestionContent(once)).toBe(once);
      expect(sanitizeStoredContent(once)).toBe(once);
    }
  });

  it('rejects content that would not survive a second pass', () => {
    // The guard exists so the output of the sanitiser is always its own input; the suite
    // above proves it never trips on reasonable content, and this proves it is reachable.
    expect(() => sanitizeQuestionContent('<p>' + 'x'.repeat(20_001) + '</p>')).toThrow(/characters or fewer/);
  });

  it('refuses input nested deeper than the limit instead of parsing it', () => {
    const deep = `${'<b>'.repeat(20_000)}x${'</b>'.repeat(20_000)}`;
    const startedAt = Date.now();

    expect(() => sanitizeQuestionContent(deep)).toThrow(new RegExp(`nests more than ${MAX_NESTING_DEPTH} tags deep`));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('strips null bytes, control characters and bidirectional overrides', () => {
    expect(normalizeText('a\u0000b')).toBe('ab');
    expect(normalizeText('a\u0007b')).toBe('ab');
    expect(normalizeText('tab\tand\nnewline stay')).toBe('tab\tand\nnewline stay');
    expect(normalizeText('\u202eevil\u202c')).toBe('evil');
    expect(normalizeText('\u2066iso\u2069')).toBe('iso');
    expect(sanitizeQuestionContent('<p>a\u0000b</p>')).toBe('<p>ab</p>');
  });

  it('normalises to NFC, so one character is stored one way', () => {
    const decomposed = '<p>e\u0301</p>';
    const composed = '<p>\u00e9</p>';

    expect(sanitizeQuestionContent(decomposed)).toBe(composed);
    expect(normalizeText('e\u0301')).toBe('\u00e9');
  });

  it('decodes entities in plain text, so a search matches what the author typed', () => {
    expect(plainText('<p>a &lt; b</p>')).toBe('a < b');
    expect(plainText('<p>R&amp;D</p>')).toBe('R&D');
    expect(plainText('<p>R&#38;D</p>')).toBe('R&D');
    expect(decodeEntities('&lt;b&gt;')).toBe('<b>');
    expect(decodeEntities('&nbsp;x')).toBe(' x');
  });

  it('keeps LaTeX as typed but strips control characters from it', () => {
    expect(sanitizeLatex('  \\frac{1}{2}  ')).toBe('\\frac{1}{2}');
    expect(sanitizeLatex('x\u0000+y')).toBe('x+y');
    expect(sanitizeLatex('   ')).toBeNull();
  });

  it('re-applies the rules on output, so an old row cannot reach a student unsanitised', () => {
    expect(sanitizeStoredContent('<p>old</p><iframe src="https://evil"></iframe>')).toBe('<p>old</p>');
    expect(sanitizeStoredContent('<p onclick="alert(1)">old</p>')).toBe('<p>old</p>');
  });

  it('normalises an image reference however the author wrote the attribute', () => {
    const encoded = `&#57;${IMAGE_ID.slice(1)}`;
    const upperCased = IMAGE_ID.toUpperCase();

    for (const input of [
      `<p>See</p><img data-media-id='${encoded}'>`,
      `<p>See</p><img DATA-MEDIA-ID="${upperCased}">`,
    ]) {
      const stored = sanitizeQuestionContent(input);

      // Single quotes, entity-encoded digits, an upper-case attribute name and upper-case
      // hex all end at the same reference — the value the ownership check then looks up.
      expect(mediaIdsIn(stored)).toEqual([IMAGE_ID]);
      expect(stored).not.toContain('src=');
    }
  });

  it('strips C1 controls, Unicode tag characters and invisible filler', () => {
    expect(normalizeText('a\u0085b')).toBe('ab');
    expect(normalizeText('a\u009fb')).toBe('ab');
    expect(normalizeText('a\u{e0041}b')).toBe('ab');
    expect(normalizeText('a\u200bb')).toBe('ab');
    expect(normalizeText('a\u2060b')).toBe('ab');
    expect(normalizeText('a\ufeffb')).toBe('ab');
  });

  it('keeps the joiners Devanagari conjuncts need', () => {
    const withZwj = '\u0915\u094d\u200d\u0937';
    const withZwnj = '\u0915\u094d\u200c\u0937';

    expect(normalizeText(withZwj)).toBe(withZwj);
    expect(normalizeText(withZwnj)).toBe(withZwnj);
    expect(sanitizeQuestionContent(`<p>${withZwj} and ${withZwnj}</p>`)).toBe(`<p>${withZwj} and ${withZwnj}</p>`);
  });
});
