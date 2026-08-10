import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '../../../../lib/session';
import { setMaintenanceMode, getMaintenanceState } from '../../../../lib/ws/server';
import { sendMaintenanceNotification, sendMaintenanceCompleteNotification } from '../../../../lib/maintenance-notifications';
import { createAuditEvent } from '../../../../lib/audit';

// GET /api/admin/maintenance - Get current maintenance status
export async function GET(request: NextRequest) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;
  
  const state = getMaintenanceState();
  return NextResponse.json({
    enabled: state.enabled,
    message: state.message,
    estimatedEnd: state.estimatedEnd,
    allowedUsers: state.allowedUsers,
    startTime: state.startTime,
    scheduledStart: state.scheduledStart,
    scheduledEnd: state.scheduledEnd,
  });
}

// PUT /api/admin/maintenance - Update maintenance mode or schedule
export async function PUT(request: NextRequest) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;
  
  try {
    const body: any = await request.json();
    const {
      enabled,
      message,
      estimatedEnd,
      allowedUsers,
      notifyUsers = true,
      scheduledStart,
      scheduledEnd,
      cancelSchedule = false,
    } = body;
    
    // Handle schedule cancellation
    if (cancelSchedule) {
      const prevState = getMaintenanceState();
      setMaintenanceMode(
        false,
        undefined,
        undefined,
        undefined,
        null,
        null
      );
      
      // Log audit event
      await createAuditEvent({
        actorId: session.userId,
        action: 'MAINTENANCE_SCHEDULE_CANCELLED',
        targetType: 'maintenance',
        targetId: 'system',
        metadata: {
          previousScheduledStart: prevState.scheduledStart,
          previousScheduledEnd: prevState.scheduledEnd,
          message: prevState.message,
        },
        severity: 'warning',
      });
      
      return NextResponse.json({
        success: true,
        maintenance: getMaintenanceState(),
        message: 'Schedule cancelled',
      });
    }
    
    // Parse scheduled times
    const parsedScheduledStart = scheduledStart ? new Date(scheduledStart).getTime() : undefined;
    const parsedScheduledEnd = scheduledEnd ? new Date(scheduledEnd).getTime() : undefined;
    
    // Determine if this is immediate or scheduled
    const isImmediate = enabled && !parsedScheduledStart;
    const isScheduled = parsedScheduledStart && parsedScheduledStart > Date.now();
    
    const prevState = getMaintenanceState();
    setMaintenanceMode(
      enabled || false,
      message,
      estimatedEnd ? new Date(estimatedEnd).getTime() : undefined,
      allowedUsers,
      parsedScheduledStart,
      parsedScheduledEnd
    );
    
    // Log audit event
    let auditAction = 'MAINTENANCE_MODE_CHANGED';
    let auditSeverity: 'info' | 'warning' | 'error' | 'critical' = 'info';
    
    if (isImmediate && enabled) {
      auditAction = 'MAINTENANCE_MODE_ENABLED';
      auditSeverity = 'warning';
    } else if (isScheduled) {
      auditAction = 'MAINTENANCE_SCHEDULED';
      auditSeverity = 'info';
    } else if (!enabled) {
      auditAction = 'MAINTENANCE_MODE_DISABLED';
      auditSeverity = 'info';
    }
    
    await createAuditEvent({
      actorId: session.userId,
      action: auditAction,
      targetType: 'maintenance',
      targetId: 'system',
      metadata: {
        enabled: enabled || false,
        message,
        estimatedEnd: estimatedEnd ? new Date(estimatedEnd).toISOString() : null,
        scheduledStart: parsedScheduledStart ? new Date(parsedScheduledStart).toISOString() : null,
        scheduledEnd: parsedScheduledEnd ? new Date(parsedScheduledEnd).toISOString() : null,
        allowedUsers,
        previousState: {
          enabled: prevState.enabled,
          scheduledStart: prevState.scheduledStart,
          scheduledEnd: prevState.scheduledEnd,
        },
      },
      severity: auditSeverity,
    });
    
    // Send notifications
    let notificationResult = null;
    if (notifyUsers) {
      if (isImmediate && enabled) {
        // Immediate maintenance notification
        const startTime = new Date();
        const endTime = estimatedEnd ? new Date(estimatedEnd) : null;
        const durationMs = endTime ? endTime.getTime() - startTime.getTime() : 0;
        const durationHours = Math.round(durationMs / (1000 * 60 * 60));
        
        notificationResult = await sendMaintenanceNotification({
          title: 'Scheduled Maintenance',
          message: message || 'We are performing scheduled maintenance.',
          startTime,
          estimatedEnd: endTime,
          duration: durationHours > 0 ? `${durationHours} hours` : 'Under 1 hour',
          notifyAll: !allowedUsers || allowedUsers.length === 0,
          userIds: allowedUsers,
        });
      } else if (isScheduled) {
        // Scheduled maintenance notification
        const startTime = new Date(parsedScheduledStart!);
        const endTime = parsedScheduledEnd ? new Date(parsedScheduledEnd) : null;
        const durationMs = endTime ? endTime.getTime() - startTime.getTime() : 0;
        const durationHours = Math.round(durationMs / (1000 * 60 * 60));
        
        notificationResult = await sendMaintenanceNotification({
          title: 'Upcoming Scheduled Maintenance',
          message: message || `Maintenance scheduled for ${startTime.toLocaleString()}`,
          startTime,
          estimatedEnd: endTime,
          duration: durationHours > 0 ? `${durationHours} hours` : 'Under 1 hour',
          notifyAll: !allowedUsers || allowedUsers.length === 0,
          userIds: allowedUsers,
        });
      }
    }
    
    return NextResponse.json({
      success: true,
      maintenance: getMaintenanceState(),
      notifications: notificationResult,
      isScheduled,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }
}

// DELETE /api/admin/maintenance - Disable maintenance mode
export async function DELETE(request: NextRequest) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;
  
  const state = getMaintenanceState();
  const startTime = state.startTime ? new Date(state.startTime) : new Date();
  const durationMs = Date.now() - startTime.getTime();
  const durationMinutes = Math.round(durationMs / (1000 * 60));
  
  setMaintenanceMode(false);
  
  // Log audit event
  await createAuditEvent({
    actorId: session.userId,
    action: 'MAINTENANCE_MODE_DISABLED',
    targetType: 'maintenance',
    targetId: 'system',
    metadata: {
      duration: durationMinutes,
      durationFormatted: durationMinutes > 60 
        ? `${Math.round(durationMinutes / 60)}h ${durationMinutes % 60}m` 
        : `${durationMinutes} minutes`,
      startTime: startTime.toISOString(),
      endTime: new Date().toISOString(),
      message: state.message,
    },
    severity: 'info',
  });
  
  // Send completion notification
  let notificationResult = null;
  try {
    notificationResult = await sendMaintenanceCompleteNotification({
      title: 'Maintenance Complete',
      completionMessage: 'The scheduled maintenance has been completed successfully.',
      completedAt: new Date(),
      duration: durationMinutes > 60 ? `${Math.round(durationMinutes / 60)}h ${durationMinutes % 60}m` : `${durationMinutes} minutes`,
    });
  } catch (err) {
    console.error('[MAINTENANCE] Failed to send completion notifications:', err);
  }
  
  return NextResponse.json({
    success: true,
    maintenance: getMaintenanceState(),
    notifications: notificationResult,
  });
}
