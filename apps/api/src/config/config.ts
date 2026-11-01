import { validateEnv, type AppEnv } from '@abhyas/shared';

/**
 * Loads and validates the environment. Throws EnvValidationError, which the
 * bootstrap catches to refuse to start. This is the API's boot gate.
 */
export function loadConfig(raw: Readonly<Record<string, string | undefined>> = process.env): AppEnv {
  return validateEnv(raw);
}
