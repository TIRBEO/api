const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function run() {
  const tables = ['users','sessions','workspaces','memberships','notifications','audit_events','integrations','media'];
  for (const t of tables) {
    try { await p.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`); } catch(e) {}
  }

  const policies = [
    { table: 'users', name: 'users_select_public', sql: "CREATE POLICY users_select_public ON users FOR SELECT USING (true)" },
    { table: 'users', name: 'users_update_own', sql: "CREATE POLICY users_update_own ON users FOR UPDATE USING (id = current_setting('request.jwt.claims', true)::json->>'sub')" },
    { table: 'sessions', name: 'sessions_own_all', sql: "CREATE POLICY sessions_own_all ON sessions FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub')" },
    { table: 'workspaces', name: 'workspaces_public_read', sql: "CREATE POLICY workspaces_public_read ON workspaces FOR SELECT USING (is_public = true OR owner_id = current_setting('request.jwt.claims', true)::json->>'sub')" },
    { table: 'notifications', name: 'notifications_own_all', sql: "CREATE POLICY notifications_own_all ON notifications FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub')" },
    { table: 'audit_events', name: 'audit_events_admin_read', sql: "CREATE POLICY audit_events_admin_read ON audit_events FOR SELECT USING (EXISTS (SELECT 1 FROM users WHERE id = current_setting('request.jwt.claims', true)::json->>'sub' AND admin_role IS NOT NULL))" },
    { table: 'integrations', name: 'integrations_own_all', sql: "CREATE POLICY integrations_own_all ON integrations FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub')" },
  ];

  for (const p2 of policies) {
    try {
      await p.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = '${p2.name}' AND tablename = '${p2.table}') THEN ${p2.sql}; END IF; END $$`);
      console.log('Applied:', p2.name);
    } catch(e) { console.log('Skip:', p2.name, e.message.slice(0,80)); }
  }

  console.log('Done');
  await p.$disconnect();
}

run().catch(e => { console.error(e); process.exit(0); });
