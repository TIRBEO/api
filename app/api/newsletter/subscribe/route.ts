import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../lib/db/prisma';
import { sanitizeInput } from '../../../../lib/security';

const subscribeSchema = z.object({
  email: z.string().email('Invalid email address'),
  name: z.string().max(100).optional(),
  source: z.enum(['landing', 'footer', 'admin']).default('landing'),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = subscribeSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 },
      );
    }

    const { email, name, source } = parsed.data;
    const cleanName = name ? sanitizeInput(name, 100) : undefined;

    const existing = await prisma.subscriber.findUnique({ where: { email } });
    if (existing) {
      if (existing.status === 'ACTIVE') {
        return NextResponse.json(
          { message: 'You are already subscribed!' },
          { status: 200 },
        );
      }
      await prisma.subscriber.update({
        where: { email },
        data: { status: 'ACTIVE', source, name: cleanName || existing.name },
      });
      return NextResponse.json(
        { message: 'Welcome back! You have been re-subscribed.' },
        { status: 200 },
      );
    }

    await prisma.subscriber.create({
      data: { email, name: cleanName, source },
    });

    return NextResponse.json(
      { message: 'Successfully subscribed! Check your inbox for updates.' },
      { status: 200 },
    );
  } catch {
    return NextResponse.json(
      { error: 'Subscription failed. Please try again.' },
      { status: 500 },
    );
  }
}
