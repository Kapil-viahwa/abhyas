import { describe, expect, it } from 'vitest';

import { PRODUCTION_CONFIRMATION, resolveSeedAdminConfig, SeedConfigError } from './seed-admin';

const development = {
  SEED_ADMIN_EMAIL: 'Admin@Example.com',
  SEED_ADMIN_PASSWORD: 'first-admin-2026',
};

const production = {
  NODE_ENV: 'production',
  SEED_ADMIN_EMAIL: 'admin@example.com',
  SEED_ADMIN_PASSWORD: 'first-admin-2026',
  SEED_ADMIN_CONFIRM: PRODUCTION_CONFIRMATION,
};

describe('resolveSeedAdminConfig', () => {
  it('accepts explicit development variables and normalises the email', () => {
    const config = resolveSeedAdminConfig(development);

    expect(config.email).toBe('admin@example.com');
    expect(config.fullName).toBe('Abhyas Administrator');
    expect(config.password).toBe('first-admin-2026');
  });

  it('has no default password', () => {
    expect(() => resolveSeedAdminConfig({ SEED_ADMIN_EMAIL: 'admin@example.com' })).toThrow(
      /SEED_ADMIN_PASSWORD is required/,
    );
  });

  it('requires an email address', () => {
    expect(() => resolveSeedAdminConfig({ SEED_ADMIN_PASSWORD: 'first-admin-2026' })).toThrow(
      /SEED_ADMIN_EMAIL is required/,
    );
    expect(() =>
      resolveSeedAdminConfig({ ...development, SEED_ADMIN_EMAIL: 'not-an-email' }),
    ).toThrow(/must be an email address/);
  });

  it('refuses short, weak and well-known passwords', () => {
    expect(() => resolveSeedAdminConfig({ ...development, SEED_ADMIN_PASSWORD: 'short1' })).toThrow(
      /at least 12 characters/,
    );
    expect(() => resolveSeedAdminConfig({ ...development, SEED_ADMIN_PASSWORD: 'onlyletterslong' })).toThrow(
      /at least one letter and one digit/,
    );
    expect(() => resolveSeedAdminConfig({ ...development, SEED_ADMIN_PASSWORD: 'changeme' })).toThrow(
      /must not be a well-known default/,
    );
    expect(() =>
      resolveSeedAdminConfig({
        ...development,
        SEED_ADMIN_EMAIL: 'abhyas-seed1@example.com',
        SEED_ADMIN_PASSWORD: 'abhyas-seed1',
      }),
    ).toThrow(/must not equal the email local part/);
  });

  it('accepts production only with the explicit confirmation flag', () => {
    expect(resolveSeedAdminConfig(production).email).toBe('admin@example.com');

    expect(() => resolveSeedAdminConfig({ ...production, SEED_ADMIN_CONFIRM: '' })).toThrow(
      /SEED_ADMIN_CONFIRM must be exactly "create-first-admin"/,
    );
    expect(() => resolveSeedAdminConfig({ ...production, SEED_ADMIN_CONFIRM: 'yes' })).toThrow(
      SeedConfigError,
    );
  });

  it('refuses production without explicit variables at all', () => {
    expect(() => resolveSeedAdminConfig({ NODE_ENV: 'production' })).toThrow(SeedConfigError);
    expect(() => resolveSeedAdminConfig({ NODE_ENV: 'production' })).toThrow(
      /SEED_ADMIN_EMAIL is required/,
    );
    expect(() => resolveSeedAdminConfig({ NODE_ENV: 'production' })).toThrow(
      /SEED_ADMIN_PASSWORD is required/,
    );
  });
});
