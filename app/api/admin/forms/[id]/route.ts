import { NextRequest, NextResponse } from 'next/server';
import { getAdminFormDetails } from '@/lib/adminHandlers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return getAdminFormDetails(request, id);
}
