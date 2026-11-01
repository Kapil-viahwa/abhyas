import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { HealthService, type HealthReport } from './health.service';

@ApiTags('system')
@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('health')
  @ApiOperation({ summary: 'Report whether Postgres and Redis are reachable' })
  @ApiOkResponse({ description: 'Every dependency answered' })
  @ApiServiceUnavailableResponse({ description: 'At least one dependency is down' })
  async getHealth(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthReport> {
    const report = await this.health.check();
    reply.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
