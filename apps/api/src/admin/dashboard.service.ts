import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';

/**
 * Real counts of what the platform actually holds today. When a later phase adds
 * attempts or coins, those numbers are added here: nothing is rendered as a placeholder
 * for a feature that does not exist yet.
 */
export interface DashboardCounts {
  readonly users: number;
  readonly editors: number;
  readonly administrators: number;
  readonly activeSessions: number;
  readonly categories: number;
  readonly exams: number;
}

@Injectable()
export class DashboardService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  async counts(): Promise<DashboardCounts> {
    const prisma = this.database.prisma;
    const now = new Date();

    const [users, editors, administrators, activeSessions, categories, exams] = await prisma.$transaction([
      prisma.user.count(),
      prisma.user.count({ where: { role: { code: 'EDITOR' } } }),
      prisma.user.count({ where: { role: { code: 'ADMIN' } } }),
      prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
      prisma.examCategory.count(),
      prisma.exam.count(),
    ]);

    return { users, editors, administrators, activeSessions, categories, exams };
  }
}
