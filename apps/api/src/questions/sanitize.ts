import sanitizeHtml from 'sanitize-html';

/**
 * The one sanitiser for authored content, and the rules it keeps.
 *
 * TipTap produces HTML and the API never trusts it: the same allowlist runs on question
 * text, option text and explanations, on direct saves, on bulk import and again on output,
 * so what a student receives is derived from what the author typed and nothing else.
 *
 * The subset is prose: paragraphs, line breaks, emphasis, lists, sub/superscript and code.
 * No links and no styling attributes — a question has no use for them — and the only image
 * it may carry is a reference to a stored upload, by id, never a URL.
 */

export const MAX_CONTENT_LENGTH = 20_000;
export const MAX_LATEX_LENGTH = 4_000;
export const MAX_NESTING_DEPTH = 50;

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'img',
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  // An image is a reference and a description; nothing else survives, so style, class, id
  // and every `on*` handler are dropped by construction rather than by a filter.
  img: ['data-media-id', 'alt'],
};

/**
 * The containers whose content is not prose at all.
 *
 * `discard` removes a tag and keeps its text; for these the text is the payload (a script,
 * a style sheet, a vector document, a math namespace used to confuse parsers, a form), so
 * it is dropped whole.
 */
const NON_TEXT_TAGS = [
  'script',
  'style',
  'textarea',
  'option',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'form',
  // Metadata and fallback containers: their text is markup instructions, not prose, and a
  // browser that later parses it as HTML would act on it.
  'xmp',
  'noembed',
  'noframes',
  'title',
  'head',
];

const VOID_TAGS = new Set(['br', 'img', 'hr']);

/** The one shape a tag transform may return, so both branches of one have the same type. */
interface TransformedTag {
  readonly tagName: string;
  readonly attribs: Record<string, string>;
}

/**
 * An uploaded image is referenced by its row id and nothing else. An `img` without one, or
 * with a URL where one belongs, is removed: a question never loads anything from a third
 * party.
 */
const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Bidirectional overrides and isolates, and the two direction marks. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** C0 controls and DEL, except tab, line feed and carriage return. */
// eslint-disable-next-line no-control-regex -- listing these code points is the point; none is typed literally.
const C0_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** C1 controls, the zero-width space, the word joiner and the byte-order mark. */
const INVISIBLE_CHARACTERS = /[\u0080-\u009f\u200b\u2060\ufeff]/g;

/** Unicode tag characters, the private-use block a model-facing payload can hide text in. */
// eslint-disable-next-line no-control-regex -- the range is the thing being removed, typed by code point.
const TAG_CHARACTERS = /[\u{e0000}-\u{e007f}]/gu;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export class ContentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentRejectedError';
  }
}

/**
 * Text as it will be stored: composed (NFC), with control characters, null bytes, Unicode
 * tag characters, zero-width filler and bidirectional overrides removed. A bidi override
 * renders one string and reads as another, so it has no place in a question a student is
 * answering.
 *
 * The zero-width joiner (U+200C) and non-joiner (U+200D) are deliberately kept: Devanagari
 * conjuncts are written with them, so removing them would change the Hindi an author typed.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(BIDI_CONTROLS, '')
    .replace(C0_CONTROLS, '')
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(TAG_CHARACTERS, '');
}

/**
 * A question is prose, not a document tree. Twenty thousand nested tags would be flattened
 * by the parser anyway, but only after it had built the tree, so the depth is measured on
 * the raw string first and the input is refused before that work happens.
 */
function assertNesting(value: string, field: string): void {
  const tagPattern = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi;
  let depth = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(value)) !== null) {
    const name = (match[2] ?? '').toLowerCase();
    if (VOID_TAGS.has(name)) {
      continue;
    }
    if (match[1] === '/') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    depth += 1;
    if (depth > MAX_NESTING_DEPTH) {
      throw new ContentRejectedError(`${field} nests more than ${MAX_NESTING_DEPTH} tags deep`);
    }
  }
}

function fragment(value: string): string {
  const cleaned = sanitizeHtml(value, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: [],
    disallowedTagsMode: 'discard',
    nonTextTags: NON_TEXT_TAGS,
    allowedClasses: {},
    parser: { lowerCaseAttributeNames: true },
    transformTags: {
      img: (_tagName: string, attribs: Record<string, string>): TransformedTag => {
        const id = String(attribs['data-media-id'] ?? '')
          .trim()
          .toLowerCase();

        if (!MEDIA_ID_PATTERN.test(id)) {
          return { tagName: '', attribs: {} };
        }

        return { tagName: 'img', attribs: { 'data-media-id': id, alt: String(attribs.alt ?? '').slice(0, 200) } };
      },
    },
  }).trim();

  // Belt and braces: whatever the parser did with an `img` that carries no reference of
  // ours is removed here, so a question can never render an image from anywhere else.
  return cleaned.replace(/<img(?![^>]*data-media-id="[0-9a-f-]{36}")[^>]*>/gi, '');
}

/**
 * Sanitising twice must equal sanitising once. The output is required to be a fixed point
 * of this function — a sanitiser that keeps changing its own output cannot be reasoned
 * about — so a value that moves on the second pass is refused rather than stored.
 */
function fragmentAtFixedPoint(value: string, field: string): string {
  const once = fragment(value);
  if (once === '') {
    return '';
  }

  if (fragment(once) !== once) {
    throw new ContentRejectedError(`${field} could not be stored safely`);
  }

  return once;
}

/** Sanitised HTML for storage, or a rejection when nothing meaningful is left. */
export function sanitizeQuestionContent(value: unknown, field = 'content'): string {
  if (typeof value !== 'string') {
    throw new ContentRejectedError(`${field} is required`);
  }

  const text = normalizeText(value);
  // Depth first: the limit that gives the specific answer is the structural one, and the
  // scan is linear, so it costs nothing on input that is merely long.
  assertNesting(text, field);
  if (text.length > MAX_CONTENT_LENGTH) {
    throw new ContentRejectedError(`${field} must be ${MAX_CONTENT_LENGTH} characters or fewer`);
  }

  const clean = fragmentAtFixedPoint(text, field);
  if (clean === '' || plainText(clean) === '') {
    throw new ContentRejectedError(`${field} is required`);
  }

  return clean;
}

/** Explanations are optional, so an empty (or fully stripped) value is allowed. */
export function sanitizeOptionalContent(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ContentRejectedError(`${field} must be text`);
  }

  const text = normalizeText(value);
  assertNesting(text, field);
  if (text.length > MAX_CONTENT_LENGTH) {
    throw new ContentRejectedError(`${field} must be ${MAX_CONTENT_LENGTH} characters or fewer`);
  }

  const clean = fragmentAtFixedPoint(text, field);
  return clean === '' ? null : clean;
}

/**
 * The output pass, run again when stored content is read back, so a row written by an
 * earlier version of these rules can never reach a student unsanitised.
 */
export function sanitizeStoredContent(html: string): string {
  return fragment(normalizeText(html));
}

/** Every uploaded image a piece of content refers to. */
export function mediaIdsIn(html: string): string[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(/data-media-id="([^"]*)"/gi)) {
    const id = (match[1] ?? '').toLowerCase();
    if (MEDIA_ID_PATTERN.test(id)) {
      ids.add(id);
    }
  }
  return [...ids];
}

/** Named and numeric character references, so a search matches what the author typed. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * The string a search runs against, and the string a list screen shows.
 *
 * The result is plain text and must never be rendered as HTML: React escapes it when it is
 * placed in a text node, and `questionPreview` on the web side is the only consumer that
 * puts it on a page. Anything that needs markup goes through `sanitizeStoredContent` instead.
 */
export function plainText(html: string): string {
  const stripped = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

export function sanitizeLatex(value: unknown, field = 'latex'): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ContentRejectedError(`${field} must be text`);
  }

  // Backslashes are the point of LaTeX, so no escaping happens here. The renderer runs
  // with trust disabled, which is where markup would have to come from.
  const trimmed = normalizeText(value).trim();
  if (trimmed.length > MAX_LATEX_LENGTH) {
    throw new ContentRejectedError(`${field} must be ${MAX_LATEX_LENGTH} characters or fewer`);
  }

  return trimmed === '' ? null : trimmed;
}
