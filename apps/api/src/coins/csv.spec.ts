import { describe, expect, it } from 'vitest';

import { csvCell } from './csv';

describe('a CSV cell a spreadsheet cannot be talked into running', () => {
  it('neutralises every formula start', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+44 7700 900000')).toBe("'+44 7700 900000");
    expect(csvCell('-10')).toBe("'-10");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('quotes what RFC 4180 requires and leaves plain text alone', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
  });
});
