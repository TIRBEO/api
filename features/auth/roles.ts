import { prisma } from '@/infrastructure/db/prisma';

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

export async function getEffectivePermissions(userId: string): Promise<PermissionSet> {
  // Consolidated schema: adminRole column replaced by boolean isAdmin; admins
  // map to the legacy 'admin' role so their permission set is unchanged.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true },
  });
  if (!user) return {};

  const role: string = user.isAdmin ? 'admin' : '';

  // super_admin gets ALL
  if (role === 'super_admin') {
    return { ...ALL_PERMISSIONS };
  }

  // Legacy admin/manager/editor get mapped permissions
  if (role && role in LEGACY_ROLE_PERMISSIONS) {
    return { ...LEGACY_ROLE_PERMISSIONS[role] };
  }

  return {};
}
