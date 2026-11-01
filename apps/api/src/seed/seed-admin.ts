import type { PrismaClient } from '@prisma/client';

import { hashPassword } from '../auth/password';

/**
 * Creates the first Administrator from explicit environment variables.
 *
 * Rules:
 * - there is no default email and no default password, in any environment;
 * - production additionally requires SEED_ADMIN_CONFIRM=create-first-admin;
 * - the run is idempotent: if any admin already exists, nothing is created;
 * - a successful run writes an audit row in the same transaction as the user.
 */

export const MIN_SEED_PASSWORD_LENGTH = 12;

export const PRODUCTION_CONFIRMATION = 'create-first-admin';

const FORBIDDEN_PASSWORDS = [
  'password',
  'password123',
  'changeme',
  'change-me',
  'admin',
  'admin123',
  'letmein',
  'secret',
  'dev-secret',
  'abhyas',
  'qwerty123456',
];

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface SeedAdminConfig {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
}

export class SeedConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Refusing to seed an administrator:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'SeedConfigError';
    this.issues = issues;
  }
}

export function resolveSeedAdminConfig(env: Readonly<Record<string, string | undefined>>): SeedAdminConfig {
  const issues: string[] = [];

  const nodeEnv = (env.NODE_ENV ?? '').trim() || 'development';
  const email = (env.SEED_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = env.SEED_ADMIN_PASSWORD ?? '';
  const fullName = (env.SEED_ADMIN_NAME ?? '').trim() || 'Abhyas Administrator';
  const confirmation = (env.SEED_ADMIN_CONFIRM ?? '').trim();

  if (email === '') {
    issues.push('SEED_ADMIN_EMAIL is required');
  } else if (!EMAIL_PATTERN.test(email)) {
    issues.push('SEED_ADMIN_EMAIL must be an email address');
  }

  if (password === '') {
    issues.push('SEED_ADMIN_PASSWORD is required (there is no default password)');
  } else {
    if (password.length < MIN_SEED_PASSWORD_LENGTH) {
      issues.push(`SEED_ADMIN_PASSWORD must be at least ${MIN_SEED_PASSWORD_LENGTH} characters`);
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      issues.push('SEED_ADMIN_PASSWORD must contain at least one letter and one digit');
    }
    if (FORBIDDEN_PASSWORDS.includes(password.toLowerCase())) {
      issues.push('SEED_ADMIN_PASSWORD must not be a well-known default value');
    }
    if (email !== '' && password.toLowerCase() === email.split('@')[0]) {
      issues.push('SEED_ADMIN_PASSWORD must not equal the email local part');
    }
  }

  if (nodeEnv === 'production' && confirmation !== PRODUCTION_CONFIRMATION) {
    issues.push(`SEED_ADMIN_CONFIRM must be exactly "${PRODUCTION_CONFIRMATION}" when NODE_ENV=production`);
  }

  if (issues.length > 0) {
    throw new SeedConfigError(issues);
  }

  return { email, fullName, password };
}

export type SeedAdminOutcome = 'created' | 'admin-already-exists' | 'user-already-exists';

export interface SeedAdminResult {
  readonly created: boolean;
  readonly outcome: SeedAdminOutcome;
  readonly userId?: string;
}

export async function seedAdmin(client: PrismaClient, config: SeedAdminConfig): Promise<SeedAdminResult> {
  const role = await client.role.findUnique({ where: { code: 'ADMIN' }, select: { id: true } });
  if (!role) {
    throw new Error('The ADMIN role is missing. Apply migrations before seeding.');
  }

  const existing = await client.user.findUnique({ where: { email: config.email }, select: { id: true, roleId: true } });
  if (existing) {
    return existing.roleId === role.id
      ? { created: false, outcome: 'admin-already-exists', userId: existing.id }
      : { created: false, outcome: 'user-already-exists', userId: existing.id };
  }

  const otherAdmin = await client.user.findFirst({ where: { roleId: role.id }, select: { id: true } });
  if (otherAdmin) {
    return { created: false, outcome: 'admin-already-exists', userId: otherAdmin.id };
  }

  const passwordHash = await hashPassword(config.password);

  return client.$transaction(async (tx): Promise<SeedAdminResult> => {
    const user = await tx.user.create({
      data: {
        email: config.email,
        fullName: config.fullName,
        passwordHash,
        roleId: role.id,
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: user.id,
        actorRole: 'ADMIN',
        action: 'IDENTITY_ADMIN_SEEDED',
        entityType: 'user',
        entityId: user.id,
        metadata: { email: config.email, source: 'seed' },
      },
    });

    return { created: true, outcome: 'created', userId: user.id };
  });
}
