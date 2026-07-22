import { NextRequest } from 'next/server';
import { analyticsHandler } from '../../../../lib/adminAnalyticsHandlers';

export async function GET(request: NextRequest) {
  return analyticsHandler(request);
}
