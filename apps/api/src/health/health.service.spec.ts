import { describe, expect, it } from 'vitest';

import { API_SERVICE_NAME } from '@abhyas/shared';

import { HealthService, probeRedis, type DatabaseProbe, type RedisProbe } from './health.service';

function healthyDatabase(): DatabaseProbe {
  return { ping: async () => undefined };
}

function healthyRedis(): RedisProbe {
  return { ping: async () => 'PONG' };
}

describe('HealthService', () => {
  it('reports ok when both dependencies answer', async () => {
    const report = await new HealthService(healthyDatabase(), healthyRedis()).check();

    expect(report.status).toBe('ok');
    expect(report.checks).toEqual({ database: 'ok', redis: 'ok' });
    expect(report.service).toBe(API_SERVICE_NAME);
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
  });

  it('reports degraded when the database probe throws', async () => {
    const failing: DatabaseProbe = {
      ping: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      },
    };

    const report = await new HealthService(failing, healthyRedis()).check();

    expect(report.status).toBe('degraded');
    expect(report.checks.database).toBe('down');
    expect(report.checks.redis).toBe('ok');
  });

  it('treats an unexpected redis reply as down', async () => {
    await expect(probeRedis({ ping: async () => 'NOAUTH' })).resolves.toBe('down');
  });

  it('treats a redis error as down', async () => {
    const failing: RedisProbe = {
      ping: async () => {
        throw new Error('Connection is closed.');
      },
    };

    const report = await new HealthService(healthyDatabase(), failing).check();

    expect(report.status).toBe('degraded');
    expect(report.checks.redis).toBe('down');
  });
});
