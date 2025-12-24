/**
 * Galactic Leaderboard System
 * Tracks top traders, best systems, and popular trade routes
 */

import { ShipId, SystemId } from "./types";

export interface TraderStats {
  shipId: ShipId;
  name: string;
  currentCredits: number;
  peakCredits: number;
  totalTicks: number;
  totalTrades: number;
  successfulTrades: number;
  totalProfit: number;
  totalVolume: number; // Total credits traded
  systemsVisited: Set<SystemId>;
  lastUpdated: number;
}

export interface SystemStats {
  systemId: SystemId;
  name: string;
  totalTradeVolume: number; // Total credits traded
  totalTrades: number;
  uniqueTraders: Set<ShipId>;
  totalProfit: number; // Net profit for all traders trading here
  averagePrice: Record<string, number>; // Average price per good
  lastUpdated: number;
}

export interface TradeRoute {
  fromSystem: SystemId;
  toSystem: SystemId;
  tradeCount: number;
  totalVolume: number;
  totalProfit: number;
  uniqueTraders: Set<ShipId>;
  lastUsed: number;
}

export interface LeaderboardData {
  traders: {
    byCredits: Array<{ shipId: ShipId; name: string; credits: number }>;
    byTicks: Array<{ shipId: ShipId; name: string; ticks: number }>;
    byTrades: Array<{ shipId: ShipId; name: string; trades: number }>;
    byProfit: Array<{ shipId: ShipId; name: string; profit: number }>;
    byVolume: Array<{ shipId: ShipId; name: string; volume: number }>;
  };
  systems: {
    byTradeVolume: Array<{ systemId: SystemId; name: string; volume: number }>;
    byTrades: Array<{ systemId: SystemId; name: string; trades: number }>;
    byUniqueTraders: Array<{ systemId: SystemId; name: string; traders: number }>;
    byProfit: Array<{ systemId: SystemId; name: string; profit: number }>;
  };
  routes: Array<{
    fromSystem: SystemId;
    toSystem: SystemId;
    tradeCount: number;
    volume: number;
    profit: number;
    traders: number;
  }>;
}

// In-memory tracking
const traderStats = new Map<ShipId, TraderStats>();
const systemStats = new Map<SystemId, SystemStats>();
const tradeRoutes = new Map<string, TradeRoute>(); // Key: "fromSystem-toSystem"

const MAX_ENTRIES = 10000; // Limit tracking to prevent memory issues

/**
 * Get or create trader stats
 */
function getTraderStats(shipId: ShipId, name: string): TraderStats {
  if (!traderStats.has(shipId)) {
    traderStats.set(shipId, {
      shipId,
      name,
      currentCredits: 0,
      peakCredits: 0,
      totalTicks: 0,
      totalTrades: 0,
      successfulTrades: 0,
      totalProfit: 0,
      totalVolume: 0,
      systemsVisited: new Set(),
      lastUpdated: Date.now(),
    });
    
    // Trim if too large
    if (traderStats.size > MAX_ENTRIES) {
      // Remove oldest entries (by lastUpdated)
      const sorted = Array.from(traderStats.entries())
        .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
      for (let i = 0; i < sorted.length - MAX_ENTRIES + 100; i++) {
        traderStats.delete(sorted[i][0]);
      }
    }
  }
  return traderStats.get(shipId)!;
}

/**
 * Get or create system stats
 */
function getSystemStats(systemId: SystemId, name: string): SystemStats {
  if (!systemStats.has(systemId)) {
    systemStats.set(systemId, {
      systemId,
      name,
      totalTradeVolume: 0,
      totalTrades: 0,
      uniqueTraders: new Set(),
      totalProfit: 0,
      averagePrice: {},
      lastUpdated: Date.now(),
    });
    
    // Trim if too large
    if (systemStats.size > MAX_ENTRIES) {
      const sorted = Array.from(systemStats.entries())
        .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
      for (let i = 0; i < sorted.length - MAX_ENTRIES + 100; i++) {
        systemStats.delete(sorted[i][0]);
      }
    }
  }
  return systemStats.get(systemId)!;
}

/**
 * Get or create trade route
 */
function getTradeRoute(fromSystem: SystemId, toSystem: SystemId): TradeRoute {
  const key = `${fromSystem}-${toSystem}`;
  if (!tradeRoutes.has(key)) {
    tradeRoutes.set(key, {
      fromSystem,
      toSystem,
      tradeCount: 0,
      totalVolume: 0,
      totalProfit: 0,
      uniqueTraders: new Set(),
      lastUsed: Date.now(),
    });
    
    // Trim if too large
    if (tradeRoutes.size > MAX_ENTRIES) {
      const sorted = Array.from(tradeRoutes.entries())
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (let i = 0; i < sorted.length - MAX_ENTRIES + 100; i++) {
        tradeRoutes.delete(sorted[i][0]);
      }
    }
  }
  return tradeRoutes.get(key)!;
}

/**
 * Record a ship tick
 */
export function recordTick(shipId: ShipId, name: string): void {
  const stats = getTraderStats(shipId, name);
  stats.totalTicks++;
  stats.lastUpdated = Date.now();
}

/**
 * Record travel between systems (for route tracking)
 */
export function recordTravel(
  shipId: ShipId,
  fromSystem: SystemId,
  toSystem: SystemId
): void {
  if (fromSystem === toSystem) return; // Don't track same-system travel
  
  const route = getTradeRoute(fromSystem, toSystem);
  route.tradeCount++; // Count as a route usage
  route.uniqueTraders.add(shipId);
  route.lastUsed = Date.now();
}

/**
 * Record a trade
 */
export function recordTrade(
  shipId: ShipId,
  shipName: string,
  systemId: SystemId,
  systemName: string,
  goodId: string,
  quantity: number,
  price: number,
  type: "buy" | "sell",
  profit?: number
): void {
  const trader = getTraderStats(shipId, shipName);
  const system = getSystemStats(systemId, systemName);
  
  const tradeValue = quantity * price;
  
  // Update trader stats
  trader.totalTrades++;
  trader.successfulTrades++;
  trader.totalVolume += tradeValue;
  trader.systemsVisited.add(systemId);
  if (profit !== undefined) {
    trader.totalProfit += profit;
  }
  trader.lastUpdated = Date.now();
  
  // Update system stats
  system.totalTrades++;
  system.totalTradeVolume += tradeValue;
  system.uniqueTraders.add(shipId);
  if (profit !== undefined) {
    system.totalProfit += profit;
  }
  
  // Update average price for this good
  if (!system.averagePrice[goodId]) {
    system.averagePrice[goodId] = price;
  } else {
    // Weighted average
    const currentAvg = system.averagePrice[goodId];
    const totalTrades = system.totalTrades;
    system.averagePrice[goodId] = (currentAvg * (totalTrades - 1) + price) / totalTrades;
  }
  system.lastUpdated = Date.now();
  
}

/**
 * Record a failed trade
 */
export function recordFailedTrade(
  shipId: ShipId,
  shipName: string,
  systemId: SystemId,
  systemName: string
): void {
  const trader = getTraderStats(shipId, shipName);
  const system = getSystemStats(systemId, systemName);
  
  trader.totalTrades++;
  trader.lastUpdated = Date.now();
  
  system.totalTrades++;
  system.lastUpdated = Date.now();
}

/**
 * Update trader credits (for leaderboard)
 */
export function updateTraderCredits(shipId: ShipId, name: string, credits: number): void {
  const stats = getTraderStats(shipId, name);
  stats.currentCredits = credits;
  if (credits > stats.peakCredits) {
    stats.peakCredits = credits;
  }
  stats.lastUpdated = Date.now();
}

/**
 * Get leaderboard data
 */
export function getLeaderboard(limit: number = 100): LeaderboardData {
  const traders = Array.from(traderStats.values());
  const systems = Array.from(systemStats.values());
  const routes = Array.from(tradeRoutes.values());
  
  return {
    traders: {
      byCredits: traders
        .sort((a, b) => b.currentCredits - a.currentCredits)
        .slice(0, limit)
        .map(t => ({ shipId: t.shipId, name: t.name, credits: t.currentCredits })),
      byTicks: traders
        .sort((a, b) => b.totalTicks - a.totalTicks)
        .slice(0, limit)
        .map(t => ({ shipId: t.shipId, name: t.name, ticks: t.totalTicks })),
      byTrades: traders
        .sort((a, b) => b.totalTrades - a.totalTrades)
        .slice(0, limit)
        .map(t => ({ shipId: t.shipId, name: t.name, trades: t.totalTrades })),
      byProfit: traders
        .sort((a, b) => b.totalProfit - a.totalProfit)
        .slice(0, limit)
        .map(t => ({ shipId: t.shipId, name: t.name, profit: t.totalProfit })),
      byVolume: traders
        .sort((a, b) => b.totalVolume - a.totalVolume)
        .slice(0, limit)
        .map(t => ({ shipId: t.shipId, name: t.name, volume: t.totalVolume })),
    },
    systems: {
      byTradeVolume: systems
        .sort((a, b) => b.totalTradeVolume - a.totalTradeVolume)
        .slice(0, limit)
        .map(s => ({ systemId: s.systemId, name: s.name, volume: s.totalTradeVolume })),
      byTrades: systems
        .sort((a, b) => b.totalTrades - a.totalTrades)
        .slice(0, limit)
        .map(s => ({ systemId: s.systemId, name: s.name, trades: s.totalTrades })),
      byUniqueTraders: systems
        .sort((a, b) => b.uniqueTraders.size - a.uniqueTraders.size)
        .slice(0, limit)
        .map(s => ({ systemId: s.systemId, name: s.name, traders: s.uniqueTraders.size })),
      byProfit: systems
        .sort((a, b) => b.totalProfit - a.totalProfit)
        .slice(0, limit)
        .map(s => ({ systemId: s.systemId, name: s.name, profit: s.totalProfit })),
    },
    routes: routes
      .sort((a, b) => b.tradeCount - a.tradeCount)
      .slice(0, limit)
      .map(r => ({
        fromSystem: r.fromSystem,
        toSystem: r.toSystem,
        tradeCount: r.tradeCount,
        volume: r.totalVolume,
        profit: r.totalProfit,
        traders: r.uniqueTraders.size,
      })),
  };
}

/**
 * Get detailed stats for a specific trader
 */
export function getTraderDetails(shipId: ShipId): TraderStats | null {
  return traderStats.get(shipId) || null;
}

/**
 * Get detailed stats for a specific system
 */
export function getSystemDetails(systemId: SystemId): SystemStats | null {
  return systemStats.get(systemId) || null;
}

/**
 * Clear all leaderboard data
 */
export function clearLeaderboard(): void {
  traderStats.clear();
  systemStats.clear();
  tradeRoutes.clear();
}
