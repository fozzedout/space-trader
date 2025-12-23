/**
 * Galactic Health Tracking
 * Tracks ship spawns, removals, trade quality, and overall galactic health metrics
 */

export interface ShipSpawnEvent {
  timestamp: number;
  shipId: string;
  systemId: number;
  reason: "initialization" | "respawn";
}

export interface ShipRemovalEvent {
  timestamp: number;
  shipId: string;
  systemId: number | null;
  reason: string;
  credits: number;
}

export interface TradeAnalysis {
  totalTrades: number;
  successfulBuys: number;
  successfulSells: number;
  failedTrades: number;
  profitableTrades: number;
  unprofitableTrades: number;
  totalProfit: number;
  totalLoss: number;
  tradesWithMissingProfit?: number; // Diagnostic: trades where profit couldn't be calculated
}

export interface GalaxyHealthMetrics {
  timestamp: number;
  serverStartTime: number;
  durationMs: number;
  population: {
    current: number;
    target: number;
    active: number;
    inactive: number;
  };
  ships: {
    totalSpawns: number;
    totalRemovals: number;
    spawnsSinceStart: number;
    removalsSinceStart: number;
    netGrowth: number;
    removalReasons: Record<string, number>;
  };
  trades: TradeAnalysis;
  health: {
    status: "healthy" | "warning" | "critical";
    issues: string[];
  };
  logging?: {
    paused: boolean;
    needsCodeChange: boolean;
    message?: string;
  };
}

export interface TradeEvent {
  timestamp: number;
  type: "buy" | "sell";
  profit?: number;
}

// In-memory tracking (max 10000 events each)
const MAX_EVENTS = 10000;
const spawnEvents: ShipSpawnEvent[] = [];
const removalEvents: ShipRemovalEvent[] = [];
const tradeEvents: TradeEvent[] = [];

/**
 * Record a ship spawn event
 */
export function recordSpawn(shipId: string, systemId: number, reason: "initialization" | "respawn"): void {
  const event: ShipSpawnEvent = {
    timestamp: Date.now(),
    shipId,
    systemId,
    reason,
  };
  
  spawnEvents.push(event);
  
  // Trim if too large
  if (spawnEvents.length > MAX_EVENTS) {
    spawnEvents.shift();
  }
}

/**
 * Record a ship removal event
 */
export function recordRemoval(shipId: string, systemId: number | null, reason: string, credits: number): void {
  const event: ShipRemovalEvent = {
    timestamp: Date.now(),
    shipId,
    systemId,
    reason,
    credits,
  };
  
  removalEvents.push(event);
  
  // Trim if too large
  if (removalEvents.length > MAX_EVENTS) {
    removalEvents.shift();
  }
}

/**
 * Record a trade event directly (more reliable than parsing logs)
 */
export function recordTradeEvent(type: "buy" | "sell", profit?: number): void {
  const event: TradeEvent = {
    timestamp: Date.now(),
    type,
    profit,
  };
  
  tradeEvents.push(event);
  
  // Trim if too large
  if (tradeEvents.length > MAX_EVENTS) {
    tradeEvents.shift();
  }
}

/**
 * Analyze trades from direct tracking (more reliable than parsing logs)
 */
export function analyzeTrades(serverStartTime: number, tradeLogs?: Array<{ timestamp: number; message: string }>): TradeAnalysis {
  const now = Date.now();
  
  // Use direct trade events if available, otherwise fall back to log parsing
  const recentTrades = tradeEvents.filter(e => e.timestamp >= serverStartTime);
  
  let successfulBuys = 0;
  let successfulSells = 0;
  let failedTrades = 0;
  let profitableTrades = 0;
  let unprofitableTrades = 0;
  let totalProfit = 0;
  let totalLoss = 0;
  let tradesWithMissingProfit = 0;
  
  // Count from direct trade events
  for (const trade of recentTrades) {
    if (trade.type === "buy") {
      successfulBuys++;
    } else if (trade.type === "sell") {
      successfulSells++;
      
      // Track profit from sell events
      if (trade.profit !== undefined) {
        if (trade.profit > 0) {
          profitableTrades++;
          totalProfit += trade.profit;
        } else if (trade.profit < 0) {
          unprofitableTrades++;
          totalLoss += Math.abs(trade.profit);
        }
        // Note: profit === 0 is not counted as profitable or unprofitable
      } else {
        tradesWithMissingProfit++;
      }
    }
  }
  
  // Fallback to log parsing if no direct events (for backwards compatibility)
  if (recentTrades.length === 0 && tradeLogs) {
    const recentLogs = tradeLogs.filter(log => log.timestamp >= serverStartTime);
    
    for (const log of recentLogs) {
      const message = log.message;
      const lower = message.toLowerCase();

      // Ignore decision/debug lines that aren't actual trade outcomes.
      if (lower.startsWith("[decision ")) {
        continue;
      }

      // Check for successful buys (trade logs only)
      if (lower.includes(" bought ") && lower.includes(" for ") && !lower.includes("trade failed")) {
        successfulBuys++;
        continue;
      }

      // Check for successful sells (trade logs only)
      if (lower.includes(" sold ") && lower.includes(" for ") && !lower.includes("trade failed")) {
        successfulSells++;

        // Try to extract profit information from log message
        // Format: "(profit: 10 cr, 5.2% margin)" or "profit: 10" or "profit 10"
        // Try multiple patterns to catch different log formats
        let profitMatch = message.match(/\(profit:\s*(-?[\d.]+)\s*cr/i);
        if (!profitMatch) {
          profitMatch = message.match(/profit[:\s]+(-?[\d.]+)/i);
        }
        if (profitMatch) {
          const profit = parseFloat(profitMatch[1]);
          if (!isNaN(profit)) {
            if (profit > 0) {
              profitableTrades++;
              totalProfit += profit;
            } else if (profit < 0) {
              unprofitableTrades++;
              totalLoss += Math.abs(profit);
            }
            // Note: profit === 0 is not counted as profitable or unprofitable
          }
        } else {
          // No profit found in log - this indicates purchasePrice was missing
          // This is a diagnostic issue but not counted as profitable/unprofitable
          tradesWithMissingProfit++;
        }
        continue;
      }

      // Check for failed trades (only explicit trade failures)
      if (lower.includes(" trade failed") || lower.includes(" trade http error")) {
        failedTrades++;
      }
    }
  }
  
  return {
    totalTrades: successfulBuys + successfulSells + failedTrades,
    successfulBuys,
    successfulSells,
    failedTrades,
    profitableTrades,
    unprofitableTrades,
    totalProfit,
    totalLoss,
    tradesWithMissingProfit: tradesWithMissingProfit > 0 ? tradesWithMissingProfit : undefined,
  };
}

/**
 * Get current galactic health metrics
 */
export function getGalaxyHealth(
  currentPopulation: number,
  targetPopulation: number,
  activeShips: number,
  tradeLogs: Array<{ timestamp: number; message: string }>,
  serverStartTime: number
): GalaxyHealthMetrics {
  const now = Date.now();
  const durationMs = now - serverStartTime;
  
  // Analyze spawns and removals since server start
  const recentSpawns = spawnEvents.filter(e => e.timestamp >= serverStartTime);
  const recentRemovals = removalEvents.filter(e => e.timestamp >= serverStartTime);
  
  // Count removal reasons
  const removalReasons: Record<string, number> = {};
  for (const removal of removalEvents) {
    removalReasons[removal.reason] = (removalReasons[removal.reason] || 0) + 1;
  }
  
  // Analyze trades
  const tradeAnalysis = analyzeTrades(serverStartTime, tradeLogs);
  
  // Determine health status
  const issues: string[] = [];
  let status: "healthy" | "warning" | "critical" = "healthy";
  
  // Check population health
  const populationRatio = currentPopulation / targetPopulation;
  if (populationRatio < 0.7) {
    status = "critical";
    issues.push(`Population is ${((1 - populationRatio) * 100).toFixed(1)}% below target`);
  } else if (populationRatio < 0.9) {
    if (status === "healthy") status = "warning";
    issues.push(`Population is ${((1 - populationRatio) * 100).toFixed(1)}% below target`);
  }
  
  // Check removal rate
  const removalRate = recentRemovals.length / Math.max(recentSpawns.length, 1);
  if (removalRate > 2.0) {
    status = "critical";
    issues.push(`Removal rate is ${removalRate.toFixed(1)}x spawn rate (ships dying too fast)`);
  } else if (removalRate > 1.5) {
    if (status === "healthy") status = "warning";
    issues.push(`Removal rate is ${removalRate.toFixed(1)}x spawn rate`);
  }
  
  // Check trade health
  if (tradeAnalysis.totalTrades > 0) {
    const failureRate = tradeAnalysis.failedTrades / tradeAnalysis.totalTrades;
    if (failureRate > 0.5) {
      status = "critical";
      issues.push(`${(failureRate * 100).toFixed(1)}% of trades are failing`);
    } else if (failureRate > 0.3) {
      if (status === "healthy") status = "warning";
      issues.push(`${(failureRate * 100).toFixed(1)}% of trades are failing`);
    }
    
    // Check profitability
    if (tradeAnalysis.unprofitableTrades > tradeAnalysis.profitableTrades * 2) {
      if (status === "healthy") status = "warning";
      issues.push(`More unprofitable trades than profitable ones`);
    }
  }
  
  // Check if net growth is negative (scale thresholds by duration)
  const netGrowth = recentSpawns.length - recentRemovals.length;
  const hoursSinceStart = durationMs / (60 * 60 * 1000);
  const scaledThreshold = Math.max(1, Math.floor(hoursSinceStart * 10)); // Scale with time
  
  if (netGrowth < -scaledThreshold) {
    status = "critical";
    const durationStr = formatDuration(durationMs);
    issues.push(`Net ship growth is negative: ${netGrowth} ships lost since server start (${durationStr})`);
  } else if (netGrowth < -Math.floor(scaledThreshold / 2)) {
    if (status === "healthy") status = "warning";
    const durationStr = formatDuration(durationMs);
    issues.push(`Net ship growth is negative: ${netGrowth} ships lost since server start (${durationStr})`);
  }
  
  return {
    timestamp: now,
    serverStartTime,
    durationMs,
    population: {
      current: currentPopulation,
      target: targetPopulation,
      active: activeShips,
      inactive: currentPopulation - activeShips,
    },
    ships: {
      totalSpawns: spawnEvents.length,
      totalRemovals: removalEvents.length,
      spawnsSinceStart: recentSpawns.length,
      removalsSinceStart: recentRemovals.length,
      netGrowth,
      removalReasons,
    },
    trades: tradeAnalysis,
    health: {
      status,
      issues,
    },
  };
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Clear all health tracking data
 */
export function clearHealthData(): void {
  spawnEvents.length = 0;
  removalEvents.length = 0;
  tradeEvents.length = 0;
}
