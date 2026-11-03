/**
 * Environment validation shared by the API and the worker.
 *
 * The rule from docs/working-rules.md: development shortcuts (test Turnstile keys,
 * fake SMS, dev login) must be impossible in production. This module is the single
 * place where that is enforced, and it fails closed by throwing before the process
 * boots.
 */

export type NodeEnv = 'development' | 'test' | 'production';

export type SmsProvider = 'fake' | 'console' | 'msg91' | 'twilio' | 'ses';

export type EmailProvider = 'console' | 'smtp';

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

const SMS_PROVIDERS: readonly SmsProvider[] = ['fake', 'console', 'msg91', 'twilio', 'ses'];

const EMAIL_PROVIDERS: readonly EmailProvider[] = ['console', 'smtp'];

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

/** Cloudflare Turnstile test secrets all start with 1x0..., 2x0... or 3x0.... */
const TURNSTILE_TEST_SECRET_PATTERN = /^[123]x0{20,}/i;

export const MIN_AUTH_SECRET_LENGTH = 32;

/** The shared secret the API presents when it asks the web tier to refresh cached pages. */
export const MIN_REVALIDATE_SECRET_LENGTH = 16;

export const DEFAULT_REVALIDATE_SECRET = 'dev-only-revalidate-secret';

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

  const smsRaw = read(raw, 'SMS_PROVIDER').toLowerCase();
  let smsProvider: SmsProvider = 'fake';
  if (smsRaw === '') {
    if (isProduction) {
      issues.push({ variable: 'SMS_PROVIDER', message: 'is required in production' });
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

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
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
    REVALIDATE_SECRET: revalidateRaw === '' ? DEFAULT_REVALIDATE_SECRET : revalidateRaw,
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: s3Region,
    S3_BUCKET: s3Bucket,
    S3_ACCESS_KEY_ID: s3AccessKey,
    S3_SECRET_ACCESS_KEY: s3SecretKey,
    S3_FORCE_PATH_STYLE: s3ForcePathStyle,
    S3_PUBLIC_READ: s3PublicRead,
  };
}
