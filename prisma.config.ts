import { defineConfig } from 'prisma/config';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// Read .env file manually (strips quotes from values)
let dbUrl = '';
let directUrl = process.env.DIRECT_DATABASE_URL || '';
try {
  const envContent = readFileSync(resolve(__dirname, '.env'), 'utf-8');
  const match = envContent.match(/^DATABASE_URL=(.+)$/m);
  if (match) dbUrl = match[1].trim().replace(/^["']|["']$/g, '');
  const directMatch = envContent.match(/^DIRECT_DATABASE_URL=(.+)$/m);
  if (directMatch) directUrl = directUrl || directMatch[1].trim().replace(/^["']|["']$/g, '');
} catch {}

// Also try .env.local
if (!dbUrl || !directUrl) {
  try {
    const envContent = readFileSync(resolve(__dirname, '.env.local'), 'utf-8');
    if (!dbUrl) {
      const match = envContent.match(/^DATABASE_URL=(.+)$/m);
      if (match) dbUrl = match[1].trim().replace(/^["']|["']$/g, '');
    }
    const directMatch = envContent.match(/^DIRECT_DATABASE_URL=(.+)$/m);
    if (directMatch) directUrl = directUrl || directMatch[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
}

// Prefer the direct connection: migrate/db commands hang on PgBouncer (:6543)
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: directUrl || dbUrl || process.env.DATABASE_URL,
  },
});
