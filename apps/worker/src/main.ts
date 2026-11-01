import { validateEnv, EnvValidationError } from '@abhyas/shared';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';

import { processPing } from './jobs/ping';
import { MAINTENANCE_QUEUE, PING_JOB } from './queues/maintenance';

async function main(): Promise<void> {
  // Same gate as the API: production refuses test keys, fake SMS and dev login.
  const config = validateEnv(process.env);

  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const queue = new Queue(MAINTENANCE_QUEUE, { connection });
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job: Job) => {
      if (job.name === PING_JOB) {
        return processPing(
          { id: job.id, data: job.data },
          {
            now: () => new Date(),
            log: (message, meta) => {
              // eslint-disable-next-line no-console
              console.log(message, meta ?? {});
            },
          },
        );
      }

      throw new Error(`Unknown job "${job.name}" on queue "${MAINTENANCE_QUEUE}"`);
    },
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

  // eslint-disable-next-line no-console
  console.log(`worker listening on "${MAINTENANCE_QUEUE}" (${config.NODE_ENV})`);

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    void (async () => {
      await worker.close();
      await queue.close();
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
