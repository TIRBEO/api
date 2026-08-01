import { NextRequest } from 'next/server';
import { listUsers, getUserDetail, updateUser, deleteUser, updateUserRoles, banUser, unbanUser, suspendUser, unsuspendUser } from '../../../../../lib/adminHandlers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const { action } = await params;
  const [userId] = action || [];
  if (userId) return getUserDetail(request, userId);
  return listUsers(request);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const { action } = await params;
  const [userId] = action || [];
  if (!userId) return new Response('Missing user id', { status: 400 });

  if (action?.[1] === 'roles') {
    return updateUserRoles(request, userId);
  }
  if (action?.[1] === 'ban') {
    return banUser(request, userId);
  }
  if (action?.[1] === 'unban') {
    return unbanUser(request, userId);
  }
  if (action?.[1] === 'suspend') {
    return suspendUser(request, userId);
  }
  if (action?.[1] === 'unsuspend') {
    return unsuspendUser(request, userId);
  }
  return updateUser(request, userId);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const { action } = await params;
  const [userId] = action || [];
  if (!userId) return new Response('Missing user id', { status: 400 });
  return deleteUser(request, userId);
}
