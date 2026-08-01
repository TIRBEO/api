import { NextRequest } from 'next/server';
import { listOrganizations, deleteOrganization, listOrganizationMembers, addOrganizationMember, removeOrganizationMember } from '../../../../../lib/adminHandlers';

export async function GET(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const { action } = await params;
  const [orgId, subAction] = action || [];
  if (orgId && subAction === 'members') {
    return listOrganizationMembers(request, orgId);
  }
  return listOrganizations(request);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const { action } = await params;
  const [orgId, subAction] = action || [];
  if (orgId && subAction === 'members') {
    return addOrganizationMember(request, orgId);
  }
  return new Response('Not found', { status: 404 });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const { action } = await params;
  const [orgId, subAction] = action || [];
  if (orgId && subAction === 'members') {
    return removeOrganizationMember(request, orgId);
  }
  if (orgId) {
    return deleteOrganization(request, orgId);
  }
  return new Response('Missing organization id', { status: 400 });
}
