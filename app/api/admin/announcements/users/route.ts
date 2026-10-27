import { NextRequest } from 'next/server';
import { withPermission } from '@/features/auth/permission-guard';
import { noticeUsersHandler } from '@/features/admin/announcements';

/** GET /api/admin/announcements/users — the accounts that take product
 *  mail right now (the send's own predicate), searchable and paged. */
export const GET = withPermission('notifications.read', async (request: NextRequest) =>
  noticeUsersHandler(request));
