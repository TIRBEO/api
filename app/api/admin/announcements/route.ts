import { NextRequest } from 'next/server';
import { withPermission } from '@/features/auth/permission-guard';
import { announcementsListHandler, announcementSendHandler } from '@/features/admin/announcements';

/** /api/admin/announcements — the sent list, and the door that adds to it.
 *
 *  GET answers every announcement the console has broadcast, newest first,
 *  each with how many inboxes it reached and how many of those opened it.
 *  POST files a new one: the ledger row is written first, so a send that
 *  dies halfway still has a record naming what was attempted. */
export const GET = withPermission('notifications.read', async (request: NextRequest) =>
  announcementsListHandler(request));

export const POST = withPermission('notifications.send', async (request: NextRequest, session) =>
  announcementSendHandler(request, session));
