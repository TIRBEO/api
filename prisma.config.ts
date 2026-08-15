import { defineConfig } from 'prisma/config';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// Read .env file manually (strips quotes from values)
let dbUrl = '';
try {
  const envContent = readFileSync(resolve(__dirname, '.env'), 'utf-8');
  const match = envContent.match(/^DATABASE_URL=(.+)$/m);
  if (match) dbUrl = match[1].trim().replace(/^["']|["']$/g, '');
} catch {}

// Also try .env.local
if (!dbUrl) {
  try {
    const envContent = readFileSync(resolve(__dirname, '.env.local'), 'utf-8');
    const match = envContent.match(/^DATABASE_URL=(.+)$/m);
    if (match) dbUrl = match[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: dbUrl || process.env.DATABASE_URL,
  },
});
