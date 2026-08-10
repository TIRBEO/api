// Performance logging utility for API endpoints
// Logs timing information for slow requests (>500ms)

const SLOW_THRESHOLD_MS = 500;
const CRITICAL_THRESHOLD_MS = 2000;

export function logPerformance(
  endpoint: string,
  startTime: number,
  metadata?: Record<string, any>
) {
  const duration = performance.now() - startTime;
  const level = duration > CRITICAL_THRESHOLD_MS ? 'CRITICAL' : duration > SLOW_THRESHOLD_MS ? 'SLOW' : 'OK';
  
  if (level !== 'OK') {
    console.warn(
      `[PERF:${level}] ${endpoint} took ${duration.toFixed(0)}ms`,
      metadata ? JSON.stringify(metadata) : ''
    );
  }
  
  return duration;
}

// Decorator-like wrapper for async functions
export async function withPerf<T>(
  endpoint: string,
  fn: () => Promise<T>,
  metadata?: Record<string, any>
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    logPerformance(endpoint, start, metadata);
    return result;
  } catch (error) {
    logPerformance(endpoint, start, { ...metadata, error: true });
    throw error;
  }
}

// Timing helper for parallel operations
export class PerfTimer {
  private marks: Map<string, number> = new Map();
  
  start(name: string) {
    this.marks.set(name, performance.now());
  }
  
  end(name: string): number {
    const start = this.marks.get(name);
    if (!start) return 0;
    const duration = performance.now() - start;
    this.marks.delete(name);
    return duration;
  }
  
  report() {
    const entries = Array.from(this.marks.entries()).map(([name, start]) => ({
      name,
      duration: performance.now() - start,
    }));
    return entries.sort((a, b) => b.duration - a.duration);
  }
}
