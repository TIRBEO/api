import { NextRequest } from 'next/server';
import {
  setup2faHandler,
  verify2faSetupHandler,
  disable2faHandler,
  status2faHandler,
  regenerateRecoveryCodesHandler,
} from '../../../../lib/admin2faHandlers';

export async function GET(request: NextRequest) {
  return status2faHandler(request);
}

export async function POST(request: NextRequest) {
  const cloned = request.clone();
  const body = await cloned.json().catch(() => ({}));
  const action = body._action || '';

  switch (action) {
    case 'setup':
      return setup2faHandler(request);
    case 'verify':
      return verify2faSetupHandler(request);
    case 'disable':
      return disable2faHandler(request);
    case 'regenerate-codes':
      return regenerateRecoveryCodesHandler(request);
    default:
      return new Response('Unknown 2FA action', { status: 400 });
  }
}
