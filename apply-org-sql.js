const { Client } = require("pg");
const fs = require("fs");
(async () => {
  const url = process.env.DATABASE_URL;
  const c = new Client({ connectionString: url });
  await c.connect();
  const sql = fs.readFileSync(process.env.SQL_FILE, "utf8");
  // strip comments, split on semicolons (no semicolons inside the SQL)
  const stmts = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of stmts) {
    try {
      await c.query(stmt);
      console.log("OK:", stmt.split("\n")[0].slice(0, 70));
    } catch (e) {
      console.log("ERR:", stmt.split("\n")[0].slice(0, 70), "->", e.message.split("\n")[0]);
    }
  }
  await c.end();
  console.log("done");
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
