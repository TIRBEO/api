// Log model removed - logging is done via AuditEvent

export async function logRequest(info: {
  ip: string | undefined;
  method: string;
  path: string;
  userId?: string;
  status?: number;
}) {
  // No-op - Log model removed
}

export async function getLogs(limit = 100) {
  return [];
}
