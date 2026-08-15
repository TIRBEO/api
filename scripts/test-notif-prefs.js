const { Pool } = require('pg');
const http = require('http');
const fs = require('fs');

// Read DB URL
const env = fs.readFileSync('.env.local', 'utf8');
const match = env.match(/DATABASE_URL=['"]?(postgresql[^'"]+)/);
const url = match[1].replace(/['"]/g, '');
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

function apiRequest(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1', port: 3000, path, method,
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'http://localhost:3005',
      },
    };
    if (cookie) options.headers['Cookie'] = cookie;
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);

    const req = http.request(options, (res) => {
      let data = '';
      // Capture set-cookie from redirect
      const setCookie = res.headers['set-cookie'];
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), setCookie }); }
        catch { resolve({ status: res.statusCode, body: data, setCookie }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function main() {
  console.log('1. Login to get session cookie...');
  // Get CSRF token first
  const csrfRes = await apiRequest('GET', '/api/health');
  
  // Login to get session
  const loginRes = await apiRequest('POST', '/api/auth/login', {
    email: 'admin@tirbeo.app',
    password: 'admin123',
  });
  
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.status, loginRes.body);
    // Try direct DB approach instead
    console.log('\nDirect DB test instead...');
    await testDirectDB();
    return;
  }
  
  // Extract session cookie
  const sessionCookie = loginRes.setCookie?.find(c => c.includes('__session'));
  const session = sessionCookie?.split(';')[0];
  const csrfCookie = loginRes.setCookie?.find(c => c.includes('__csrf'));
  const csrf = csrfCookie?.split(';')[0];
  const cookie = [session, csrf].filter(Boolean).join('; ');
  
  console.log('   Logged in:', loginRes.status);

  console.log('\n2. GET /api/notifications/prefs...');
  const getRes = await apiRequest('GET', '/api/notifications/prefs', null, cookie);
  console.log('   Status:', getRes.status);
  if (getRes.status === 200) {
    console.log('   Current prefs:');
    console.log('     email:', getRes.body.email);
    console.log('     push:', getRes.body.push);
    console.log('     inApp:', getRes.body.inApp);
    console.log('     security:', getRes.body.security);
    console.log('     forms:', getRes.body.forms);
    console.log('     product:', getRes.body.product);
    console.log('     support:', getRes.body.support);
    console.log('     securityEmail:', getRes.body.securityEmail);
    console.log('     quietHoursEnabled:', getRes.body.quietHoursEnabled);
    console.log('     quietHoursStart:', getRes.body.quietHoursStart);
    console.log('     digestEnabled:', getRes.body.digestEnabled);
  } else {
    console.log('   Error:', getRes.body);
    await testDirectDB();
    return;
  }

  console.log('\n3. PUT /api/notifications/prefs (save quiet hours + per-category)...');
  const saveData = {
    quietHoursEnabled: true,
    quietHoursStart: '23:00',
    quietHoursEnd: '07:00',
    digestEnabled: true,
    digestFrequency: 'weekly',
    securityEmail: false,
    securityPush: true,
    formsInApp: false,
  };
  const putRes = await apiRequest('PUT', '/api/notifications/prefs', saveData, cookie);
  console.log('   Status:', putRes.status);
  console.log('   Response:', putRes.body);

  console.log('\n4. GET /api/notifications/prefs again (verify persistence)...');
  const verifyRes = await apiRequest('GET', '/api/notifications/prefs', null, cookie);
  console.log('   Status:', verifyRes.status);
  if (verifyRes.status === 200) {
    const v = verifyRes.body;
    const checks = [
      ['quietHoursEnabled', v.quietHoursEnabled, true],
      ['quietHoursStart', v.quietHoursStart, '23:00'],
      ['quietHoursEnd', v.quietHoursEnd, '07:00'],
      ['digestEnabled', v.digestEnabled, true],
      ['digestFrequency', v.digestFrequency, 'weekly'],
      ['securityEmail', v.securityEmail, false],
      ['securityPush', v.securityPush, true],
      ['formsInApp', v.formsInApp, false],
    ];
    let allPass = true;
    for (const [field, actual, expected] of checks) {
      const pass = actual === expected;
      console.log(`   ${pass ? '✅' : '❌'} ${field}: ${JSON.stringify(actual)} ${pass ? '==' : '!='} ${JSON.stringify(expected)}`);
      if (!pass) allPass = false;
    }
    console.log(`\n${allPass ? '✅ ALL PERSISTENCE CHECKS PASSED' : '❌ SOME CHECKS FAILED'}`);
  } else {
    console.log('   Error:', verifyRes.body);
  }

  await pool.end();
}

async function testDirectDB() {
  console.log('\nDirect DB verification...');
  
  // Check columns exist
  const cols = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'notification_preferences' ORDER BY ordinal_position"
  );
  const colNames = cols.rows.map(r => r.column_name);
  console.log('   Total columns:', colNames.length);
  
  const expected = [
    'quiet_hours_enabled', 'quiet_hours_start', 'quiet_hours_end',
    'digest_enabled', 'digest_frequency',
    'security_email', 'security_push', 'security_in_app',
    'forms_email', 'forms_push', 'forms_in_app',
    'product_email', 'product_push', 'product_in_app',
    'support_email', 'support_push', 'support_in_app',
  ];
  const missing = expected.filter(c => !colNames.includes(c));
  if (missing.length) {
    console.log('   ❌ Missing columns:', missing);
  } else {
    console.log('   ✅ All 17 new columns present');
  }

  // Test UPSERT
  const user = await pool.query('SELECT id FROM users LIMIT 1');
  if (user.rows.length) {
    const uid = user.rows[0].id;
    await pool.query(`
      INSERT INTO notification_preferences (user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, digest_enabled, digest_frequency, security_email, security_push, security_in_app, forms_email, forms_push, forms_in_app, product_email, product_push, product_in_app, support_email, support_push, support_in_app)
      VALUES ($1, true, '23:00', '07:00', true, 'weekly', false, true, false, true, true, false, true, true, true, true, true, true)
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
    `, [uid]);
    console.log('   ✅ UPSERT succeeded');

    // Read back
    const read = await pool.query('SELECT * FROM notification_preferences WHERE user_id = $1', [uid]);
    const row = read.rows[0];
    const checks = [
      ['quiet_hours_enabled', row.quiet_hours_enabled, true],
      ['quiet_hours_start', row.quiet_hours_start, '23:00'],
      ['quiet_hours_end', row.quiet_hours_end, '07:00'],
      ['digest_enabled', row.digest_enabled, true],
      ['digest_frequency', row.digest_frequency, 'weekly'],
      ['security_email', row.security_email, false],
      ['security_push', row.security_push, true],
      ['forms_in_app', row.forms_in_app, false],
    ];
    let allPass = true;
    for (const [field, actual, expected] of checks) {
      const pass = actual === expected;
      console.log(`   ${pass ? '✅' : '❌'} ${field}: ${JSON.stringify(actual)} ${pass ? '==' : '!='} ${JSON.stringify(expected)}`);
      if (!pass) allPass = false;
    }
    console.log(`\n${allPass ? '✅ ALL DB PERSISTENCE CHECKS PASSED' : '❌ SOME DB CHECKS FAILED'}`);
  }

  await pool.end();
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
