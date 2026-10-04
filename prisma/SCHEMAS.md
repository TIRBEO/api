# Tirbeo — Postgres schemas (source of truth)

Generated from the live database after applying `prisma/clean-rebuild-v2.sql`.
Prisma multi-schema: `datasource db { schemas = [...] }` + `@@schema(...)` on every model.

**Rules**
- `user` is a reserved word — always quote: `"user".users`.
- Every raw SQL (`$queryRaw` / `$executeRaw`) must schema-qualify tables; never rely on search_path.
- Baseline DDL: `prisma/clean-rebuild-v2.sql`; legacy `prisma/migrations/` + `prisma/consolidation/` deleted. Drift check: `npx prisma db push`.
- Later DDL arrives as named, idempotent SQL files next to the baseline (`org-foundation.sql`, `add-data-export-requests.sql`), replayed after it, and applied with `npx prisma db execute --file prisma/<name>.sql`; `schema.prisma` stays the source of truth and the drift check has to come back empty afterwards. Nothing is dropped and no `--reset` is ever used.
- Supabase-managed schemas (`auth`, `realtime`, `storage`, `extensions`, `supabase_migrations`, `vault`, `graphql`) are never touched.
- `public` is kept empty (Supabase compat); app tables never live there.

| Schema | Tables |
|---|---|
| `user` | 6: `identities`, `notifications`, `push_subscriptions`, `user_phone`, `user_profile`, `users` |
| `preferences` | 1: `user_preferences` |
| `email` | 12: `email_configs`, `email_definitions`, `email_deliveries`, `email_digest_items`, `email_digests`, `email_events`, `email_jobs`, `email_preferences`, `email_suppressions`, `email_templates`, `email_versions`, `user_email` |
| `security` | 14: `blocklist`, `captcha_attempts`, `captcha_blocks`, `captcha_challenges`, `captcha_logs`, `captcha_settings`, `device_accounts`, `otps`, `passkeys`, `security_events`, `user_devices`, `user_logins`, `user_security`, `user_sessions` |
| `status` | 5: `user_appeals`, `user_deactivations`, `user_deletion_requests`, `user_restrictions`, `user_status_events` |
| `activity` | 3: `activity_events`, `data_export_requests`, `user_tip_logs` |
| `content` | 3: `incident_events`, `landing_page_publications`, `landing_pages` |
| `support` | 3: `ticket_attachments`, `ticket_messages`, `tickets` |
| `forms` | 5: `form_analytics`, `form_connections`, `form_fields`, `form_submissions`, `forms` |
| `media` | 12: `cdn_activity`, `cdn_buckets`, `cdn_cache_purges`, `cdn_categories`, `cdn_domains`, `cdn_files`, `cdn_hosting_configs`, `cdn_projects`, `cdn_settings`, `cdn_webhook_deliveries`, `cdn_webhooks`, `media` |
| `ops` | 5: `ai_generations`, `api_keys`, `app_config`, `cooldowns`, `verification_limits` |

Total: 68 tables. `ops.job_runs` is created on demand by `jobs/job-gate.ts` (not in the Prisma schema).
