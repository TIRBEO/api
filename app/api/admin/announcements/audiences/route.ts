import { NextRequest } from 'next/server';
import { withPermission } from '@/features/auth/permission-guard';
import { audiencesHandler } from '@/features/admin/announcements';

/** GET /api/admin/announcements/audiences — the size of each door before
 *  anybody commits to walking through it. */
export const GET = withPermission('notifications.read', async (request: NextRequest) =>
  audiencesHandler(request));
