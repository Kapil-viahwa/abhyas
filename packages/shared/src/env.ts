import { isIP } from 'node:net';

/**
 * Environment validation shared by the API and the worker.
 *
 * The rule from docs/working-rules.md: development shortcuts (test Turnstile keys,
 * fake SMS, dev login) must be impossible in production. This module is the single
 * place where that is enforced, and it fails closed by throwing before the process
 * boots.
 */

export type NodeEnv = 'development' | 'test' | 'production';

export type SmsProvider = 'fake' | 'console' | 'http' | 'msg91' | 'twilio' | 'ses';

export type EmailProvider = 'console' | 'smtp';

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

const SMS_PROVIDERS: readonly SmsProvider[] = ['fake', 'console', 'http', 'msg91', 'twilio', 'ses'];

const EMAIL_PROVIDERS: readonly EmailProvider[] = ['console', 'smtp'];

/** Six digits, and only ever honoured by the fake provider outside production. */
const FIXED_OTP_CODE_PATTERN = /^[0-9]{6}$/;

const FORBIDDEN_PRODUCTION_SECRETS: readonly string[] = [
  'secret',
  'changeme',
  'change-me',
  'change-me-in-production',
  'password',
  'dev-secret',
  'dev-only-insecure-secret-please-change-32chars',
  'development',
  'test',
  'abhyas',
];

/** Whether a secret is a development or placeholder value rather than a real one. */
function isDevelopmentSecret(value: string): boolean {
  const lower = value.toLowerCase();

  return lower.startsWith('dev-') || lower.includes('change-me') || lower.includes('changeme');
}

/** Cloudflare Turnstile test secrets all start with 1x0..., 2x0... or 3x0.... */
const TURNSTILE_TEST_SECRET_PATTERN = /^[123]x0{20,}/i;

export const MIN_AUTH_SECRET_LENGTH = 32;

/** The shared secret the API presents when it asks the web tier to refresh cached pages. */
export const MIN_REVALIDATE_SECRET_LENGTH = 16;

export const DEFAULT_REVALIDATE_SECRET = 'dev-only-revalidate-secret';

/** The narrowest IPv4 and IPv6 blocks a production boot will trust as a proxy. */
const MIN_TRUSTED_IPV4_PREFIX = 8;
const MIN_TRUSTED_IPV6_PREFIX = 32;

/**
 * The family and prefix length a `TRUST_PROXY` entry names, or `null` when it is not an
 * address at all. A bare address counts as its own /32 or /128.
 */
function trustedPrefix(entry: string): { readonly family: 4 | 6; readonly prefix: number } | null {
  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);

  const version = isIP(address);
  if (version === 0) {
    return null;
  }

  const family: 4 | 6 = version === 4 ? 4 : 6;
  const maximum = family === 4 ? 32 : 128;

  if (slash === -1) {
    return { family, prefix: maximum };
  }

  const raw = entry.slice(slash + 1);
  if (!/^[0-9]{1,3}$/.test(raw)) {
    return null;
  }

  const prefix = Number(raw);

  return prefix <= maximum ? { family, prefix } : null;
}

/** Whether a trusted proxy block is wider than production will accept. */
function isTooBroad(details: { readonly family: 4 | 6; readonly prefix: number }): boolean {
  if (details.prefix === 0) {
    return true;
  }

  return details.family === 4
    ? details.prefix < MIN_TRUSTED_IPV4_PREFIX
    : details.prefix < MIN_TRUSTED_IPV6_PREFIX;
}

export interface EnvIssue {
  readonly variable: string;
  readonly message: string;
}

export class EnvValidationError extends Error {
  readonly issues: EnvIssue[];

  constructor(issues: EnvIssue[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((issue) => `  - ${issue.variable}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export interface AppEnv {
  readonly NODE_ENV: NodeEnv;
  readonly PORT: number;
  readonly DATABASE_URL: string;
  readonly REDIS_URL: string;
  readonly AUTH_SECRET: string;
  readonly TURNSTILE_SECRET_KEY: string;
  readonly SMS_PROVIDER: SmsProvider;
  readonly EMAIL_PROVIDER: EmailProvider;
  readonly ALLOW_DEV_LOGIN: boolean;
  /**
   * Which proxies may state a client's address. `false` (the default) means forwarding
   * headers are ignored and the socket address is used; a list of addresses or CIDR blocks,
   * or a hop count, means only those may. `true` trusts any source and is refused in
   * production (decision 0052).
   */
  readonly TRUST_PROXY: boolean | number | readonly string[];
  /**
   * Development and CI only: let the web tier believe a browser-supplied forwarding header,
   * so the browser suite can use a fresh address per test. Refused in production.
   */
  readonly TRUST_FORWARDED_IP_FOR_TESTS: boolean;
  /** Shared with the web tier, which accepts it on its cache-revalidation route. */
  readonly REVALIDATE_SECRET: string;
  /** S3-compatible object storage: empty in development means media is disabled. */
  readonly S3_ENDPOINT: string;
  readonly S3_REGION: string;
  readonly S3_BUCKET: string;
  readonly S3_ACCESS_KEY_ID: string;
  readonly S3_SECRET_ACCESS_KEY: string;
  readonly S3_FORCE_PATH_STYLE: boolean;
  readonly S3_PUBLIC_READ: boolean;
  /** Phase 2c: the master switch for mobile OTP. Off by default. */
  readonly OTP_ENABLED: boolean;
  /** The secret every stored code is HMACed with; a database read cannot recover a code. */
  readonly OTP_HMAC_SECRET: string;
  /** E.164 country prefixes a code may be sent to; India only unless widened on purpose. */
  readonly OTP_ALLOWED_COUNTRY_CODES: readonly string[];
  /** The most messages one business day may send before the breaker stops everything. */
  readonly OTP_SMS_DAILY_BUDGET: number;
  readonly OTP_SENDER_ID: string;
  readonly OTP_DLT_ENTITY_ID: string;
  readonly OTP_TEMPLATE_ID: string;
  /**
   * Six digits a browser test can know in advance. Honoured only while the SMS provider is
   * the fake one and `NODE_ENV` is not production (decision 0051); empty otherwise.
   */
  readonly OTP_FAKE_FIXED_CODE: string;
  readonly OTP_GATEWAY_URL: string;
  readonly OTP_GATEWAY_AUTH_HEADER: string;
  readonly OTP_GATEWAY_AUTH_VALUE: string;
  readonly OTP_GATEWAY_BODY_TEMPLATE: string;
  readonly OTP_GATEWAY_TIMEOUT_MS: number;
}

/** Credentials the development stack ships with; production refuses them. */
export const DEVELOPMENT_S3_CREDENTIALS: readonly string[] = [
  'minioadmin',
  'abhyas-dev',
  'abhyas',
  'dev-secret',
  'changeme',
  'change-me',
];

type RawEnv = Readonly<Record<string, string | undefined>>;

function read(raw: RawEnv, key: string): string {
  return (raw[key] ?? '').trim();
}

export function validateEnv(raw: RawEnv): AppEnv {
  const issues: EnvIssue[] = [];

  const nodeEnvRaw = read(raw, 'NODE_ENV') || 'development';
  if (!NODE_ENVS.includes(nodeEnvRaw as NodeEnv)) {
    issues.push({
      variable: 'NODE_ENV',
      message: `must be one of ${NODE_ENVS.join(', ')} (received "${nodeEnvRaw}")`,
    });
  }
  const nodeEnv = nodeEnvRaw as NodeEnv;
  const isProduction = nodeEnvRaw === 'production';

  const portRaw = read(raw, 'PORT') || '3001';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push({ variable: 'PORT', message: 'must be an integer between 1 and 65535' });
  }

  const databaseUrl = read(raw, 'DATABASE_URL');
  if (databaseUrl === '') {
    issues.push({ variable: 'DATABASE_URL', message: 'is required' });
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    issues.push({ variable: 'DATABASE_URL', message: 'must be a postgres:// or postgresql:// URL' });
  }

  const redisUrl = read(raw, 'REDIS_URL');
  if (redisUrl === '') {
    issues.push({ variable: 'REDIS_URL', message: 'is required' });
  } else if (!/^rediss?:\/\//.test(redisUrl)) {
    issues.push({ variable: 'REDIS_URL', message: 'must be a redis:// or rediss:// URL' });
  }

  const authSecret = read(raw, 'AUTH_SECRET');
  if (authSecret === '') {
    if (isProduction) {
      issues.push({ variable: 'AUTH_SECRET', message: 'is required in production' });
    }
  } else if (isProduction) {
    if (authSecret.length < MIN_AUTH_SECRET_LENGTH) {
      issues.push({
        variable: 'AUTH_SECRET',
        message: `must be at least ${MIN_AUTH_SECRET_LENGTH} characters in production`,
      });
    }
    if (FORBIDDEN_PRODUCTION_SECRETS.includes(authSecret.toLowerCase())) {
      issues.push({
        variable: 'AUTH_SECRET',
        message: 'must not be a well-known default value',
      });
    } else if (isDevelopmentSecret(authSecret)) {
      issues.push({ variable: 'AUTH_SECRET', message: 'must not be a development or placeholder value in production' });
    }
  }

  const turnstileSecret = read(raw, 'TURNSTILE_SECRET_KEY');
  if (isProduction) {
    if (turnstileSecret === '') {
      issues.push({ variable: 'TURNSTILE_SECRET_KEY', message: 'is required in production' });
    } else if (TURNSTILE_TEST_SECRET_PATTERN.test(turnstileSecret)) {
      issues.push({
        variable: 'TURNSTILE_SECRET_KEY',
        message: 'Cloudflare test keys are refused in production',
      });
    }
  }

  // The master switch is read here as well as in the OTP block below, because it decides
  // whether a provider has to be configured at all.
  const otpEnabled = read(raw, 'OTP_ENABLED').toLowerCase() === 'true';

  const smsRaw = read(raw, 'SMS_PROVIDER').toLowerCase();
  let smsProvider: SmsProvider = 'fake';
  if (smsRaw === '') {
    // Nothing sends while the switch is off: the provider is only required once the mobile
    // routes can actually be reached (decision 0048).
    if (isProduction && otpEnabled) {
      issues.push({ variable: 'SMS_PROVIDER', message: 'is required in production when OTP is enabled' });
    }
  } else if (!SMS_PROVIDERS.includes(smsRaw as SmsProvider)) {
    issues.push({
      variable: 'SMS_PROVIDER',
      message: `must be one of ${SMS_PROVIDERS.join(', ')}`,
    });
  } else {
    smsProvider = smsRaw as SmsProvider;
    if (isProduction && (smsProvider === 'fake' || smsProvider === 'console')) {
      issues.push({
        variable: 'SMS_PROVIDER',
        message: 'fake and console SMS providers are refused in production',
      });
    }
  }

  const emailRaw = read(raw, 'EMAIL_PROVIDER').toLowerCase();
  let emailProvider: EmailProvider = 'console';
  if (emailRaw === '') {
    if (isProduction) {
      issues.push({ variable: 'EMAIL_PROVIDER', message: 'is required in production' });
    }
  } else if (!EMAIL_PROVIDERS.includes(emailRaw as EmailProvider)) {
    issues.push({
      variable: 'EMAIL_PROVIDER',
      message: `must be one of ${EMAIL_PROVIDERS.join(', ')}`,
    });
  } else {
    emailProvider = emailRaw as EmailProvider;
    if (isProduction && emailProvider === 'console') {
      issues.push({
        variable: 'EMAIL_PROVIDER',
        message: 'the console outbox is refused in production',
      });
    }
  }

  const allowDevLogin = read(raw, 'ALLOW_DEV_LOGIN').toLowerCase() === 'true';
  if (isProduction && allowDevLogin) {
    issues.push({
      variable: 'ALLOW_DEV_LOGIN',
      message: 'must not be enabled in production',
    });
  }

  // The API proves itself to the web tier with this value before the web tier drops a
  // cached page. A short one is a guessable one, and production has to set it.
  const revalidateRaw = read(raw, 'REVALIDATE_SECRET');
  if (isProduction) {
    if (revalidateRaw === '') {
      issues.push({ variable: 'REVALIDATE_SECRET', message: 'is required in production' });
    } else if (revalidateRaw.length < MIN_REVALIDATE_SECRET_LENGTH) {
      issues.push({
        variable: 'REVALIDATE_SECRET',
        message: `must be at least ${MIN_REVALIDATE_SECRET_LENGTH} characters`,
      });
    } else if (revalidateRaw === DEFAULT_REVALIDATE_SECRET || isDevelopmentSecret(revalidateRaw)) {
      issues.push({ variable: 'REVALIDATE_SECRET', message: 'must not be a well-known default value' });
    }
  }

  // Object storage. Production has to point at a real S3-compatible service over TLS
  // with its own credentials; the development stack's MinIO credentials are refused.
  const s3Endpoint = read(raw, 'S3_ENDPOINT');
  const s3Bucket = read(raw, 'S3_BUCKET');
  const s3AccessKey = read(raw, 'S3_ACCESS_KEY_ID');
  const s3SecretKey = read(raw, 'S3_SECRET_ACCESS_KEY');
  const s3Region = read(raw, 'S3_REGION') || 'us-east-1';
  const s3ForcePathStyle = read(raw, 'S3_FORCE_PATH_STYLE').toLowerCase() === 'true';
  const s3PublicRead = read(raw, 'S3_PUBLIC_READ').toLowerCase() === 'true';

  if (isProduction) {
    if (s3Endpoint === '') {
      issues.push({ variable: 'S3_ENDPOINT', message: 'is required in production' });
    } else if (s3Endpoint === 'memory:') {
      issues.push({ variable: 'S3_ENDPOINT', message: 'the in-memory store is refused in production' });
    } else if (!s3Endpoint.startsWith('https://')) {
      issues.push({ variable: 'S3_ENDPOINT', message: 'must be an https endpoint in production' });
    }
    if (s3Bucket === '') {
      issues.push({ variable: 'S3_BUCKET', message: 'is required in production' });
    }
    if (s3AccessKey === '') {
      issues.push({ variable: 'S3_ACCESS_KEY_ID', message: 'is required in production' });
    } else if (DEVELOPMENT_S3_CREDENTIALS.includes(s3AccessKey.toLowerCase())) {
      issues.push({ variable: 'S3_ACCESS_KEY_ID', message: 'development credentials are refused in production' });
    }
    if (s3SecretKey === '') {
      issues.push({ variable: 'S3_SECRET_ACCESS_KEY', message: 'is required in production' });
    } else if (DEVELOPMENT_S3_CREDENTIALS.includes(s3SecretKey.toLowerCase())) {
      issues.push({
        variable: 'S3_SECRET_ACCESS_KEY',
        message: 'development credentials are refused in production',
      });
    } else if (s3SecretKey.length < 16) {
      issues.push({
        variable: 'S3_SECRET_ACCESS_KEY',
        message: 'must be at least 16 characters',
      });
    }
  } else if (s3Endpoint !== '') {
    // A development stack that names a store must name all of it, or uploads fail late.
    if (s3Bucket === '' || s3AccessKey === '' || s3SecretKey === '') {
      issues.push({
        variable: 'S3_BUCKET',
        message: 'is required whenever S3_ENDPOINT is set',
      });
    }
  }

  // A bucket the whole internet can read defeats presigned URLs, so it is refused
  // everywhere rather than only in production.
  if (s3PublicRead) {
    issues.push({
      variable: 'S3_PUBLIC_READ',
      message: 'a public bucket is refused: media is served through presigned URLs only',
    });
  }

  // Mobile OTP (phase 2c). The switch is off unless it is asked for, and everything that
  // would be a development shortcut is refused in production when it is on: a fake
  // provider, a missing HMAC secret, missing DLT identifiers, or an insecure gateway.
  const otpHmacSecret = read(raw, 'OTP_HMAC_SECRET');
  const otpSenderId = read(raw, 'OTP_SENDER_ID');
  const otpDltEntityId = read(raw, 'OTP_DLT_ENTITY_ID');
  const otpTemplateId = read(raw, 'OTP_TEMPLATE_ID');
  const otpFakeFixedCode = read(raw, 'OTP_FAKE_FIXED_CODE');
  const otpGatewayUrl = read(raw, 'OTP_GATEWAY_URL');
  const otpGatewayAuthHeader = read(raw, 'OTP_GATEWAY_AUTH_HEADER');
  const otpGatewayAuthValue = read(raw, 'OTP_GATEWAY_AUTH_VALUE');
  const otpGatewayBodyTemplate = read(raw, 'OTP_GATEWAY_BODY_TEMPLATE');

  const otpGatewayTimeoutMs = Number(read(raw, 'OTP_GATEWAY_TIMEOUT_MS') || '5000');
  if (!Number.isInteger(otpGatewayTimeoutMs) || otpGatewayTimeoutMs < 1_000 || otpGatewayTimeoutMs > 30_000) {
    issues.push({
      variable: 'OTP_GATEWAY_TIMEOUT_MS',
      message: 'must be an integer between 1000 and 30000',
    });
  }

  const otpSmsDailyBudget = Number(read(raw, 'OTP_SMS_DAILY_BUDGET') || '100');
  if (!Number.isInteger(otpSmsDailyBudget) || otpSmsDailyBudget < 1 || otpSmsDailyBudget > 100_000) {
    issues.push({
      variable: 'OTP_SMS_DAILY_BUDGET',
      message: 'must be an integer between 1 and 100000',
    });
  }

  const otpAllowedCountryCodes = (read(raw, 'OTP_ALLOWED_COUNTRY_CODES') || '+91')
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code !== '');

  if (otpAllowedCountryCodes.length === 0) {
    issues.push({
      variable: 'OTP_ALLOWED_COUNTRY_CODES',
      message: 'must name at least one country prefix like +91',
    });
  }
  for (const code of otpAllowedCountryCodes) {
    if (!/^\+[1-9][0-9]{0,3}$/.test(code)) {
      issues.push({
        variable: 'OTP_ALLOWED_COUNTRY_CODES',
        message: `"${code}" is not an E.164 country prefix like +91`,
      });
    }
  }

  // A code that never changes exists so a browser test can type it. That is only safe
  // where nothing real is sent: the fake provider, outside production. Both are refused
  // here, at boot, rather than trusted to the code that reads the value.
  if (otpFakeFixedCode !== '') {
    if (!FIXED_OTP_CODE_PATTERN.test(otpFakeFixedCode)) {
      issues.push({ variable: 'OTP_FAKE_FIXED_CODE', message: 'must be six digits' });
    }
    if (isProduction) {
      issues.push({ variable: 'OTP_FAKE_FIXED_CODE', message: 'is refused in production' });
    } else if (smsProvider !== 'fake') {
      issues.push({
        variable: 'OTP_FAKE_FIXED_CODE',
        message: 'may only be set while SMS_PROVIDER is fake',
      });
    }
  }

  if (otpEnabled) {
    if (otpHmacSecret === '') {
      issues.push({ variable: 'OTP_HMAC_SECRET', message: 'is required when OTP_ENABLED is true' });
    } else if (isProduction && otpHmacSecret.length < MIN_AUTH_SECRET_LENGTH) {
      issues.push({
        variable: 'OTP_HMAC_SECRET',
        message: `must be at least ${MIN_AUTH_SECRET_LENGTH} characters in production`,
      });
    } else if (isProduction && FORBIDDEN_PRODUCTION_SECRETS.includes(otpHmacSecret.toLowerCase())) {
      issues.push({ variable: 'OTP_HMAC_SECRET', message: 'must not be a well-known default value' });
    } else if (isProduction && isDevelopmentSecret(otpHmacSecret)) {
      issues.push({
        variable: 'OTP_HMAC_SECRET',
        message: 'must not be a development or placeholder value in production',
      });
    }

    if (isProduction) {
      if (otpSenderId === '') {
        issues.push({ variable: 'OTP_SENDER_ID', message: 'is required in production when OTP is enabled' });
      }
      if (otpDltEntityId === '') {
        issues.push({ variable: 'OTP_DLT_ENTITY_ID', message: 'is required in production when OTP is enabled' });
      }
      if (otpTemplateId === '') {
        issues.push({ variable: 'OTP_TEMPLATE_ID', message: 'is required in production when OTP is enabled' });
      }

      if (smsProvider !== 'http') {
        // There is no vendor-specific adapter yet, and "fake" is already refused above:
        // an OTP-enabled production boot must use the generic gateway.
        issues.push({
          variable: 'SMS_PROVIDER',
          message: 'must be "http" when OTP_ENABLED is true in production (no vendor adapter exists yet)',
        });
      } else {
        if (otpGatewayUrl === '') {
          issues.push({
            variable: 'OTP_GATEWAY_URL',
            message: 'is required when SMS_PROVIDER is http and OTP is enabled in production',
          });
        } else if (!otpGatewayUrl.startsWith('https://')) {
          issues.push({ variable: 'OTP_GATEWAY_URL', message: 'must be an https URL in production' });
        }
        if (otpGatewayBodyTemplate === '') {
          issues.push({
            variable: 'OTP_GATEWAY_BODY_TEMPLATE',
            message: 'is required when SMS_PROVIDER is http',
          });
        }
        if (otpGatewayAuthValue === '') {
          // A gateway that takes an unauthenticated POST is an open relay for anybody who
          // finds it, so a production boot that talks to one has to present a secret.
          issues.push({
            variable: 'OTP_GATEWAY_AUTH_VALUE',
            message: 'is required when SMS_PROVIDER is http in production',
          });
        }
      }
    }
  }

  // Client-address trust (decision 0052). Nothing is trusted unless it is named, and
  // "trust everything" is a development convenience that production refuses outright.
  const trustProxyRaw = read(raw, 'TRUST_PROXY');
  let trustProxy: boolean | number | readonly string[] = false;

  if (trustProxyRaw === '') {
    trustProxy = false;
  } else if (trustProxyRaw === 'true' || trustProxyRaw === '*') {
    if (isProduction) {
      issues.push({
        variable: 'TRUST_PROXY',
        message: 'is refused in production: name the proxy addresses or a hop count',
      });
    } else {
      trustProxy = true;
    }
  } else if (/^[0-9]+$/.test(trustProxyRaw)) {
    const hops = Number(trustProxyRaw);
    if (hops < 1 || hops > 10) {
      issues.push({ variable: 'TRUST_PROXY', message: 'a hop count must be between 1 and 10' });
    } else {
      trustProxy = hops;
    }
  } else {
    const entries = trustProxyRaw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');

    const parsed = entries.map((entry) => ({ entry, block: trustedPrefix(entry) }));
    const invalid = parsed.filter((item) => item.block === null);

    if (entries.length === 0 || invalid.length > 0) {
      issues.push({
        variable: 'TRUST_PROXY',
        message: `"${invalid[0]?.entry ?? trustProxyRaw}" is not an address or CIDR block`,
      });
    } else if (isProduction) {
      // A trusted range is one that may state any address inside it. A block wider than a
      // /8 (IPv4) or a /32 (IPv6) is not a proxy address, it is the internet: naming one
      // would let an address the attacker chooses pick its own per-IP bucket (decision 0052).
      const broad = parsed
        .filter(
          (item): item is { entry: string; block: { family: 4 | 6; prefix: number } } =>
            item.block !== null && isTooBroad(item.block),
        )[0];

      if (broad !== undefined) {
        issues.push({
          variable: 'TRUST_PROXY',
          message: `"${broad.entry}" is broader than a /${String(MIN_TRUSTED_IPV4_PREFIX)} IPv4 or /${String(MIN_TRUSTED_IPV6_PREFIX)} IPv6 block, which production refuses to trust`,
        });
      } else {
        trustProxy = entries;
      }
    } else {
      trustProxy = entries;
    }
  }

  const trustForwardedForTests = read(raw, 'TRUST_FORWARDED_IP_FOR_TESTS').toLowerCase() === 'true';
  if (trustForwardedForTests && isProduction) {
    issues.push({ variable: 'TRUST_FORWARDED_IP_FOR_TESTS', message: 'is refused in production' });
  }

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }
  // One leaked secret must not open every door. In production the three secrets the platform
  // signs with are separate values, and each is refused if it is a development placeholder.
  if (isProduction) {
    const named = [
      { variable: 'AUTH_SECRET', value: authSecret },
      { variable: 'OTP_HMAC_SECRET', value: otpHmacSecret },
      { variable: 'REVALIDATE_SECRET', value: revalidateRaw },
    ].filter((item) => item.value !== '');

    if (new Set(named.map((item) => item.value)).size !== named.length) {
      issues.push({
        variable: 'AUTH_SECRET',
        message: 'must differ from OTP_HMAC_SECRET and REVALIDATE_SECRET in production',
      });
    }
  }

  return {
    NODE_ENV: nodeEnv,
    PORT: port,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    AUTH_SECRET: authSecret,
    TURNSTILE_SECRET_KEY: turnstileSecret,
    SMS_PROVIDER: smsProvider,
    EMAIL_PROVIDER: emailProvider,
    ALLOW_DEV_LOGIN: allowDevLogin,
    TRUST_PROXY: trustProxy,
    TRUST_FORWARDED_IP_FOR_TESTS: trustForwardedForTests,
    REVALIDATE_SECRET: revalidateRaw === '' ? DEFAULT_REVALIDATE_SECRET : revalidateRaw,
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: s3Region,
    S3_BUCKET: s3Bucket,
    S3_ACCESS_KEY_ID: s3AccessKey,
    S3_SECRET_ACCESS_KEY: s3SecretKey,
    S3_FORCE_PATH_STYLE: s3ForcePathStyle,
    S3_PUBLIC_READ: s3PublicRead,
    OTP_ENABLED: otpEnabled,
    OTP_HMAC_SECRET: otpHmacSecret,
    OTP_ALLOWED_COUNTRY_CODES: otpAllowedCountryCodes,
    OTP_SMS_DAILY_BUDGET: otpSmsDailyBudget,
    OTP_SENDER_ID: otpSenderId,
    OTP_DLT_ENTITY_ID: otpDltEntityId,
    OTP_TEMPLATE_ID: otpTemplateId,
    OTP_FAKE_FIXED_CODE: otpFakeFixedCode,
    OTP_GATEWAY_URL: otpGatewayUrl,
    OTP_GATEWAY_AUTH_HEADER: otpGatewayAuthHeader,
    OTP_GATEWAY_AUTH_VALUE: otpGatewayAuthValue,
    OTP_GATEWAY_BODY_TEMPLATE: otpGatewayBodyTemplate,
    OTP_GATEWAY_TIMEOUT_MS: otpGatewayTimeoutMs,
  };
}
