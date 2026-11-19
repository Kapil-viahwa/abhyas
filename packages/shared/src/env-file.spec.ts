import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EnvValidationError, validateEnv } from './env';

/**
 * The production environment check.
 *
 * Run it against a candidate production `.env` before a deploy, without starting the stack:
 *
 *   PROD_ENV_FILE=./.env.prod pnpm exec vitest run packages/shared/src/env-file.spec.ts
 *
 * It reads the file and hands it to `validateEnv`, the same function the API and the worker
 * boot through, and prints **only variable names and the validator's messages** — never a
 * value. Without `PROD_ENV_FILE` the file check is skipped; the parser test always runs.
 */
export function parseEnvFile(source: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);

    if (match === null) {
      continue;
    }

    const key = match[1] as string;
    let value = (match[2] ?? '').trim();

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

describe('a candidate production environment file', () => {
  it('parses KEY=value lines, quoted values and comments', () => {
    expect(parseEnvFile("# a comment\nA=1\nB='two words'\nD=\n\nE=a=b\n")).toEqual({
      A: '1',
      B: 'two words',
      D: '',
      E: 'a=b',
    });
  });

  const path = process.env.PROD_ENV_FILE ?? '';
  const check = path === '' ? it.skip : it;

  check('is accepted by the shared validator, naming only variables', () => {
    let values: Record<string, string>;

    try {
      values = parseEnvFile(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`could not read the environment file: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      validateEnv(values);
    } catch (error) {
      if (error instanceof EnvValidationError) {
        throw new Error(
          `the production environment is refused:\n${error.issues
            .map((issue) => `  - ${issue.variable}: ${issue.message}`)
            .join('\n')}`,
        );
      }

      throw error;
    }

    expect(Object.keys(values).length).toBeGreaterThan(0);
  });
});
