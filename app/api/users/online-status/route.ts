import { NextRequest, NextResponse } from 'next/server';
import { getLastSeenMap } from '../../../../lib/ws/server';

export async function GET(request: NextRequest) {
  try {
    const userIds = request.nextUrl.searchParams.get('userIds')?.split(',') || [];
    if (userIds.length === 0) {
      return NextResponse.json({ statuses: {} });
    }

    const statuses = getLastSeenMap(userIds);

    return NextResponse.json({ statuses });
  } catch {
    return NextResponse.json({ statuses: {} });
  }
}
