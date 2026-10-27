import { defineConfig } from 'prisma/config';
import { resolve } from 'path';
import { readFileSync } from 'fs';

function readUrls(file: string): { dbUrl: string; directUrl: string } {
  const envContent = readFileSync(resolve(__dirname, file), 'utf-8');
  const grab = (key: string) =>
    envContent.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
  return { dbUrl: grab('DATABASE_URL'), directUrl: grab('DIRECT_DATABASE_URL') };
}

// TIRBEO_ENV_FILE names the one file to use, and a missing or empty one is a
// hard failure. Everything else here falls back quietly, which is exactly what
// must not happen when someone asks for the scratch database by name: a typo'd
// path would otherwise read .env.local and push a schema to production.
let url = '';
if (process.env.TIRBEO_ENV_FILE) {
  const from = process.env.TIRBEO_ENV_FILE;
  let urls;
  try {
    urls = readUrls(from);
  } catch {
    throw new Error(`TIRBEO_ENV_FILE=${from} — no such file. Nothing was pushed.`);
  }
  url = urls.directUrl || urls.dbUrl;
  if (!url) throw new Error(`TIRBEO_ENV_FILE=${from} carries no DATABASE_URL. Nothing was pushed.`);
} else {
  // Read .env file manually (strips quotes from values)
  let dbUrl = '';
  let directUrl = process.env.DIRECT_DATABASE_URL || '';
  try {
    const urls = readUrls('.env');
    dbUrl = urls.dbUrl;
    directUrl = directUrl || urls.directUrl;
  } catch {}

  // Also try .env.local
  if (!dbUrl || !directUrl) {
    try {
      const urls = readUrls('.env.local');
      if (!dbUrl) dbUrl = urls.dbUrl;
      directUrl = directUrl || urls.directUrl;
    } catch {}
  }

  // Prefer the direct connection: migrate/db commands hang on PgBouncer (:6543)
  url = directUrl || dbUrl || process.env.DATABASE_URL || '';
}

// Say which database was picked, with any password hidden, before the command
// that cannot be undone runs. A line like this is the last cheap chance to notice.
console.log(`[prisma] datasource ${url.replace(/\/\/([^@/]+)@/, '//***@') || 'NOT RESOLVED'}`);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url,
  },
});
