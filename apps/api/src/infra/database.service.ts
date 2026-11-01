import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly client = new PrismaClient({ log: ['warn', 'error'] });

  /** Cheap round trip that proves the connection works without needing any table. */
  async ping(): Promise<void> {
    await this.client.$queryRawUnsafe('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
