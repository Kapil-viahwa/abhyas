/**
 * CSV for the coin tools.
 *
 * A cell a spreadsheet would treat as a formula is neutralised before it is written: a
 * remark or an error message that begins with `=`, `+`, `-` or `@` is data here, and a
 * downloaded report is opened in a spreadsheet by definition. The leading apostrophe keeps
 * it data in every one of them.
 */

const FORMULA_START = /^[=+\-@]/;

export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = FORMULA_START.test(text) ? `'${text}` : text;

  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  return guarded;
}

export function csvLine(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}
