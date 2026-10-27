import { NextRequest } from 'next/server';
import { withPermission } from '@/features/auth/permission-guard';
import { announcementStatsHandler } from '@/features/admin/announcements';

/** GET /api/admin/announcements/stats — the numbers the graphs draw:
 *  notice opens, mail delivery and opens, and a 30-day send series. */
export const GET = withPermission('notifications.read', async (request: NextRequest) =>
  announcementStatsHandler(request));
