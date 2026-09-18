// ─── Maintenance Mode State (dependency-free) ───
// Lives in its own module with ZERO imports so the edge/node middleware
// bundle can include it without dragging in Prisma (which cannot be bundled
// into middleware — "CJS module can't be async"). State is kept on globalThis
// so the middleware, route handlers, and the WS server entry all share the
// same instance even when Turbopack instantiates the module per-bundle.

export interface MaintenanceState {
  enabled: boolean;
  message: string;
  estimatedEnd: number | null;
  allowedUsers: string[];
  startTime: number;
  scheduledStart: number | null;
  scheduledEnd: number | null;
}

const DEFAULT_STATE: MaintenanceState = {
  enabled: false,
  message: 'Scheduled maintenance in progress. Please try again later.',
  estimatedEnd: null,
  allowedUsers: [],
  startTime: Date.now(),
  scheduledStart: null,
  scheduledEnd: null,
};

const g = globalThis as any;
if (!g.__tirbeoMaintenance) {
  g.__tirbeoMaintenance = { ...DEFAULT_STATE };
}
const maintenanceState: MaintenanceState = g.__tirbeoMaintenance;

export function getMaintenanceState(): MaintenanceState {
  return { ...maintenanceState };
}

export function setMaintenanceMode(
  enabled: boolean,
  message?: string,
  estimatedEnd?: number,
  allowedUsers?: string[],
  scheduledStart?: number | null,
  scheduledEnd?: number | null,
): MaintenanceState {
  maintenanceState.enabled = enabled;
  if (message !== undefined) maintenanceState.message = message;
  if (estimatedEnd !== undefined) maintenanceState.estimatedEnd = estimatedEnd;
  if (allowedUsers !== undefined) maintenanceState.allowedUsers = allowedUsers;
  if (enabled) maintenanceState.startTime = Date.now();

  if (scheduledStart !== undefined) maintenanceState.scheduledStart = scheduledStart;
  if (scheduledEnd !== undefined) maintenanceState.scheduledEnd = scheduledEnd;

  if (scheduledStart && scheduledStart > Date.now() && !enabled) {
    maintenanceState.enabled = false;
  }

  return { ...maintenanceState };
}

/**
 * Advance any scheduled maintenance windows. Called periodically by the WS
 * server scheduler; safe to call from anywhere. Returns the actions taken so
 * the caller can log/broadcast them.
 */
export function tickMaintenanceSchedule(): {
  autoEnabled: boolean;
  autoDisabled: boolean;
} {
  const now = Date.now();
  let autoEnabled = false;
  let autoDisabled = false;

  if (maintenanceState.scheduledStart && !maintenanceState.enabled && now >= maintenanceState.scheduledStart) {
    maintenanceState.enabled = true;
    maintenanceState.startTime = now;
    autoEnabled = true;
  }

  if (maintenanceState.scheduledEnd && maintenanceState.enabled && now >= maintenanceState.scheduledEnd) {
    maintenanceState.enabled = false;
    maintenanceState.scheduledStart = null;
    maintenanceState.scheduledEnd = null;
    autoDisabled = true;
  }

  return { autoEnabled, autoDisabled };
}
