import { NextRequest } from 'next/server';
import { listMediaHandler, uploadMediaHandler } from '../../../../lib/adminMediaHandlers';

export async function GET(request: NextRequest) {
  return listMediaHandler(request);
}

export async function POST(request: NextRequest) {
  return uploadMediaHandler(request);
}
