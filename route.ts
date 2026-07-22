// src/app/api/route.ts - API route handler for Next.js server
import { NextRequest, NextResponse } from 'next/server';
import { withApiKey, withClientId, withValidation, withCORS } from './middleware';
import { createUserProfile, updateUserProfile } from './userHandlers';
import { getUserActivityLogs } from './userHandlers';

// Profile endpoints
const profileRoutes = {
  '/api/profile': {
    POST: createUserProfile,
    PATCH: updateUserProfile,
  },
};

// Activity endpoints  
const activityRoutes = {
  '/api/profile/activity': {
    POST: async (req: NextRequest) => {
      const body = await req.json();
      // Log user activity
      return new NextResponse(JSON.stringify({ success: true, activityId: Date.now().toString() }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  },
  '/api/profile/activity-metrics': {
    GET: async (req: NextRequest) => {
      // Return activity metrics
      return new NextResponse(JSON.stringify({
        activitiesThisMonth: 24,
        streakDays: 7,
        avgDailyMinutes: 45,
        engagementRate: 0.85,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  },
  '/api/user/activity': {
    GET: getUserActivityLogs,
  },
};

const allRoutes = { ...profileRoutes, ...activityRoutes };

// Match route handler
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const path = url.pathname;

  const route = allRoutes[path];
  if (!route?.GET) {
    return new NextResponse('Not Found', { status: 404 });
  }

  return withCORS(route.GET)(request);
}

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const path = url.pathname;

  const route = allRoutes[path];
  if (!route?.POST) {
    return new NextResponse('Not Found', { status: 404 });
  }

  return withCORS(route.POST)(request);
}

export async function PATCH(request: NextRequest) {
  const url = new URL(request.url);
  const path = url.pathname;

  const route = allRoutes[path];
  if (!route?.PATCH) {
    return new NextResponse('Not Found', { status: 404 });
  }

  return withCORS(route.PATCH)(request);
}

export async function DELETE(request: NextRequest) {
  return new NextResponse('Method Not Allowed', { status: 405 });
}
