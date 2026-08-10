import { prisma } from './db/prisma';

export type PermissionSet = Record<string, boolean>;

export const ALL_PERMISSIONS: PermissionSet = {
  // System
  'access.dashboard': true,
  'system.routes': true,
  'system.monitor': true,
  'system.users': true,
  'system.users.manage': true,
  'system.users.delete': true,
  'system.workspaces': true,
  'system.workspaces.delete': true,
  // Landing settings
  'landing.view': true,
  'landing.edit': true,
  // Accounts settings
  'accounts.view': true,
  'accounts.edit': true,
  // Dashboard settings
  'settings.dashboard.view': true,
  'settings.dashboard.edit': true,
  // Admin settings
  'settings.admin.view': true,
  'settings.admin.edit': true,
  // API settings
  'settings.api.view': true,
  'settings.api.edit': true,
  // Roles
  'roles.view': true,
  'roles.create': true,
  'roles.edit': true,
  'roles.delete': true,
  // Domains
  'domains.view': true,
  // Email
  'system.email': true,
  'system.email.templates': true,
  // Audit
  'system.audit': true,
  // Notifications
  'system.notifications': true,
  'system.notifications.prefs': true,
  // Moderation
  'system.moderation': true,
};

export const PERMISSION_GROUPS = [
  {
    label: 'Access',
    keys: [
      { key: 'access.dashboard', label: 'Dashboard overview' },
    ],
  },
  {
    label: 'System Management',
    keys: [
      { key: 'system.routes', label: 'View & manage routes' },
      { key: 'system.monitor', label: 'View monitor & logs' },
      { key: 'system.users', label: 'View users' },
      { key: 'system.users.manage', label: 'Edit / update users' },
      { key: 'system.users.delete', label: 'Delete users' },
      { key: 'system.workspaces', label: 'View workspaces' },
      { key: 'system.workspaces.delete', label: 'Delete workspaces' },
    ],
  },
  {
    label: 'Landing Settings',
    keys: [
      { key: 'landing.view', label: 'View landing settings' },
      { key: 'landing.edit', label: 'Edit landing settings' },
    ],
  },
  {
    label: 'Accounts Settings',
    keys: [
      { key: 'accounts.view', label: 'View accounts settings' },
      { key: 'accounts.edit', label: 'Edit accounts settings' },
    ],
  },
  {
    label: 'Dashboard Settings',
    keys: [
      { key: 'settings.dashboard.view', label: 'View dashboard settings' },
      { key: 'settings.dashboard.edit', label: 'Edit dashboard settings' },
    ],
  },
  {
    label: 'Admin Settings',
    keys: [
      { key: 'settings.admin.view', label: 'View admin settings' },
      { key: 'settings.admin.edit', label: 'Edit admin settings' },
    ],
  },
  {
    label: 'API Settings',
    keys: [
      { key: 'settings.api.view', label: 'View API settings' },
      { key: 'settings.api.edit', label: 'Edit API settings' },
    ],
  },
  {
    label: 'Role Management',
    keys: [
      { key: 'roles.view', label: 'View roles' },
      { key: 'roles.create', label: 'Create roles' },
      { key: 'roles.edit', label: 'Edit roles' },
      { key: 'roles.delete', label: 'Delete roles' },
    ],
  },
  {
    label: 'Domain Settings',
    keys: [
      { key: 'domains.view', label: 'View domain settings' },
    ],
  },
  {
    label: 'Email & Notifications',
    keys: [
      { key: 'system.email', label: 'Email configuration & templates' },
      { key: 'system.email.templates', label: 'Edit email templates' },
    ],
  },
  {
    label: 'Audit Trail',
    keys: [
      { key: 'system.audit', label: 'View audit trail' },
    ],
  },
  {
    label: 'Notifications',
    keys: [
      { key: 'system.notifications', label: 'View notifications & bell' },
      { key: 'system.notifications.prefs', label: 'Manage notification preferences' },
    ],
  },
  {
    label: 'Content Moderation',
    keys: [
      { key: 'system.moderation', label: 'View & manage content reports' },
    ],
  },
];

export const LEGACY_ROLE_PERMISSIONS: Record<string, PermissionSet> = {
  admin: Object.fromEntries(
    Object.keys(ALL_PERMISSIONS).map(k => [k, true])
  ),
  manager: {
    'access.dashboard': true,
    'system.routes': true,
    'system.monitor': true,
    'system.users': true,
    'system.users.manage': true,
    'system.workspaces': true,
    'landing.view': true,
    'accounts.view': true,
    'settings.dashboard.view': true,
    'settings.admin.view': true,
    'settings.api.view': true,
    'roles.view': true,
    'domains.view': true,
  },
  editor: {
    'access.dashboard': true,
    'system.routes': true,
    'system.monitor': true,
    'system.users': true,
    'landing.view': true,
    'landing.edit': true,
  },
};

// ─── App permission scaffold: view / edit / both / off ───

export type AppPermissionLevel = 'view' | 'edit' | 'both' | 'off';

export interface PermissionResource {
  key: string;
  label: string;
  description: string;
  viewKey: string;
  editKey?: string;
}

export const PERMISSION_RESOURCES: PermissionResource[] = [
  {
    key: 'landing',
    label: 'Landing',
    description: 'Landing page config & content',
    viewKey: 'landing.view',
    editKey: 'landing.edit',
  },
  {
    key: 'accounts',
    label: 'Accounts',
    description: 'Accounts / identity settings',
    viewKey: 'accounts.view',
    editKey: 'accounts.edit',
  },
  {
    key: 'dashboard',
    label: 'Dashboard',
    description: 'Dashboard settings & apps',
    viewKey: 'settings.dashboard.view',
    editKey: 'settings.dashboard.edit',
  },
  {
    key: 'admin',
    label: 'Admin',
    description: 'Admin panel settings',
    viewKey: 'settings.admin.view',
    editKey: 'settings.admin.edit',
  },
  {
    key: 'api',
    label: 'API',
    description: 'API configuration',
    viewKey: 'settings.api.view',
    editKey: 'settings.api.edit',
  },
  {
    key: 'users',
    label: 'Users',
    description: 'User directory & management',
    viewKey: 'system.users',
    editKey: 'system.users.manage',
  },
  {
    key: 'workspaces',
    label: 'Workspaces',
    description: 'Workspace directory',
    viewKey: 'system.workspaces',
    editKey: 'system.workspaces.delete',
  },
  {
    key: 'roles',
    label: 'Roles',
    description: 'Roles & permission management',
    viewKey: 'roles.view',
    editKey: 'roles.edit',
  },
  {
    key: 'email',
    label: 'Email',
    description: 'Email config & templates',
    viewKey: 'system.email',
    editKey: 'system.email.templates',
  },
  {
    key: 'monitor',
    label: 'Monitor',
    description: 'System health & logs',
    viewKey: 'system.monitor',
    editKey: 'system.routes',
  },
  {
    key: 'audit',
    label: 'Audit',
    description: 'Audit trail & security events',
    viewKey: 'system.audit',
  },
  {
    key: 'moderation',
    label: 'Moderation',
    description: 'Content reports & moderation',
    viewKey: 'system.moderation',
  },
];

export function permissionLevel(perms: PermissionSet, resource: PermissionResource): AppPermissionLevel {
  const view = perms[resource.viewKey] === true;
  const edit = !!resource.editKey && perms[resource.editKey] === true;
  if (view && edit) return 'both';
  if (edit) return 'edit';
  if (view) return 'view';
  return 'off';
}

export function permissionSetForLevel(level: AppPermissionLevel, resource: PermissionResource): PermissionSet {
  const set: PermissionSet = {};
  if (level === 'view' || level === 'both') set[resource.viewKey] = true;
  if (resource.editKey && (level === 'edit' || level === 'both')) set[resource.editKey] = true;
  return set;
}

export function permissionsFromLevels(levels: Record<string, AppPermissionLevel>): PermissionSet {
  const out: PermissionSet = {};
  for (const resource of PERMISSION_RESOURCES) {
    const level = levels[resource.key];
    if (level) Object.assign(out, permissionSetForLevel(level, resource));
  }
  return out;
}

export function normalizePermissions(raw: unknown): PermissionSet {
  if (!raw || typeof raw !== 'object') return {};
  const out: PermissionSet = {};
  const allowed = new Set(Object.keys(ALL_PERMISSIONS));
  for (const [key, value] of Object.entries(raw)) {
    if (allowed.has(key) && value === true) out[key] = true;
  }
  return out;
}

export async function getEffectivePermissions(userId: string): Promise<PermissionSet> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { adminRole: true },
  });
  if (!user) return {};

  // Normalize legacy/underscore variants (e.g. "superadmin" -> "super_admin")
  const role = (user.adminRole || '').replace(/^superadmin$/, 'super_admin');

  // super_admin gets ALL
  if (role === 'super_admin') {
    return { ...ALL_PERMISSIONS };
  }

  // Legacy admin/manager/editor get mapped permissions
  if (role && role in LEGACY_ROLE_PERMISSIONS) {
    return { ...LEGACY_ROLE_PERMISSIONS[role] };
  }

  // Check assigned roles
  const assignments = await prisma.userRole.findMany({
    where: { userId },
    include: { role: { select: { permissions: true } } },
  });

  if (assignments.length === 0) {
    return {};
  }

  // Aggregate permissions across all assigned roles
  const perms: PermissionSet = {};
  for (const a of assignments) {
    const rolePerms = a.role.permissions as Record<string, boolean>;
    for (const [k, v] of Object.entries(rolePerms)) {
      if (v) perms[k] = true;
    }
  }
  return perms;
}

export function hasPermission(perms: PermissionSet, key: string): boolean {
  return perms[key] === true;
}

export async function requirePermission(
  userId: string,
  permission: string
): Promise<boolean> {
  const perms = await getEffectivePermissions(userId);
  return hasPermission(perms, permission);
}
