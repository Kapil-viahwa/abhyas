import { execFileSync } from 'node:child_process';

/**
 * The coin settings a browser spec reads, pinned for the spec that reads them.
 *
 * The e2e stack is one database shared by every spec of the run, and the specs run in file
 * order: one that changes a setting must not leave another spec's expectation to whatever it
 * chose. This upserts and reads the value back, so a fixture that did not land fails in the
 * spec that wrote it, with its own message, instead of surfacing as a wrong balance later.
 */
export type CoinSetting =
  | 'signup_coins'
  | 'daily_reward_coins'
  | 'coin_max_bulk_users'
  | 'coin_max_bulk_coins'
  | 'default_enrollment_cost';

export function setCoinSetting(key: CoinSetting, value: number): void {
  const sql = [
    'DO $$',
    'DECLARE landed integer;',
    'BEGIN',
    '  INSERT INTO settings (key, value_type, value_int)',
    `  VALUES ('${key}', 'integer', ${String(value)})`,
    '  ON CONFLICT (key) DO UPDATE SET value_int = EXCLUDED.value_int',
    '  RETURNING value_int INTO landed;',
    `  IF landed IS DISTINCT FROM ${String(value)} THEN`,
    `    RAISE EXCEPTION '${key} did not land at ${String(value)} (it is %)', landed;`,
    '  END IF;',
    'END $$;',
  ].join('\n');

  execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'abhyas', '-d', 'abhyas', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}
