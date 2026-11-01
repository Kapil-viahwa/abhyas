import { Inject, Injectable } from '@nestjs/common';

import { API_SERVICE_NAME, SERVICE_VERSION } from '@abhyas/shared';

import { DATABASE_PROBE, REDIS_PROBE } from '../infra/tokens';

export type ProbeState = 'ok' | 'down';

export interface HealthReport {
  readonly status: 'ok' | 'degraded';
  readonly service: string;
  readonly version: string;
  readonly checkedAt: string;
  readonly checks: {
    readonly database: ProbeState;
    readonly redis: ProbeState;
  };
}

export interface DatabaseProbe {
  ping(): Promise<void>;
}

export interface RedisProbe {
  ping(): Promise<string>;
}

export async function probeDatabase(probe: DatabaseProbe): Promise<ProbeState> {
  try {
    await probe.ping();
    return 'ok';
  } catch {
    return 'down';
  }
}

export async function probeRedis(probe: RedisProbe): Promise<ProbeState> {
  try {
    return (await probe.ping()) === 'PONG' ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseProbe,
    @Inject(REDIS_PROBE) private readonly redis: RedisProbe,
  ) {}

  async check(): Promise<HealthReport> {
    const [database, redis] = await Promise.all([probeDatabase(this.database), probeRedis(this.redis)]);

    return {
      status: database === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
      service: API_SERVICE_NAME,
      version: SERVICE_VERSION,
      checkedAt: new Date().toISOString(),
      checks: { database, redis },
    };
  }
}
