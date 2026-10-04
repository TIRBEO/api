require('dotenv').config({ path: '.env.local' });
const { Client } = require('pg');

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query(
    `INSERT INTO email_deliveries (job_id, to_email, event_key, category, subject, status, provider, message_id, from_email, metadata)
     VALUES ('test-'||gen_random_uuid(), 'bishnuneup4ne@gmail.com', 'legacy.ad_hoc', 'system', 'db insert check', 'sent', 'test', 'msg-123', 'noreply@tirbeo.com', '{"src":"dbcheck"}'::jsonb)`
  );
  const r = await c.query('SELECT id, status, metadata, from_email FROM email_deliveries ORDER BY created_at DESC LIMIT 1');
  console.log('INSERT OK ->', JSON.stringify(r.rows[0]));
  await c.end();
  process.exit(0);
}
main().catch((e) => {
  console.error('ERR', e.message || e);
  process.exit(1);
});