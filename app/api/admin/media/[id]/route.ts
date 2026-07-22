import { NextRequest } from 'next/server';
import { getMediaHandler, updateMediaHandler, deleteMediaHandler } from '../../../../../lib/adminMediaHandlers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return getMediaHandler(request, id);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return updateMediaHandler(request, id);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return deleteMediaHandler(request, id);
}
