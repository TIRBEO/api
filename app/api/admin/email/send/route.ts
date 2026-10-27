import { NextRequest } from 'next/server';
import { withPermission } from '@/features/auth/permission-guard';
import { adminMailSendHandler } from '@/features/admin/announcements';

/** POST /api/admin/email/send — a composed mail to a chosen audience.
 *
 *  `notifications.send` is the power: this is the same act the broadcast
 *  performs, with the words chosen at the door rather than from a template.
 *  Every mail still wears the platform's own shell and still answers to each
 *  account's product-mail switch — the suppression gate is in the sender,
 *  not in the composer. */
export const POST = withPermission('notifications.send', async (request: NextRequest, session) =>
  adminMailSendHandler(request, session));
