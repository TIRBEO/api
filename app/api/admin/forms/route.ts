import { NextRequest, NextResponse } from 'next/server';
import { listAdminForms } from '@/lib/adminHandlers';

export async function GET(request: NextRequest) {
  return listAdminForms(request);
}
