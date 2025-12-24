/**
 * Simple profiling utility for identifying slow code paths
 * Use this to wrap functions or code blocks to measure execution time
 */

interface ProfileEntry {
  name: string;
  count: number;
  totalTime: number;
  minTime: number;
  maxTime: number;
  avgTime: number;
}

class Profiler {
  private profiles: Map<string, ProfileEntry> = new Map();
  private activeTimers: Map<string, number> = new Map();

  /**
   * Start timing a named operation
   */
  start(name: string): void {
    const startTime = performance.now();
    this.activeTimers.set(name, startTime);
  }

  /**
   * End timing a named operation and record the duration
   */
  end(name: string): number {
    const startTime = this.activeTimers.get(name);
    if (!startTime) {
      console.warn(`[Profiler] No active timer found for: ${name}`);
      return 0;
    }

    const duration = performance.now() - startTime;
    this.activeTimers.delete(name);

    const entry = this.profiles.get(name) || {
      name,
      count: 0,
      totalTime: 0,
      minTime: Infinity,
      maxTime: 0,
      avgTime: 0,
    };

    entry.count++;
    entry.totalTime += duration;
    entry.minTime = Math.min(entry.minTime, duration);
    entry.maxTime = Math.max(entry.maxTime, duration);
    entry.avgTime = entry.totalTime / entry.count;

    this.profiles.set(name, entry);
    return duration;
  }

  /**
   * Time a function execution
   */
  time<T>(name: string, fn: () => T): T {
    this.start(name);
    try {
      return fn();
    } finally {
      this.end(name);
    }
  }

  /**
   * Time an async function execution
   */
  async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.start(name);
    try {
      return await fn();
    } finally {
      this.end(name);
    }
  }

  /**
   * Get statistics for a named operation
   */
  getStats(name: string): ProfileEntry | undefined {
    return this.profiles.get(name);
  }

  /**
   * Get all statistics, sorted by total time
   */
  getAllStats(): ProfileEntry[] {
    return Array.from(this.profiles.values()).sort((a, b) => b.totalTime - a.totalTime);
  }

  /**
   * Print statistics to console
   */
  printStats(limit: number = 20): void {
    const stats = this.getAllStats();
    const topStats = stats.slice(0, limit);

    console.log("\n=== Profiling Statistics ===");
    console.log("Name".padEnd(40), "Count".padStart(10), "Total(ms)".padStart(12), "Avg(ms)".padStart(10), "Min(ms)".padStart(10), "Max(ms)".padStart(10));
    console.log("-".repeat(100));

    for (const stat of topStats) {
      console.log(
        stat.name.padEnd(40),
        stat.count.toString().padStart(10),
        stat.totalTime.toFixed(2).padStart(12),
        stat.avgTime.toFixed(2).padStart(10),
        stat.minTime.toFixed(2).padStart(10),
        stat.maxTime.toFixed(2).padStart(10)
      );
    }

    if (stats.length > limit) {
      console.log(`\n... and ${stats.length - limit} more entries`);
    }

    const totalTime = stats.reduce((sum, s) => sum + s.totalTime, 0);
    console.log(`\nTotal profiled time: ${totalTime.toFixed(2)}ms`);
  }

  /**
   * Reset all statistics
   */
  reset(): void {
    this.profiles.clear();
    this.activeTimers.clear();
  }

  /**
   * Get a summary of the top time consumers
   */
  getTopConsumers(count: number = 10): Array<{ name: string; percentage: number; totalTime: number }> {
    const stats = this.getAllStats();
    const totalTime = stats.reduce((sum, s) => sum + s.totalTime, 0);
    
    return stats.slice(0, count).map(stat => ({
      name: stat.name,
      percentage: totalTime > 0 ? (stat.totalTime / totalTime) * 100 : 0,
      totalTime: stat.totalTime,
    }));
  }
}

// Global profiler instance
export const profiler = new Profiler();

/**
 * Decorator for timing function execution
 * Usage: @timed("function-name")
 */
export function timed(name: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = function (...args: any[]) {
      return profiler.timeAsync(name, () => originalMethod.apply(this, args));
    };

    return descriptor;
  };
}

/**
 * Helper to time a code block
 * Usage: await timeBlock("operation-name", async () => { ... });
 */
export async function timeBlock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return profiler.timeAsync(name, fn);
}

/**
 * Helper to time a synchronous code block
 * Usage: timeBlockSync("operation-name", () => { ... });
 */
export function timeBlockSync<T>(name: string, fn: () => T): T {
  return profiler.time(name, fn);
}

