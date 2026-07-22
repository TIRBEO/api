import { NextRequest } from 'next/server';
import { seedAdminHandler } from '../../../../lib/adminHandlers';

export async function POST(request: NextRequest) {
  return seedAdminHandler(request);
}
