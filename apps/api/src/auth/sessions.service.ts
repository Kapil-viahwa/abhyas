import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS, generateToken, hashToken, isExpired } from './tokens';

export const SESSIONS_SERVICE = 'SESSIONS_SERVICE';

export type RevokeReason =
  | 'LOGOUT'
  | 'ROTATED'
  | 'REUSE_DETECTED'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET'
  | 'ACCOUNT_DEACTIVATED'
  | 'ROLE_CHANGED'
  | 'ADMIN_REVOKED';

export interface SessionMetadata {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly deviceLabel?: string | undefined;
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly familyId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
}

export interface ActiveSession {
  readonly sessionId: string;
  readonly userId: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly familyId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly deviceLabel: string | null;
}

@Injectable()
export class SessionsService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  private get prisma() {
    return this.database.prisma;
  }

  private async createRow(
    userId: string,
    familyId: string,
    metadata: SessionMetadata,
  ): Promise<IssuedSession> {
    const accessToken = generateToken();
    const refreshToken = generateToken();
    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

    const session = await this.prisma.session.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: hashToken(refreshToken),
        accessTokenHash: hashToken(accessToken),
        issuedAt: now,
        expiresAt: refreshExpiresAt,
        accessExpiresAt,
        ip: metadata.ip ?? null,
        userAgent: metadata.userAgent ?? null,
        deviceLabel: metadata.deviceLabel ?? null,
      },
      select: { id: true },
    });

    return { sessionId: session.id, familyId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
  }

  /** Starts a new session family (a fresh login). */
  async issue(userId: string, metadata: SessionMetadata = {}): Promise<IssuedSession> {
    return this.createRow(userId, randomUUID(), metadata);
  }

  async findByAccessToken(accessToken: string): Promise<ActiveSession | null> {
    const session = await this.prisma.session.findUnique({
      where: { accessTokenHash: hashToken(accessToken) },
      select: { id: true, userId: true, revokedAt: true, accessExpiresAt: true },
    });

    if (!session || session.revokedAt !== null || isExpired(session.accessExpiresAt)) {
      return null;
    }

    return { sessionId: session.id, userId: session.userId };
  }

  /**
   * Rotates a refresh token. Presenting a token that has already been rotated is
   * treated as theft: the whole family is revoked and no new session is issued.
   */
  async rotate(refreshToken: string, metadata: SessionMetadata = {}): Promise<IssuedSession> {
    const hash = hashToken(refreshToken);
    const existing = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      select: { id: true, userId: true, familyId: true, rotatedAt: true, revokedAt: true, expiresAt: true },
    });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.revokedAt !== null) {
      // Already revoked: nothing to replay, but do not reveal which case it was.
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.rotatedAt !== null || isExpired(existing.expiresAt)) {
      await this.revokeFamily(existing.familyId, 'REUSE_DETECTED');
      throw new UnauthorizedException('Invalid refresh token');
    }

    const now = new Date();

    const issued = await this.prisma.$transaction(async (tx) => {
      const rotated = await tx.session.updateMany({
        where: { id: existing.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now, revokeReason: 'ROTATED', revokedAt: now, accessExpiresAt: now },
      });

      if (rotated.count !== 1) {
        return null;
      }

      const accessToken = generateToken();
      const newRefreshToken = generateToken();
      const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
      const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

      const created = await tx.session.create({
        data: {
          userId: existing.userId,
          familyId: existing.familyId,
          refreshTokenHash: hashToken(newRefreshToken),
          accessTokenHash: hashToken(accessToken),
          issuedAt: now,
          expiresAt: refreshExpiresAt,
          accessExpiresAt,
          ip: metadata.ip ?? null,
          userAgent: metadata.userAgent ?? null,
          deviceLabel: metadata.deviceLabel ?? null,
        },
        select: { id: true },
      });

      return {
        sessionId: created.id,
        familyId: existing.familyId,
        accessToken,
        refreshToken: newRefreshToken,
        accessExpiresAt,
        refreshExpiresAt,
      } satisfies IssuedSession;
    });

    if (!issued) {
      await this.revokeFamily(existing.familyId, 'REUSE_DETECTED');
      throw new UnauthorizedException('Invalid refresh token');
    }

    return issued;
  }

  async revokeFamily(familyId: string, reason: RevokeReason): Promise<number> {
    const now = new Date();
    const result = await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason, accessExpiresAt: now },
    });
    return result.count;
  }

  async revokeAllForUser(userId: string, reason: RevokeReason): Promise<number> {
    const now = new Date();
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason, accessExpiresAt: now },
    });
    return result.count;
  }

  /** Revokes one session, but only if it belongs to that user (no IDOR). */
  async revokeOwnedSession(userId: string, sessionId: string, reason: RevokeReason = 'ADMIN_REVOKED'): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason, accessExpiresAt: now },
    });
    return result.count === 1;
  }

  async listForUser(userId: string): Promise<SessionSummary[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { issuedAt: 'desc' },
      select: {
        id: true,
        familyId: true,
        issuedAt: true,
        expiresAt: true,
        ip: true,
        userAgent: true,
        deviceLabel: true,
      },
    });

    return rows.map((row) => ({ ...row, lastUsedAt: row.issuedAt }));
  }
}
