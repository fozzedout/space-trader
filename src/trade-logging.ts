/**
 * Trade logging control
 * Allows toggling trade logs on/off or filtering by specific ship
 * Stores logs in memory (max 200 lines) and provides API access
 */

export type TradeLoggingMode = "all" | "none" | string; // "all", "none", or specific ship ID like "npc-123"

export interface TradeLogEntry {
  timestamp: number;
  message: string;
}

let loggingMode: TradeLoggingMode = "none";

// Track log times for monitoring (no rate limiting, just for metrics)
const lastLogTime = new Map<string, number>();
const logCounts = new Map<string, number>(); // Track how many logs per ship
const rateLimitWarnings = new Map<string, number>(); // Track warnings for ships that would have been rate limited

// In-memory log buffer (max entries tuned to cover ~last hour during debug)
// Using a simple array - Node.js is single-threaded so no need for complex locking
const MAX_LOG_ENTRIES = 50000;
const logBuffer: TradeLogEntry[] = [];

export function setTradeLoggingMode(mode: TradeLoggingMode): void {
  try {
    loggingMode = mode;
    // Clear tracking when mode changes
    lastLogTime.clear();
    logCounts.clear();
    rateLimitWarnings.clear();
    // Optionally clear logs when mode changes (comment out to keep logs)
    // logBuffer.length = 0;
  } catch (error) {
    console.error("Error in setTradeLoggingMode:", error);
    throw error;
  }
}

export function getTradeLoggingMode(): TradeLoggingMode {
  return loggingMode;
}

export function shouldLogTrade(shipId: string): boolean {
  if (!shipId || typeof shipId !== "string") return false;
  if (loggingMode === "none") return false;
  if (loggingMode === "all") return true;
  return loggingMode === shipId;
}

/**
 * Check if we should log a trade (no rate limiting - all trades are logged)
 * Logs warnings if a ship is logging very frequently (potential performance issue)
 */
export function shouldLogTradeNow(shipId: string): boolean {
  // Fast path: if logging is disabled, return immediately (most common case)
  if (loggingMode === "none") return false;
  
  // Validate input
  if (!shipId || typeof shipId !== "string") return false;
  
  // Quick check if this ship should log at all
  if (loggingMode !== "all" && loggingMode !== shipId) return false;
  
  // Track timing for monitoring (no rate limiting)
  try {
    const now = Date.now();
    const lastTime = lastLogTime.get(shipId) || 0;
    const timeSinceLastLog = now - lastTime;
    
    // Log warning if ship is logging very frequently (potential performance issue)
    // Ships can legitimately make sell+buy combos in the same decision cycle (0ms apart),
    // so we use a more reasonable threshold to catch actual performance issues
    if (lastTime > 0 && timeSinceLastLog < 50) {
      // Less than 50ms between logs - this is fast, might indicate a problem
      // But allow for legitimate sell+buy combos which can be 0ms apart
      const warningCount = (rateLimitWarnings.get(shipId) || 0) + 1;
      rateLimitWarnings.set(shipId, warningCount);
      
      // Only log warning every 100 occurrences to avoid spam
      // And only if it's consistently happening (not just occasional sell+buy combos)
      if (warningCount % 100 === 0 && warningCount > 500) {
        // Only warn if we've seen 500+ rapid logs, indicating a real pattern
        console.warn(
          `[Trade Logging] Performance warning: Ship ${shipId} is logging very frequently ` +
          `(${timeSinceLastLog}ms between logs, ${warningCount} total warnings). ` +
          `This may indicate a performance issue that needs investigation.`
        );
      }
    }
    
    // Update tracking
    lastLogTime.set(shipId, now);
    logCounts.set(shipId, (logCounts.get(shipId) || 0) + 1);
    
    // Always allow logging (no rate limiting)
    return true;
  } catch (error) {
    // If anything goes wrong, log the error but still allow logging
    console.error(`[Trade Logging] Error in shouldLogTradeNow for ${shipId}:`, error);
    return true; // Allow logging even on error
  }
}

/**
 * Log trade message to memory buffer
 * Simple, fast operation - no locking needed in single-threaded Node.js
 */
export function logTrade(message: string): void {
  if (!message || typeof message !== "string") {
    console.warn(`[Trade Logging] Invalid message:`, message);
    return;
  }
  
  try {
    const entry: TradeLogEntry = {
      timestamp: Date.now(),
      message: String(message),
    };
    
    // Add to buffer
    logBuffer.push(entry);
    
    // Maintain max size - only remove if we exceed the limit
    // Use simple length check and slice for better performance
    if (logBuffer.length > MAX_LOG_ENTRIES) {
      const removeCount = logBuffer.length - MAX_LOG_ENTRIES;
      logBuffer.splice(0, removeCount);
    }
  } catch (error) {
    console.error(`[Trade Logging] Error in logTrade:`, error);
  }
}

/**
 * Get all stored trade logs
 * Returns a copy of the buffer
 */
export function getTradeLogs(): TradeLogEntry[] {
  // Simple copy - Node.js is single-threaded so this is safe
  // Return a shallow copy to prevent external modification
  try {
    return logBuffer.slice(); // slice() creates a new array
  } catch (error) {
    // If anything goes wrong, return empty array
    return [];
  }
}

/**
 * Clear all stored trade logs
 */
export function clearTradeLogs(): void {
  logBuffer.length = 0;
}

/**
 * Check if we should log decisions for a specific ship
 * No rate limiting - decisions should always be logged when enabled
 */
export function shouldLogDecisions(shipId: string): boolean {
  if (!shipId || typeof shipId !== "string") return false;
  if (loggingMode === "none") return false;
  if (loggingMode === "all") return true;
  return loggingMode === shipId;
}

/**
 * Log a decision message (always logged if decision logging is enabled for this ship)
 */
export function logDecision(shipId: string, message: string): void {
  if (!shouldLogDecisions(shipId)) return;
  logTrade(`[DECISION ${shipId}] ${message}`);
}

/**
 * Get rate limiting statistics (for monitoring/debugging)
 */
export function getRateLimitStats(): {
  totalLogs: number;
  shipsWithWarnings: number;
  topWarnedShips: Array<{ shipId: string; warnings: number; logCount: number }>;
} {
  const shipsWithWarnings = Array.from(rateLimitWarnings.entries())
    .filter(([_, count]) => count > 0)
    .map(([shipId, warnings]) => ({
      shipId,
      warnings,
      logCount: logCounts.get(shipId) || 0,
    }))
    .sort((a, b) => b.warnings - a.warnings)
    .slice(0, 10); // Top 10
    
  return {
    totalLogs: logBuffer.length,
    shipsWithWarnings: rateLimitWarnings.size,
    topWarnedShips: shipsWithWarnings,
  };
}

/**
 * @deprecated This function is no longer used - NPCs are always ticked regardless of logging mode.
 * Logging mode only controls whether trade logs are written, not whether the simulation runs.
 */
export function shouldTickTraders(): boolean {
  // Always return true - NPCs should always be ticked
  // Logging mode only affects whether logs are written, not whether simulation runs
  return true;
}
