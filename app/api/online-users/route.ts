import { NextResponse } from 'next/server';
import { getOnlineUserIds } from '../../../lib/ws/server';

export async function GET() {
  try {
    const onlineIds = getOnlineUserIds();
    return NextResponse.json({ count: onlineIds.length, userIds: onlineIds });
  } catch {
    return NextResponse.json({ count: 0, userIds: [] });
  }
}
