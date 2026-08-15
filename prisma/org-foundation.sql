-- Tirbeo org foundation migration
-- Drops the empty Workspace tables and creates the clean Organization + RBAC tables.
-- NOTE: this preserves the Flows data tables (data_tables, widgets, ...) which are
-- present in the DB but not modelled in schema.prisma.

-- 1. Drop workspace tables (empty; FK references from flows tables are dropped with CASCADE,
--    which only removes the FK constraint on the flows side, not the tables or their data).
DROP TABLE IF EXISTS workspace_invitations CASCADE;
DROP TABLE IF EXISTS workspace_members CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;

-- 2. Organizations
CREATE TABLE IF NOT EXISTS organizations (
  id         TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  logo_url   TEXT,
  description TEXT,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan       TEXT NOT NULL DEFAULT 'free',
  settings   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_id);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

-- 3. Roles (organizationId NULL = system/global role template)
CREATE TABLE IF NOT EXISTS roles (
  id              TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  color           TEXT DEFAULT '#FF6500',
  is_system       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT roles_org_name_unique UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_roles_organization ON roles(organization_id);

-- 4. Permissions (catalog)
CREATE TABLE IF NOT EXISTS permissions (
  id          TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  "group"     TEXT NOT NULL DEFAULT 'organization',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_permissions_group ON permissions("group");

-- 5. Role ↔ Permission join
CREATE TABLE IF NOT EXISTS role_permissions (
  id            TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT role_permissions_unique UNIQUE (role_id, permission_id)
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission ON role_permissions(permission_id);

-- 6. Organization members
CREATE TABLE IF NOT EXISTS organization_members (
  id              TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id         TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'active',
  invited_at      TIMESTAMPTZ,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organization_members_unique UNIQUE (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_role ON organization_members(role_id);

-- 7. Organization invitations
CREATE TABLE IF NOT EXISTS organization_invitations (
  id              TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role_id         TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  token           TEXT NOT NULL UNIQUE,
  invited_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending',
  accepted_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON organization_invitations(email);
CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON organization_invitations(token);
CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON organization_invitations(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_invitations_role ON organization_invitations(role_id);
