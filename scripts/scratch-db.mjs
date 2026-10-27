/**
 * A throwaway Postgres for schema work, seeds and browser tests.
 *
 *   node scripts/scratch-db.mjs up       init if needed, start, ensure the database
 *   node scripts/scratch-db.mjs down     stop it
 *   node scripts/scratch-db.mjs status   whether it is listening, and on what
 *   node scripts/scratch-db.mjs url      the connection string .env.scratch uses
 *
 * Why not Docker: the daemon is not running on this machine and the user is not
 * in the docker group, while Postgres 18 is already installed under
 * /usr/lib/postgresql. A private cluster initdb'd into <repo>/.scratch needs
 * neither sudo nor a daemon, and deleting the directory is a complete teardown.
 *
 * Two properties are the whole point of this file. It never reads .env.local —
 * the live Supabase connection string must not reach a command that can push a
 * schema or seed rows. And it binds to 127.0.0.1 with a socket in a directory
 * only this user can enter, so `trust` authentication stays local-only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, '..');
// apps/api is its own repository inside the Tirbeo workspace, so the workspace
// root is two levels up — and the scratch cluster belongs there, beside the
// other things no repository keeps.
const REPO = resolve(API, '..', '..');

const ROOT = join(REPO, '.scratch');
const PGDATA = join(ROOT, 'postgres');
const SOCK = join(ROOT, 'pgsock');
const LOG = join(ROOT, 'postgres.log');
export const PORT = Number(process.env.TIRBEO_SCRATCH_PORT || 55432);
export const DB_NAME = process.env.TIRBEO_SCRATCH_DB || 'tirbeo_scratch';
export const DB_USER = process.env.TIRBEO_SCRATCH_USER || 'tirbeo';
const PG_MAJOR = process.env.TIRBEO_SCRATCH_PG || '18';

function bin(tool) {
  const p = `/usr/lib/postgresql/${PG_MAJOR}/bin/${tool}`;
  if (!existsSync(p)) {
    throw new Error(`no ${tool} at ${p} — set TIRBEO_SCRATCH_PG to the installed major version`);
  }
  return p;
}

/** Is our cluster running? pg_ctl's exit code answers it — 0 when there is a
    postmaster it recognises for this data directory, 3 when there is none. */
function listening() {
  return spawnSync(bin('pg_ctl'), ['-D', PGDATA, 'status'], { encoding: 'utf8' }).status === 0;
}

function pgCtl(...args) {
  return execFileSync(bin('pg_ctl'), ['-D', PGDATA, '-l', LOG, ...args], { encoding: 'utf8' });
}

function psql(sql, db = 'postgres', user = DB_USER) {
  return execFileSync(bin('psql'), ['-h', SOCK, '-p', String(PORT), '-U', user, '-d', db, '-tAc', sql], {
    encoding: 'utf8',
  });
}

function init() {
  mkdirSync(SOCK, { recursive: true, mode: 0o700 });
  chmodSync(SOCK, 0o700);
  // A cluster in a directory the operator can delete, with no password to
  // remember and nothing listening beyond loopback.
  execFileSync(bin('initdb'), ['-D', PGDATA, '-U', DB_USER, '-E', 'UTF8', '--auth-local=trust', '--auth-host=trust'], {
    stdio: 'inherit',
  });
}

function start() {
  pgCtl(
    'start',
    '-o',
    `-p ${PORT} -k ${SOCK} -c listen_addresses=127.0.0.1 -c unix_socket_permissions=0700 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
  );
}

function ensureDatabase() {
  const exists = psql(`select 1 from pg_database where datname = '${DB_NAME}'`).trim() === '1';
  if (exists) return false;
  execFileSync(bin('createdb'), ['-h', SOCK, '-p', String(PORT), '-U', DB_USER, DB_NAME], { encoding: 'utf8' });
  return true;
}

export function scratchUrls() {
  // sslmode=disable is part of the promise: this cluster has no certificate, and
  // an address that does not ask for TLS cannot accidentally be pointed at a
  // host that does.
  const tcp = `postgresql://${DB_USER}@127.0.0.1:${PORT}/${DB_NAME}?sslmode=disable`;
  return { tcp, direct: `postgresql://${DB_USER}@/${DB_NAME}?host=${SOCK}&charset=utf8` };
}

const commands = {
  up() {
    if (!existsSync(join(PGDATA, 'PG_VERSION'))) init();
    if (!listening()) start();
    else console.log(`already listening on 127.0.0.1:${PORT}`);
    const created = ensureDatabase();
    console.log(`scratch ${DB_NAME} ${created ? 'created' : 'already there'} — ${scratchUrls().tcp}`);
    console.log(psql('select version()').split(',')[0]);
  },
  down() {
    if (!existsSync(join(PGDATA, 'postmaster.pid'))) return console.log('not running');
    console.log(pgCtl('stop', '-m', 'fast').trim());
  },
  status() {
    const running = listening();
    const version = existsSync(join(PGDATA, 'PG_VERSION')) ? readFileSync(join(PGDATA, 'PG_VERSION'), 'utf8').trim() : 'not initialised';
    console.log(`data ${PGDATA} (${version})`);
    console.log(`port 127.0.0.1:${PORT} — ${running ? 'listening' : 'down'}`);
    if (running) console.log(`database ${DB_NAME} — ${psql(`select current_database()`, DB_NAME).trim()}`);
  },
  url() {
    console.log(scratchUrls().tcp);
  },
  // Without arguments this is an interactive shell; with any (typically `-c` or
  // `-Atc`) they go straight to psql, so a proof script can query the cluster
  // without re-deriving the socket path.
  psql(args = []) {
    execFileSync(bin('psql'), ['-h', SOCK, '-p', String(PORT), '-U', DB_USER, '-d', DB_NAME, ...args], {
      stdio: 'inherit',
    });
  },
  destroy() {
    commands.down();
    console.log(`remove ${ROOT} by hand when you are sure nothing else lives there`);
  },
};

/* Only act as a command line when run directly: scratch-env.mjs imports the
   connection strings from here, and a module that starts a database server as
   a side effect of being imported is a surprise worth avoiding. */
const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  const cmd = process.argv[2] || 'status';
  if (!commands[cmd]) {
    console.error(`usage: scratch-db.mjs <${Object.keys(commands).join('|')}>`);
    process.exit(2);
  }
  try {
    commands[cmd](process.argv.slice(3));
  } catch (e) {
    console.error(`${cmd} failed: ${e.stderr?.toString?.().trim() || e.message}`);
    process.exit(1);
  }
}
