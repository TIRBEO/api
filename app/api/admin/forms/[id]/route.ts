import { NextRequest, NextResponse } from 'next/server';
import { getAdminFormDetails, updateAdminForm, deleteAdminForm } from '@/lib/adminHandlers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return getAdminFormDetails(request, id);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return updateAdminForm(request, id);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return deleteAdminForm(request, id);
}
