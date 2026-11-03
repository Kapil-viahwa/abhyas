import katex from 'katex';

/**
 * KaTeX, with the settings the whole platform uses.
 *
 * `trust: false` is the important one: `\href`, `\url`, `\includegraphics` and `\htmlClass`
 * are not in KaTeX's own command list, and with trust disabled they cannot produce a link,
 * an image or a class attribute — the renderer shows them as an error instead.
 * `throwOnError: false` keeps one author's typo from breaking a page, and the error text is
 * escaped by KaTeX itself, so nothing an author types ever becomes markup.
 *
 * `maxSize` and `maxExpand` bound the work a single expression may ask for: a macro that
 * expands into thousands of copies is refused rather than rendered.
 */
export const KATEX_OPTIONS = {
  throwOnError: false,
  trust: false,
  strict: 'error' as const,
  displayMode: true,
  maxSize: 50,
  maxExpand: 1000,
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Rendered LaTeX markup, or escaped text when KaTeX refuses the input outright. */
export function renderLatex(latex: string): string {
  if (latex.trim() === '') {
    return '';
  }

  try {
    return katex.renderToString(latex, KATEX_OPTIONS);
  } catch {
    return escapeHtml(latex);
  }
}
