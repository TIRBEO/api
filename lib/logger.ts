import { prisma } from './db/prisma';

export async function logRequest(info: {
  ip: string | undefined;
  method: string;
  path: string;
  userId?: string;
  status?: number;
}) {
  await prisma.log.create({
    data: {
      ip: info.ip || null,
      method: info.method,
      path: info.path,
      userId: info.userId || null,
      status: info.status ?? null,
    },
  }).catch(() => {});
}

export async function getLogs(limit = 100) {
  return prisma.log.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
}
