import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

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
  DATABASE_URL: 'postgresql://abhyas_app:app-password@postgres:5432/abhyas',
  MIGRATION_DATABASE_URL: 'postgresql://abhyas:compose-check-password@postgres:5432/abhyas',
  REDIS_URL: 'redis://redis:6379',
  AUTH_SECRET: 'c'.repeat(48),
  TURNSTILE_SECRET_KEY: 'live-turnstile-secret',
  TURNSTILE_SITE_KEY: 'live-site-key',
  SMS_PROVIDER: 'msg91',
  EMAIL_PROVIDER: 'smtp',
  WEB_URL: 'https://abhyas.example.com',
  REVALIDATE_SECRET: 'r'.repeat(32),
  S3_ENDPOINT: 'https://storage.example.com',
  S3_BUCKET: 'abhyas-media',
  S3_ACCESS_KEY_ID: 'live-access-key',
  S3_SECRET_ACCESS_KEY: 'live-secret-value-0123456789',
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

// Client-address trust (decision 0052): the API trusts exactly the web container by address,
// and the web tier trusts exactly the hops in front of it. A subnet, or "true", here would
// let a caller pick the address it is counted by and step out of the per-IP limits.
const webNetworks = services.web?.networks ?? {};
const webNetwork = Array.isArray(webNetworks) ? {} : (Object.values(webNetworks)[0] ?? {});
const webAddress = String(webNetwork.ipv4_address ?? '');
const apiTrustProxy = String(services.api?.environment?.TRUST_PROXY ?? '');
const webTrustProxy = String(services.web?.environment?.TRUST_PROXY ?? '');

if (webAddress === '') {
  failures.push('service "web" has no fixed address, so the API cannot name it as its only proxy');
} else if (apiTrustProxy !== `${webAddress}/32`) {
  failures.push(
    `service "api" trusts "${apiTrustProxy}" as a proxy; it must be exactly the web tier, "${webAddress}/32"`,
  );
} else {
  passes.push(`service "api" trusts exactly the web tier as its proxy (${apiTrustProxy})`);
}

if (!/^[0-9]+$/.test(webTrustProxy) || Number(webTrustProxy) < 1 || Number(webTrustProxy) > 10) {
  failures.push(
    `service "web" sets TRUST_PROXY "${webTrustProxy}"; it must be the hop count of the edge in front of it (1-10)`,
  );
} else {
  passes.push(`service "web" trusts ${webTrustProxy} edge hop(s) in front of it`);
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

  // The fixed code exists so a browser test can type a code it knows. It is meaningless
  // here, and its presence would mean somebody copied the CI fixture into production.
  if (environment.OTP_FAKE_FIXED_CODE !== undefined) {
    failures.push(`service "${name}" sets OTP_FAKE_FIXED_CODE, which is a test fixture`);
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
  ['TURNSTILE_SITE_KEY', 'TURNSTILE_SITE_KEY'],
  ['MIGRATION_DATABASE_URL', 'MIGRATION_DATABASE_URL'],
  ['WEB_URL', 'WEB_URL'],
  ['REVALIDATE_SECRET', 'REVALIDATE_SECRET'],
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

// The OTP override is a development and CI fixture (decision 0051). Production must not
// mention it, and must not carry the fixed code that only the fake provider may use.
const composeSource = readFileSync(COMPOSE_FILE, 'utf8');

if (/docker-compose\.otp\.yml/.test(composeSource)) {
  failures.push(`${COMPOSE_FILE} names docker-compose.otp.yml, which turns on the fake provider`);
} else {
  passes.push(`${COMPOSE_FILE} never includes docker-compose.otp.yml`);
}

if (/OTP_FAKE_FIXED_CODE/.test(composeSource)) {
  failures.push(`${COMPOSE_FILE} sets OTP_FAKE_FIXED_CODE, which is a test fixture`);
} else {
  passes.push(`${COMPOSE_FILE} never sets OTP_FAKE_FIXED_CODE`);
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
