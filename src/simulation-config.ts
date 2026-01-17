export const DEFAULT_TICK_INTERVAL_MS = 30000;

export function getTickIntervalMs(): number {
  if (typeof process !== "undefined" && process.env?.TICK_INTERVAL_MS) {
    const parsed = parseInt(process.env.TICK_INTERVAL_MS, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return DEFAULT_TICK_INTERVAL_MS;
}
