import { prisma } from './db/prisma';

export type JobType = 'email' | 'webhook' | 'cleanup' | 'backup' | 'report' | 'sync' | string;

export async function createJob(type: JobType, payload: Record<string, unknown>, queue = 'default', maxAttempts = 3) {
  return prisma.jobs.create({
    data: { type, queue, payload: payload as any, maxAttempts, updatedAt: new Date() },
  });
}

export async function processNextJob(queue = 'default') {
  const job = await prisma.jobs.findFirst({
    where: { queue, status: 'pending' },
    orderBy: { createdAt: 'asc' },
  });
  if (!job) return null;

  await prisma.jobs.update({ where: { id: job.id }, data: { status: 'processing', startedAt: new Date(), attempts: job.attempts + 1 } });

  await prisma.job_attempts.create({
    data: { jobId: job.id, attempt: job.attempts + 1, status: 'processing', startedAt: new Date() },
  });

  return job;
}

export async function completeJob(jobId: string, result?: Record<string, unknown>) {
  await prisma.jobs.update({ where: { id: jobId }, data: { status: 'completed', completedAt: new Date(), payload: (result || {}) as any } });
  await prisma.job_attempts.updateMany({
    where: { jobId, status: 'processing' },
    data: { status: 'completed', completedAt: new Date() },
  });
}

export async function failJob(jobId: string, error: string) {
  const job = await prisma.jobs.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.attempts >= job.maxAttempts) {
    await prisma.jobs.update({ where: { id: jobId }, data: { status: 'failed', error, completedAt: new Date() } });
  } else {
    await prisma.jobs.update({ where: { id: jobId }, data: { status: 'pending', error } });
  }
  await prisma.job_attempts.updateMany({
    where: { jobId, status: 'processing' },
    data: { status: 'failed', error, completedAt: new Date() },
  });
}

export async function retryJob(jobId: string) {
  await prisma.jobs.update({ where: { id: jobId }, data: { status: 'pending', error: null, startedAt: null, completedAt: null, attempts: 0 } });
  await prisma.job_attempts.updateMany({ where: { jobId }, data: { status: 'cancelled' } });
}

export async function processQueue(queue = 'default', handler: (job: any) => Promise<void>) {
  const job = await processNextJob(queue);
  if (!job) return;
  try {
    await handler(job);
    await completeJob(job.id);
  } catch (err: any) {
    await failJob(job.id, err?.message || 'Unknown error');
  }
}

export async function cleanupOldJobs(olderThanDays = 30) {
  const cutoff = new Date(Date.now() - olderThanDays * 86400000);
  await prisma.jobs.deleteMany({ where: { createdAt: { lt: cutoff }, status: { in: ['completed', 'failed'] } } });
  await prisma.job_attempts.deleteMany({ where: { createdAt: { lt: cutoff } } });
}
