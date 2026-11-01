import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { parseSettingPatch } from './operations.validation';

export interface SettingRow {
  readonly key: string;
  readonly valueType: string;
  readonly valueText: string | null;
  readonly valueInt: number | null;
  readonly valueBool: boolean | null;
  readonly minInt: number | null;
  readonly maxInt: number | null;
  readonly description: string | null;
  readonly updatedAt: string;
}

/**
 * Platform settings. The row carries the type and the bounds, so this service reads and
 * writes the value as the row declares it and lets the database refuse a value outside
 * its own limits. Every change is audited with the old and the new value.
 */
@Injectable()
export class SettingsService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  private get prisma() {
    return this.database.prisma;
  }

  async list(): Promise<readonly SettingRow[]> {
    const rows = await this.prisma.setting.findMany({ orderBy: { key: 'asc' } });
    return rows.map((row) => ({
      key: row.key,
      valueType: row.valueType,
      valueText: row.valueText,
      valueInt: row.valueInt,
      valueBool: row.valueBool,
      minInt: row.minInt,
      maxInt: row.maxInt,
      description: row.description,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async update(
    actor: AuthenticatedUser,
    key: string,
    body: unknown,
    meta: { readonly ip?: string | undefined } = {},
  ): Promise<SettingRow> {
    const existing = await this.prisma.setting.findUnique({ where: { key } });
    if (!existing) {
      throw new NotFoundException('Unknown setting');
    }
    if (existing.valueType === 'string' && (existing.minInt !== null || existing.maxInt !== null)) {
      throw new BadRequestException('This setting cannot carry bounds');
    }

    const patch = parseSettingPatch(body, existing.valueType);

    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.setting.update({
          where: { key },
          data: {
            ...patch,
            updatedBy: actor.id,
            updatedAt: new Date(),
          },
        });

        await writeIdentityAudit(tx, {
          action: 'SETTINGS_CHANGED',
          actorUserId: actor.id,
          actorRole: actor.roleCode,
          entityType: 'setting',
          metadata: {
            key,
            from: existing.valueInt ?? existing.valueBool ?? existing.valueText,
            to: row.valueInt ?? row.valueBool ?? row.valueText,
          },
          ip: meta.ip ?? null,
        });

        return row;
      });
    } catch (error) {
      // A CHECK is the row refusing the value, not the platform breaking.
      if (isCheckViolation(error)) {
        throw new BadRequestException('That value is outside the bounds this setting allows');
      }
      throw error;
    }

    return {
      key: updated.key,
      valueType: updated.valueType,
      valueText: updated.valueText,
      valueInt: updated.valueInt,
      valueBool: updated.valueBool,
      minInt: updated.minInt,
      maxInt: updated.maxInt,
      description: updated.description,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }
}


/** A CHECK or trigger refusal, which Prisma surfaces as an unknown request error. */
function isCheckViolation(error: unknown): boolean {
  return error instanceof Error && /violates check constraint|must ascend/.test(error.message);
}
