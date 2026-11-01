import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/**
 * Proves the production compose file has no development shortcuts:
 * - Postgres and Redis publish no host ports.
 * - The API publishes no host ports (only the web tier is reachable).
 * - API, worker and migrations run with NODE_ENV=production.
 * - No service enables dev login or a fake SMS provider.
 * - No service bind-mounts host paths.
 * - `docker compose config` refuses to render when a required secret is missing.
 */

const COMPOSE_FILE = 'docker-compose.prod.yml';

const requiredEnv = {
  POSTGRES_USER: 'abhyas',
  POSTGRES_PASSWORD: 'compose-check-password',
  POSTGRES_DB: 'abhyas',
  DATABASE_URL: 'postgresql://abhyas:compose-check-password@postgres:5432/abhyas',
  REDIS_URL: 'redis://redis:6379',
  AUTH_SECRET: 'c'.repeat(48),
  TURNSTILE_SECRET_KEY: 'live-turnstile-secret',
  SMS_PROVIDER: 'msg91',
};

function renderConfig(env) {
  return JSON.parse(
    execFileSync('docker', ['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json'], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

const failures = [];
const passes = [];

let config;
try {
  config = renderConfig(requiredEnv);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Could not render ${COMPOSE_FILE} with a complete environment:\n${detail}`);
  process.exit(1);
}

const services = config.services ?? {};

for (const name of ['postgres', 'redis']) {
  const service = services[name];
  if (!service) {
    failures.push(`service "${name}" is missing from ${COMPOSE_FILE}`);
    continue;
  }
  const published = service.ports ?? [];
  if (published.length > 0) {
    failures.push(`service "${name}" publishes host ports: ${JSON.stringify(published)}`);
  } else {
    passes.push(`service "${name}" publishes no host ports`);
  }
}

if (!services.api) {
  failures.push(`service "api" is missing from ${COMPOSE_FILE}`);
} else if ((services.api.ports ?? []).length > 0) {
  failures.push('service "api" publishes host ports; only the web tier may be reachable');
} else {
  passes.push('service "api" publishes no host ports');
}

for (const name of ['api', 'worker', 'migrations']) {
  const environment = services[name]?.environment ?? {};
  if (environment.NODE_ENV !== 'production') {
    failures.push(`service "${name}" does not run with NODE_ENV=production`);
  } else {
    passes.push(`service "${name}" runs with NODE_ENV=production`);
  }
}

for (const [name, service] of Object.entries(services)) {
  const environment = service.environment ?? {};

  if (String(environment.ALLOW_DEV_LOGIN ?? '').toLowerCase() === 'true') {
    failures.push(`service "${name}" enables ALLOW_DEV_LOGIN in production`);
  }

  const sms = String(environment.SMS_PROVIDER ?? '').toLowerCase();
  if (sms === 'fake' || sms === 'console') {
    failures.push(`service "${name}" uses the "${sms}" SMS provider in production`);
  }

  for (const volume of service.volumes ?? []) {
    if (volume.type === 'bind') {
      failures.push(`service "${name}" bind-mounts ${volume.source}; production must use named volumes`);
    }
  }
}

for (const [variable, label] of [
  ['AUTH_SECRET', 'AUTH_SECRET'],
  ['TURNSTILE_SECRET_KEY', 'TURNSTILE_SECRET_KEY'],
]) {
  let refused = false;
  try {
    renderConfig({ ...requiredEnv, [variable]: '' });
  } catch {
    refused = true;
  }
  if (refused) {
    passes.push(`${COMPOSE_FILE} refuses to render without ${label}`);
  } else {
    failures.push(`${COMPOSE_FILE} rendered without ${label}; a default secret is being used`);
  }
}

const report = [];
for (const line of passes) {
  report.push(`- ok: ${line}`);
}
for (const line of failures) {
  report.push(`- FAIL: ${line}`);
}
console.log(report.join('\n'));

if (process.env.GITHUB_STEP_SUMMARY) {
  const heading = failures.length === 0 ? '### Production compose validated' : '### Production compose validation failed';
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${heading}\n\n${report.join('\n')}\n`);
}

if (failures.length > 0) {
  process.exit(1);
}
