import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';

export interface ResolvedPermissions {
  readonly roleCode: string;
  readonly codes: ReadonlySet<string>;
}

/** Permissions are read from the database on every request; nothing is trusted from a token. */
@Injectable()
export class PermissionsService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  async resolveForUser(userId: string): Promise<ResolvedPermissions | null> {
    const user = await this.database.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        role: {
          select: {
            code: true,
            rolePermissions: { select: { permission: { select: { code: true } } } },
          },
        },
        permissions: { select: { permission: { select: { code: true } } } },
      },
    });

    if (!user || user.status !== 'ACTIVE') {
      return null;
    }

    const codes = new Set<string>();
    for (const row of user.role.rolePermissions) {
      codes.add(row.permission.code);
    }
    for (const row of user.permissions) {
      codes.add(row.permission.code);
    }

    return { roleCode: user.role.code, codes };
  }
}
