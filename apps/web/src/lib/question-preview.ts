/**
 * The line a list screen shows for a question.
 *
 * Stored HTML is reduced to text and returned as a plain string. The list pages place it in
 * a text node, so React escapes it and nothing an author wrote can become markup — an
 * `<img onerror>` is not an image here, it is nothing at all. Anything that needs markup
 * goes through the sanitiser on the server instead.
 */
const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/**
 * The containers whose text is not prose but an instruction to a browser: their content is
 * removed with the tag, exactly as the server's sanitiser does, so a caption never shows a
 * script body as if it were the question.
 */
const NON_TEXT_ELEMENT = /<(script|style|textarea|title|head|xmp|noembed|noframes)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

export function questionPreview(html: string, limit = 120): string {
  const text = html
    .replace(NON_TEXT_ELEMENT, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (match) => NAMED_ENTITIES[match] ?? match)
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
