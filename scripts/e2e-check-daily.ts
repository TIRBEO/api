/* Throwaway cross-check for Phase E slice #10.

   The HTTP harness proves the shape; this proves the *arithmetic* — that the
   day buckets the endpoint hands back are exactly the rows the two ledgers
   hold for this user, bucketed in the zone it was asked for. Run:

     set -a && . /tmp/tirbeo-e2e.env && set +a
     npx tsx --env-file=.env.local scripts/e2e-check-daily.ts
*/
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/db/prisma';
import http from 'node:http';

const TOKEN = process.env.E2E_TOKEN!;
const USER = process.env.E2E_USER_ID!;
if (!TOKEN || !USER) throw new Error('E2E_TOKEN / E2E_USER_ID are not in the environment');

const DAY = 86_400_000;
const DAYS = 30;

type Bucket = { day: string; kind: string; count: number };

function fetchJson(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: 3000, method: 'GET', path, headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${detail}`}`);
}

const { raw } = Prisma;

/** Bucketed the way the handler does it: Postgres shifts the instant into the
    zone, then takes the date off the result. Column and table names are
    interpolated here because this is the check, not the endpoint — it is the
    thing being compared against, written out longhand on purpose. */
async function expected(tz: string, table: string, kindCol: string, extra: string): Promise<Bucket[]> {
  const since = new Date(Date.now() - DAYS * DAY);
  return prisma.$queryRaw<Bucket[]>`
    select to_char(created_at at time zone ${tz}::text, 'YYYY-MM-DD') as day,
           ${raw(kindCol)} as kind, count(*)::int as count
    from ${raw(table)}
    where user_id = ${USER} and created_at >= ${since} ${raw(extra)}
    group by 1, 2
    order by 1`;
}

const key = (rows: Bucket[]) =>
  JSON.stringify([...rows].sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind)));

(async () => {
  for (const tz of ['UTC', 'Asia/Kathmandu', 'Pacific/Kiritimati']) {
    console.log(`\n=== ${tz} ===`);
    const reply = await fetchJson(`/api/user/activity/daily?days=${DAYS}&tz=${encodeURIComponent(tz)}`);
    const [events, signIns] = await Promise.all([
      expected(tz, '"activity".activity_events', 'kind', ''),
      expected(tz, '"security".user_logins', 'method', 'and success = true'),
    ]);
    check(`${tz}: feed buckets match the table row for row`, key(reply.events) === key(events), `${JSON.stringify(reply.events)} vs ${JSON.stringify(events)}`);
    check(`${tz}: sign-in buckets match the ledger`, key(reply.signIns) === key(signIns), `${JSON.stringify(reply.signIns)} vs ${JSON.stringify(signIns)}`);
  }

  // A day that only exists in another zone must be bucketed by the asked-for one.
  const utc = await fetchJson('/api/user/activity/daily?days=30&tz=UTC');
  const ktm = await fetchJson('/api/user/activity/daily?days=30&tz=Asia%2FKathmandu');
  const daysIn = (rows: Bucket[]) => new Set(rows.map((r) => r.day));
  const shifted = [...daysIn(utc.events), ...daysIn(utc.signIns)].filter((d) => !daysIn([...ktm.events, ...ktm.signIns]).has(d));
  console.log(`        (days present in UTC only: ${shifted.join(', ') || 'none'})`);
  const sum = (rows: Bucket[]) => rows.reduce((s, r) => s + r.count, 0);
  check('re-zoning moves days, never rows', sum([...utc.events, ...utc.signIns]) === sum([...ktm.events, ...ktm.signIns]), `${sum(utc.events)} vs ${sum(ktm.events)}`);

  // Failed sign-ins are not activity the account did.
  const [failed, allLogins, allEvents] = await Promise.all([
    prisma.userLogin.count({ where: { userId: USER, success: false } }),
    prisma.userLogin.count({ where: { userId: USER, success: true, createdAt: { gte: new Date(Date.now() - DAYS * DAY) } } }),
    prisma.activityEvent.count({ where: { userId: USER, createdAt: { gte: new Date(Date.now() - DAYS * DAY) } } }),
  ]);
  const reply = await fetchJson(`/api/user/activity/daily?days=${DAYS}&tz=UTC`);
  const counted = sum([...reply.events, ...reply.signIns]);
  check('the total is both ledgers and nothing else', counted === allLogins + allEvents, `${counted} vs ${allLogins}+${allEvents}`);
  check('the seeded account does have a failed sign-in on file', failed > 0, `${failed}`);
  check('and no failed sign-in is counted', reply.signIns.every((r: Bucket) => r.kind !== 'failed'), JSON.stringify(reply.signIns));

  console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'all checks passed'}`);
  process.exit(failures ? 1 : 0);
})();
