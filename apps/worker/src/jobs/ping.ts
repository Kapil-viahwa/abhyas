export interface PingJobData {
  requestedBy: string;
  requestedAt: string;
}

export interface PingDeps {
  now(): Date;
  log(message: string, meta?: Record<string, unknown>): void;
}

export interface PingResult {
  jobId: string;
  requestedBy: string;
  handledAt: string;
}

/**
 * The phase 0 example job. It validates its payload rather than trusting the
 * queue, because anything that reaches a worker is untrusted input.
 */
export async function processPing(
  job: { id?: string | undefined; data: unknown },
  deps: PingDeps,
): Promise<PingResult> {
  const data = job.data;

  if (typeof data !== 'object' || data === null) {
    throw new Error('ping job data must be an object');
  }

  const { requestedBy, requestedAt } = data as Partial<PingJobData>;

  if (typeof requestedBy !== 'string' || requestedBy.trim() === '') {
    throw new Error('ping job requires a non-empty requestedBy');
  }

  if (typeof requestedAt !== 'string' || Number.isNaN(Date.parse(requestedAt))) {
    throw new Error('ping job requires requestedAt as an ISO date string');
  }

  const handledAt = deps.now().toISOString();
  const jobId = job.id ?? 'unknown';

  deps.log(`ping handled for ${requestedBy}`, { jobId, handledAt });

  return { jobId, requestedBy, handledAt };
}
