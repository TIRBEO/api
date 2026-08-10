import { prisma } from './db/prisma';
import { sendTemplateEmail } from './email';

interface MaintenanceNotificationOptions {
  title: string;
  message: string;
  startTime: Date;
  estimatedEnd?: Date | null;
  duration: string;
  notifyAll?: boolean;
  userIds?: string[];
}

interface MaintenanceCompleteOptions {
  title: string;
  completionMessage: string;
  completedAt: Date;
  duration: string;
  notifyAll?: boolean;
  userIds?: string[];
}

// Send maintenance notification to users
export async function sendMaintenanceNotification(options: MaintenanceNotificationOptions): Promise<{ sent: number; failed: number }> {
  const { title, message, startTime, estimatedEnd, duration, notifyAll = true, userIds } = options;
  
  let users: { id: string; email: string; name: string | null }[];
  
  if (userIds && userIds.length > 0) {
    // Send to specific users
    users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, name: true },
    });
  } else if (notifyAll) {
    // Send to all users
    users = await prisma.user.findMany({
      select: { id: true, email: true, name: true },
      take: 10000, // Safety limit
    });
  } else {
    return { sent: 0, failed: 0 };
  }
  
  let sent = 0;
  let failed = 0;
  
  const variables: Record<string, string> = {
    maintenanceTitle: title,
    maintenanceMessage: message,
    startTime: startTime.toLocaleString(),
    duration,
    estimatedEnd: estimatedEnd ? estimatedEnd.toLocaleString() : '',
  };
  
  // Send emails in batches to avoid rate limits
  const batchSize = 50;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    
    const results = await Promise.allSettled(
      batch.map(user => 
        sendTemplateEmail(
          user.email,
          'maintenance_notification',
          {
            ...variables,
            name: user.name || 'User',
          }
        )
      )
    );
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        sent++;
      } else {
        failed++;
      }
    }
    
    // Small delay between batches
    if (i + batchSize < users.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  console.log(`[MAINTENANCE] Sent ${sent} maintenance notifications, ${failed} failed`);
  return { sent, failed };
}

// Send maintenance complete notification
export async function sendMaintenanceCompleteNotification(options: MaintenanceCompleteOptions): Promise<{ sent: number; failed: number }> {
  const { title, completionMessage, completedAt, duration, notifyAll = true, userIds } = options;
  
  let users: { id: string; email: string; name: string | null }[];
  
  if (userIds && userIds.length > 0) {
    users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, name: true },
    });
  } else if (notifyAll) {
    users = await prisma.user.findMany({
      select: { id: true, email: true, name: true },
      take: 10000,
    });
  } else {
    return { sent: 0, failed: 0 };
  }
  
  let sent = 0;
  let failed = 0;
  
  const variables: Record<string, string> = {
    maintenanceTitle: title,
    completionMessage,
    completedAt: completedAt.toLocaleString(),
    duration,
    dashboardUrl: process.env.NEXT_PUBLIC_DASHBOARD_URL || 'https://dashboard.tirbeo.app',
  };
  
  const batchSize = 50;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    
    const results = await Promise.allSettled(
      batch.map(user => 
        sendTemplateEmail(
          user.email,
          'maintenance_complete',
          {
            ...variables,
            name: user.name || 'User',
          }
        )
      )
    );
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        sent++;
      } else {
        failed++;
      }
    }
    
    if (i + batchSize < users.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  console.log(`[MAINTENANCE] Sent ${sent} maintenance complete notifications, ${failed} failed`);
  return { sent, failed };
}
