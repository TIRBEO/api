import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient() {
  // Supabase uses a self-signed intermediate CA, so strict verify-full fails.
  // uselibpqcompat=true makes sslmode=require use standard libpq semantics
  // (encrypted, no CA-chain verification) instead of being aliased to verify-full.
  const base = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '';
  const sep = base.includes('?') ? '&' : '?';
  const connectionString = `${base}${sep}uselibpqcompat=true&sslmode=require`;
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query'] : [],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function checkDatabaseConnection() {
  try {
    await prisma.$connect();
    return true;
  } catch {
    return false;
  }
}
