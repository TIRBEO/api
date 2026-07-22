import { NextRequest } from 'next/server';
import { listWorkspaces, deleteWorkspace, listWorkspaceMembers, addWorkspaceMember, removeWorkspaceMember } from '../../../../../lib/adminHandlers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const { action } = await params;
  const [workspaceId, subAction] = action || [];
  if (workspaceId && subAction === 'members') {
    return listWorkspaceMembers(request, workspaceId);
  }
  return listWorkspaces(request);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const { action } = await params;
  const [workspaceId, subAction] = action || [];
  if (workspaceId && subAction === 'members') {
    return addWorkspaceMember(request, workspaceId);
  }
  return new Response('Not found', { status: 404 });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const { action } = await params;
  const [workspaceId, subAction] = action || [];
  if (workspaceId && subAction === 'members') {
    return removeWorkspaceMember(request, workspaceId);
  }
  if (workspaceId) {
    return deleteWorkspace(request, workspaceId);
  }
  return new Response('Missing workspace id', { status: 400 });
}
