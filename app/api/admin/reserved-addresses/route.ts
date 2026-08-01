import { NextRequest, NextResponse } from 'next/server';
import { reservedAddressesHandler } from '../../../../lib/adminHandlers';

export async function GET(request: NextRequest) {
  return reservedAddressesHandler(request);
}

export async function POST(request: NextRequest) {
  return reservedAddressesHandler(request);
}
