import { NextRequest } from 'next/server';
import { withPermission } from '@/features/auth/permission-guard';
import { announcementOpensHandler } from '@/features/admin/announcements';

/** GET /api/admin/announcements/opens?id= — who a notice went to, and who
 *  opened it. The addresses here are the console's reason for existing:
 *  "did anyone read it" is only honest if it names the ones who did not. */
export const GET = withPermission('notifications.read', async (request: NextRequest) =>
  announcementOpensHandler(request));
