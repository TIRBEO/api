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

// ─── Durable persistence (injected; this module must stay import-free) ───
// The edge middleware imports this module synchronously and cannot bundle
// Prisma, so persistence is wired in from the Node side via
// registerMaintenancePersistence(). The in-process object stays the cache; the
// store (AppConfig key 'maintenance') is the source of truth so every instance
// converges and the state survives a restart.
let persistHook: ((state: MaintenanceState) => void) | null = null;
let loadHook: (() => Promise<Partial<MaintenanceState> | null>) | null = null;

export function registerMaintenancePersistence(hooks: {
  save: (state: MaintenanceState) => void;
  load: () => Promise<Partial<MaintenanceState> | null>;
}): void {
  persistHook = hooks.save;
  loadHook = hooks.load;
  // Hydrate on registration so the shared globalThis reflects the durable state
  // before the first request reads it. Fire-and-forget; a failed load keeps the
  // in-process default.
  void hydrateMaintenance().catch(() => {});
}

/** Merge durable state into the in-process cache. Throws only on a load error. */
export async function hydrateMaintenance(): Promise<void> {
  if (!loadHook) return;
  const stored = await loadHook();
  if (!stored) return;
  Object.assign(maintenanceState, stored);
}

function persistSoon(): void {
  try { persistHook?.({ ...maintenanceState }); } catch { /* best-effort */ }
}

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

  persistSoon();
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

  if (autoEnabled || autoDisabled) persistSoon();
  return { autoEnabled, autoDisabled };
}

/**
 * Re-converge from the store, then run the schedule transitions against the
 * fresh state so an instance that missed the set call still enables/disables on
 * time. Used by the periodic scheduler instead of the in-memory-only tick.
 */
export async function syncMaintenanceSchedule(): Promise<{
  autoEnabled: boolean;
  autoDisabled: boolean;
}> {
  await hydrateMaintenance().catch(() => {});
  return tickMaintenanceSchedule();
}
