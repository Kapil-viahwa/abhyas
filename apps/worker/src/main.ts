import { validateEnv, EnvValidationError } from '@abhyas/shared';
import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { drainCoinBulkJobs } from './jobs/coin-bulk';
import { runMaintenanceJob } from './queues/dispatch';
import { MAINTENANCE_QUEUE, PING_JOB } from './queues/maintenance';
import { registerRepeatableJobs } from './queues/schedule';

async function main(): Promise<void> {
  // Same gate as the API: production refuses test keys, fake SMS and dev login.
  const config = validateEnv(process.env);

  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const prisma = new PrismaClient({ log: ['warn', 'error'] });

  const queue = new Queue(MAINTENANCE_QUEUE, { connection });
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) =>
      runMaintenanceJob(
        { id: job.id, name: job.name, data: job.data },
        {
          now: () => new Date(),
          log: (message, meta) => {
            // eslint-disable-next-line no-console
            console.log(message, meta ?? {});
          },
          database: prisma,
          // The API owns the ledger writer, so the worker asks it to run the batch.
          coinBulk: {
            drain: () =>
              drainCoinBulkJobs({
                host: {
                  findDrainable: async (limit) => {
                    const rows = await prisma.coinBulkJob.findMany({
                      where: { status: { in: ['QUEUED', 'RUNNING'] } },
                      orderBy: [{ createdAt: 'asc' }],
                      take: limit,
                      select: { id: true },
                    });
                    return rows.map((row) => row.id);
                  },
                  markFailed: async (jobId, reason) => {
                    await prisma.coinBulkJob.update({
                      where: { id: jobId },
                      data: { status: 'FAILED', errorMessage: reason.slice(0, 500), finishedAt: new Date() },
                    });
                  },
                },
                failures: {
                  bump: async (jobId, reason) => {
                    const key = `coins:bulk_failures:${jobId}`;
                    const count = await connection.incr(key);
                    await connection.expire(key, 24 * 60 * 60);
                    await connection.set(`coins:bulk_failure_reason:${jobId}`, reason.slice(0, 200), 'EX', 24 * 60 * 60);
                    return count;
                  },
                  clear: async (jobId) => {
                    await connection.del(`coins:bulk_failures:${jobId}`, `coins:bulk_failure_reason:${jobId}`);
                  },
                },
                alert: async ({ jobId, reason }) => {
                  const key = `coins:bulk_alerts:${new Date().toISOString().slice(0, 10)}`;
                  const raised = await connection.incr(key);
                  await connection.expire(key, 30 * 24 * 60 * 60);
                  console.error(`bulk job ${jobId} was given up on (${reason}); alerts today: ${String(raised)}`);
                },
                apiUrl: process.env.INTERNAL_API_URL ?? 'http://api:3001',
                secret: config.INTERNAL_API_SECRET,
                log: (message, meta) => {
                  // eslint-disable-next-line no-console
                  console.log(message, meta ?? {});
                },
              }),
          },
        },
      ),
    { connection, concurrency: 1 },
  );

  worker.on('completed', (job) => {
    // eslint-disable-next-line no-console
    console.log(`job ${job.id ?? 'unknown'} (${job.name}) completed`);
  });

  worker.on('failed', (job, error) => {
    // eslint-disable-next-line no-console
    console.error(`job ${job?.id ?? 'unknown'} failed: ${error.message}`);
  });

  // One example job on boot, so the queue loop is observable end to end.
  await queue.add(
    PING_JOB,
    { requestedBy: 'worker-bootstrap', requestedAt: new Date().toISOString() },
    { removeOnComplete: 100, removeOnFail: 100 },
  );

  // The repeatable jobs: BullMQ keeps the schedule in Redis, so a restart does not double it.
  const registered = await registerRepeatableJobs(queue);
  // eslint-disable-next-line no-console
  console.log(`repeatable jobs registered: ${registered.join(', ')}`);

  // eslint-disable-next-line no-console
  console.log(`worker listening on "${MAINTENANCE_QUEUE}" (${config.NODE_ENV})`);

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    void (async () => {
      await worker.close();
      await queue.close();
      await prisma.$disconnect();
      await connection.quit();
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    // eslint-disable-next-line no-console
    console.error(`Abhyas worker refused to start:\n${error.message}`);
  } else {
    // eslint-disable-next-line no-console
    console.error('Abhyas worker crashed:', error);
  }
  process.exit(1);
});
