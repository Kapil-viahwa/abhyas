import sanitizeHtml from 'sanitize-html';

/**
 * The one sanitiser for authored content.
 *
 * TipTap produces HTML and the API never trusts it: the same allowlist runs on question
 * text, option text and explanations, on direct saves and on bulk import. The subset is
 * deliberately small — paragraphs, line breaks, emphasis, lists, sub/superscript and code
 * — because a question is prose, not a document. Links are not allowed: an author has no
 * reason to put one in a question, and a link is the easiest way to smuggle a scheme.
 */

export const MAX_CONTENT_LENGTH = 20_000;
export const MAX_LATEX_LENGTH = 4_000;

const ALLOWED_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'sub', 'sup', 'code', 'pre', 'blockquote'];
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  // KaTeX markup is produced by the web layer, never accepted from an author, so no
  // attribute survives at all today. The map is explicit to keep that a decision.
};

export class ContentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentRejectedError';
  }
}

function sanitizeFragment(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: [],
    disallowedTagsMode: 'discard',
    // A question never needs an image in its text: images are separate assets with ids.
    allowedClasses: {},
    parser: { lowerCaseAttributeNames: true },
  }).trim();
}

/** Sanitised HTML for storage, or a rejection when nothing meaningful is left. */
export function sanitizeQuestionContent(value: unknown, field = 'content'): string {
  if (typeof value !== 'string') {
    throw new ContentRejectedError(`${field} is required`);
  }
  if (value.length > MAX_CONTENT_LENGTH) {
    throw new ContentRejectedError(`${field} must be ${MAX_CONTENT_LENGTH} characters or fewer`);
  }

  const clean = sanitizeFragment(value);
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
  if (value.length > MAX_CONTENT_LENGTH) {
    throw new ContentRejectedError(`${field} must be ${MAX_CONTENT_LENGTH} characters or fewer`);
  }

  const clean = sanitizeFragment(value);
  return clean === '' ? null : clean;
}

/** The string a search runs against: tags out, entities kept simple. */
export function plainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeLatex(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ContentRejectedError('latex must be text');
  }
  if (value.length > MAX_LATEX_LENGTH) {
    throw new ContentRejectedError(`latex must be ${MAX_LATEX_LENGTH} characters or fewer`);
  }

  // Backslashes are the point of LaTeX, so no escaping happens here. The renderer runs
  // with trust disabled, which is where markup would have to come from.
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
