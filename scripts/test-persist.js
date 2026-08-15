const { Pool } = require('pg');
const fs = require('fs');

const env = fs.readFileSync('.env.local', 'utf8');
const match = env.match(/DATABASE_URL=['"]?(postgresql[^'"]+)/);
const url = match[1].replace(/['"]/g, '');
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function test() {
  // Get super_admin user
  const users = await pool.query("SELECT id FROM users WHERE admin_role = 'super_admin' LIMIT 1");
  const userId = users.rows[0].id;

  // Step 1: Read current prefs
  const before = await pool.query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);
  const b = before.rows[0] || {};
  console.log('=== BEFORE SAVE ===');
  console.log('quietHoursEnabled:', b.quiet_hours_enabled);
  console.log('quietHoursStart:', b.quiet_hours_start);
  console.log('securityEmail:', b.security_email);

  // Step 2: Save new values via UPSERT
  await pool.query(`
    INSERT INTO notification_preferences (user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, digest_enabled, digest_frequency, security_email, security_push, security_in_app, forms_email, forms_push, forms_in_app, product_email, product_push, product_in_app, support_email, support_push, support_in_app)
    VALUES ($1, true, '23:30', '06:30', true, 'weekly', false, true, false, true, true, false, true, false, true, true, true, true)
    ON CONFLICT (user_id) DO UPDATE SET
      quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
      quiet_hours_start = EXCLUDED.quiet_hours_start,
      quiet_hours_end = EXCLUDED.quiet_hours_end,
      digest_enabled = EXCLUDED.digest_enabled,
      digest_frequency = EXCLUDED.digest_frequency,
      security_email = EXCLUDED.security_email,
      security_push = EXCLUDED.security_push,
      security_in_app = EXCLUDED.security_in_app,
      forms_email = EXCLUDED.forms_email,
      forms_push = EXCLUDED.forms_push,
      forms_in_app = EXCLUDED.forms_in_app,
      product_email = EXCLUDED.product_email,
      product_push = EXCLUDED.product_push,
      product_in_app = EXCLUDED.product_in_app,
      support_email = EXCLUDED.support_email,
      support_push = EXCLUDED.support_push,
      support_in_app = EXCLUDED.support_in_app
  `, [userId]);
  console.log('\n=== SAVED ===');

  // Step 3: Read back to verify persistence
  const after = await pool.query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);
  const a = after.rows[0];
  console.log('\n=== AFTER SAVE (persistence check) ===');
  const checks = [
    ['quiet_hours_enabled', a.quiet_hours_enabled, true],
    ['quiet_hours_start', a.quiet_hours_start, '23:30'],
    ['quiet_hours_end', a.quiet_hours_end, '06:30'],
    ['digest_enabled', a.digest_enabled, true],
    ['digest_frequency', a.digest_frequency, 'weekly'],
    ['security_email', a.security_email, false],
    ['security_push', a.security_push, true],
    ['forms_in_app', a.forms_in_app, false],
    ['product_push', a.product_push, false],
    ['support_in_app', a.support_in_app, true],
  ];
  let allPass = true;
  for (const [field, actual, expected] of checks) {
    const pass = actual === expected;
    const icon = pass ? '✅' : '❌';
    console.log(`${icon} ${field}: ${JSON.stringify(actual)} ${pass ? '==' : '!='} ${JSON.stringify(expected)}`);
    if (!pass) allPass = false;
  }

  // Step 4: Simulate "page reload" — read again
  const reload = await pool.query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);
  const r = reload.rows[0];
  console.log('\n=== AFTER RELOAD (simulate page reload) ===');
  const reloadChecks = [
    ['quiet_hours_start', r.quiet_hours_start, '23:30'],
    ['digest_frequency', r.digest_frequency, 'weekly'],
    ['security_email', r.security_email, false],
  ];
  for (const [field, actual, expected] of reloadChecks) {
    const pass = actual === expected;
    const icon = pass ? '✅' : '❌';
    console.log(`${icon} ${field}: ${JSON.stringify(actual)} ${pass ? '==' : '!='} ${JSON.stringify(expected)}`);
    if (!pass) allPass = false;
  }

  console.log('\n' + (allPass ? '✅ ALL PERSISTENCE CHECKS PASSED — data survives page reloads' : '❌ SOME CHECKS FAILED'));
  await pool.end();
}

test().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
