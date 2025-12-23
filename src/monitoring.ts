/**
 * Economic Monitoring and Analysis System
 * Collects data at multiple levels (ship, system, galaxy) over time
 * Analyzes trends and provides recommendations for balance improvements
 */

export interface ShipMetrics {
  shipId: string;
  timestamp: number;
  credits: number;
  cargoValue: number;
  totalWealth: number;
  system: number | null;
  phase: string;
}

export interface SystemMetrics {
  systemId: number;
  timestamp: number;
  goods: Record<string, {
    price: number;
    inventory: number;
    priceChange: number; // % change from previous measurement
    basePrice: number;
  }>;
  shipsAtStation: number;
  totalTradeVolume: number;
}

export interface GalaxyMetrics {
  timestamp: number;
  totalShips: number;
  shipsAtStation: number;
  shipsTraveling: number;
  shipsResting: number;
  averageWealth: number;
  medianWealth: number;
  maxWealth: number;
  minWealth: number;
  wealthDistribution: {
    under1k: number;
    under10k: number;
    under100k: number;
    under1m: number;
    over1m: number;
  };
  priceVolatility: Record<string, {
    goodId: string;
    averageVolatility: number; // Average % price change across all systems
    maxPrice: number;
    minPrice: number;
  }>;
}

interface MonitoringData {
  shipMetrics: ShipMetrics[];
  systemMetrics: SystemMetrics[];
  galaxyMetrics: GalaxyMetrics[];
  startTime: number;
  lastCollectionTime: number;
}

let monitoringData: MonitoringData = {
  shipMetrics: [],
  systemMetrics: [],
  galaxyMetrics: [],
  startTime: Date.now(),
  lastCollectionTime: 0,
};

const MAX_DATA_POINTS = 10000; // Keep last 10k data points per category

/**
 * Collect metrics for a single ship
 */
export function collectShipMetrics(shipId: string, shipState: {
  credits: number;
  cargo: Map<string, number> | Record<string, number>;
  currentSystem: number | null;
  phase: string;
}, goodsPrices: Record<string, number>): void {
  const cargo = shipState.cargo instanceof Map 
    ? Object.fromEntries(shipState.cargo)
    : shipState.cargo;
  
  let cargoValue = 0;
  for (const [goodId, qty] of Object.entries(cargo)) {
    const price = goodsPrices[goodId] || 0;
    cargoValue += price * qty;
  }
  
  const metric: ShipMetrics = {
    shipId,
    timestamp: Date.now(),
    credits: shipState.credits,
    cargoValue,
    totalWealth: shipState.credits + cargoValue,
    system: shipState.currentSystem,
    phase: shipState.phase,
  };
  
  monitoringData.shipMetrics.push(metric);
  
  // Trim if too large
  if (monitoringData.shipMetrics.length > MAX_DATA_POINTS) {
    monitoringData.shipMetrics = monitoringData.shipMetrics.slice(-MAX_DATA_POINTS);
  }
}

/**
 * Collect metrics for a system
 */
export function collectSystemMetrics(
  systemId: number,
  markets: Record<string, { price: number; inventory: number; basePrice?: number }>,
  shipsAtStation: number,
  previousPrices?: Record<string, number>
): void {
  const goods: Record<string, any> = {};
  for (const [goodId, market] of Object.entries(markets)) {
    const prevPrice = previousPrices?.[goodId] || market.price;
    const priceChange = prevPrice > 0 ? ((market.price - prevPrice) / prevPrice) * 100 : 0;
    
    goods[goodId] = {
      price: market.price,
      inventory: market.inventory,
      priceChange,
      basePrice: market.basePrice || market.price,
    };
  }
  
  const metric: SystemMetrics = {
    systemId,
    timestamp: Date.now(),
    goods,
    shipsAtStation,
    totalTradeVolume: 0, // Would need to track this separately
  };
  
  monitoringData.systemMetrics.push(metric);
  
  // Trim if too large
  if (monitoringData.systemMetrics.length > MAX_DATA_POINTS) {
    monitoringData.systemMetrics = monitoringData.systemMetrics.slice(-MAX_DATA_POINTS);
  }
}

/**
 * Collect galaxy-wide metrics
 */
export function collectGalaxyMetrics(ships: Array<{
  credits: number;
  cargo: Map<string, number> | Record<string, number>;
  phase: string;
  currentSystem: number | null;
}>, allSystemMarkets: Record<number, Record<string, { price: number; basePrice: number }>>): void {
  const now = Date.now();
  
  // Calculate wealth distribution
  const wealths: number[] = [];
  let shipsAtStation = 0;
  let shipsTraveling = 0;
  let shipsResting = 0;
  
  for (const ship of ships) {
    const cargo = ship.cargo instanceof Map 
      ? Object.fromEntries(ship.cargo)
      : ship.cargo;
    
    // Estimate cargo value (use average prices across systems)
    let cargoValue = 0;
    for (const [goodId, qty] of Object.entries(cargo)) {
      // Find average price across all systems
      let avgPrice = 0;
      let count = 0;
      for (const systemMarkets of Object.values(allSystemMarkets)) {
        if (systemMarkets[goodId]) {
          avgPrice += systemMarkets[goodId].price;
          count++;
        }
      }
      if (count > 0) {
        avgPrice /= count;
      }
      cargoValue += avgPrice * qty;
    }
    
    const totalWealth = ship.credits + cargoValue;
    wealths.push(totalWealth);
    
    if (ship.phase === "at_station") shipsAtStation++;
    else if (ship.phase === "departing" || ship.phase === "in_hyperspace" || ship.phase === "arriving") shipsTraveling++;
    else if (ship.phase === "resting" || ship.phase === "sleeping") shipsResting++;
  }
  
  wealths.sort((a, b) => a - b);
  const avgWealth = wealths.length > 0 ? wealths.reduce((a, b) => a + b, 0) / wealths.length : 0;
  const medianWealth = wealths.length > 0 ? wealths[Math.floor(wealths.length / 2)] : 0;
  const maxWealth = wealths.length > 0 ? wealths[wealths.length - 1] : 0;
  const minWealth = wealths.length > 0 ? wealths[0] : 0;
  
  const wealthDistribution = {
    under1k: wealths.filter(w => w < 1000).length,
    under10k: wealths.filter(w => w < 10000).length,
    under100k: wealths.filter(w => w < 100000).length,
    under1m: wealths.filter(w => w < 1000000).length,
    over1m: wealths.filter(w => w >= 1000000).length,
  };
  
  // Calculate price volatility per good
  const priceVolatility: Record<string, any> = {};
  const goodVolatilities: Record<string, number[]> = {};
  
  for (const [systemId, markets] of Object.entries(allSystemMarkets)) {
    for (const [goodId, market] of Object.entries(markets)) {
      if (!goodVolatilities[goodId]) {
        goodVolatilities[goodId] = [];
      }
      const priceRatio = market.basePrice > 0 ? market.price / market.basePrice : 1;
      goodVolatilities[goodId].push(priceRatio);
    }
  }
  
  for (const [goodId, ratios] of Object.entries(goodVolatilities)) {
    if (ratios.length === 0) continue;
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const variance = ratios.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / ratios.length;
    const volatility = Math.sqrt(variance) * 100; // Convert to percentage
    
    const prices = ratios.map(r => {
      // Find base price
      for (const markets of Object.values(allSystemMarkets)) {
        if (markets[goodId]) {
          return markets[goodId].basePrice * r;
        }
      }
      return 0;
    }).filter(p => p > 0);
    
    priceVolatility[goodId] = {
      goodId,
      averageVolatility: volatility,
      maxPrice: prices.length > 0 ? Math.max(...prices) : 0,
      minPrice: prices.length > 0 ? Math.min(...prices) : 0,
    };
  }
  
  const metric: GalaxyMetrics = {
    timestamp: now,
    totalShips: ships.length,
    shipsAtStation,
    shipsTraveling,
    shipsResting,
    averageWealth: avgWealth,
    medianWealth,
    maxWealth,
    minWealth,
    wealthDistribution,
    priceVolatility,
  };
  
  monitoringData.galaxyMetrics.push(metric);
  monitoringData.lastCollectionTime = now;
  
  // Trim if too large
  if (monitoringData.galaxyMetrics.length > MAX_DATA_POINTS) {
    monitoringData.galaxyMetrics = monitoringData.galaxyMetrics.slice(-MAX_DATA_POINTS);
  }
}

/**
 * Get all collected monitoring data
 */
export function getMonitoringData(): MonitoringData {
  return monitoringData;
}

/**
 * Clear all monitoring data
 */
export function clearMonitoringData(): void {
  monitoringData = {
    shipMetrics: [],
    systemMetrics: [],
    galaxyMetrics: [],
    startTime: Date.now(),
    lastCollectionTime: 0,
  };
}

/**
 * Analyze collected data and provide recommendations
 */
export function analyzeAndRecommend(): {
  issues: Array<{
    severity: "critical" | "warning" | "info";
    category: string;
    message: string;
    recommendation: string;
  }>;
  statistics: {
    monitoringDuration: number;
    dataPoints: number;
    averageWealthGrowth: number;
    maxWealthGrowth: number;
    priceVolatility: Record<string, number>;
  };
} {
  const issues: Array<{
    severity: "critical" | "warning" | "info";
    category: string;
    message: string;
    recommendation: string;
  }> = [];
  
  const stats = {
    monitoringDuration: Date.now() - monitoringData.startTime,
    dataPoints: monitoringData.galaxyMetrics.length,
    averageWealthGrowth: 0,
    maxWealthGrowth: 0,
    priceVolatility: {} as Record<string, number>,
  };
  
  if (monitoringData.galaxyMetrics.length < 2) {
    return {
      issues: [{
        severity: "info",
        category: "Data Collection",
        message: "Insufficient data collected. Need at least 2 data points.",
        recommendation: "Continue monitoring for at least a few minutes.",
      }],
      statistics: stats,
    };
  }
  
  // Analyze wealth growth
  const firstMetrics = monitoringData.galaxyMetrics[0];
  const lastMetrics = monitoringData.galaxyMetrics[monitoringData.galaxyMetrics.length - 1];
  const timeDiff = (lastMetrics.timestamp - firstMetrics.timestamp) / 1000 / 60; // minutes
  
  if (timeDiff > 0) {
    stats.averageWealthGrowth = (lastMetrics.averageWealth - firstMetrics.averageWealth) / timeDiff;
    stats.maxWealthGrowth = (lastMetrics.maxWealth - firstMetrics.maxWealth) / timeDiff;
    
    // Check for excessive wealth growth
    if (stats.averageWealthGrowth > 10000) {
      issues.push({
        severity: "critical",
        category: "Wealth Growth",
        message: `Average wealth growing too fast: ${stats.averageWealthGrowth.toFixed(0)} cr/min`,
        recommendation: "Reduce profit margins, increase trading costs, or slow price changes.",
      });
    } else if (stats.averageWealthGrowth > 5000) {
      issues.push({
        severity: "warning",
        category: "Wealth Growth",
        message: `Average wealth growing quickly: ${stats.averageWealthGrowth.toFixed(0)} cr/min`,
        recommendation: "Consider reducing profit margins or increasing trading frequency limits.",
      });
    }
    
    if (stats.maxWealthGrowth > 100000) {
      issues.push({
        severity: "critical",
        category: "Wealth Inequality",
        message: `Maximum wealth growing extremely fast: ${stats.maxWealthGrowth.toFixed(0)} cr/min`,
        recommendation: "Implement wealth caps, progressive taxation, or reduce maximum profit margins.",
      });
    }
  }
  
  // Check wealth distribution
  const lastDist = lastMetrics.wealthDistribution;
  const totalShips = lastMetrics.totalShips;
  if (totalShips > 0) {
    const millionairePercent = (lastDist.over1m / totalShips) * 100;
    if (millionairePercent > 10) {
      issues.push({
        severity: "critical",
        category: "Wealth Distribution",
        message: `${millionairePercent.toFixed(1)}% of ships are millionaires`,
        recommendation: "Reduce profit margins, add trading fees, or implement wealth redistribution.",
      });
    } else if (millionairePercent > 5) {
      issues.push({
        severity: "warning",
        category: "Wealth Distribution",
        message: `${millionairePercent.toFixed(1)}% of ships are millionaires`,
        recommendation: "Monitor closely and consider reducing maximum profit opportunities.",
      });
    }
  }
  
  // Analyze price volatility
  for (const [goodId, vol] of Object.entries(lastMetrics.priceVolatility)) {
    stats.priceVolatility[goodId] = vol.averageVolatility;
    
    if (vol.averageVolatility > 50) {
      issues.push({
        severity: "critical",
        category: "Price Volatility",
        message: `${goodId} has extreme price volatility: ${vol.averageVolatility.toFixed(1)}%`,
        recommendation: "Reduce price elasticity, add price caps, or increase inventory buffers.",
      });
    } else if (vol.averageVolatility > 25) {
      issues.push({
        severity: "warning",
        category: "Price Volatility",
        message: `${goodId} has high price volatility: ${vol.averageVolatility.toFixed(1)}%`,
        recommendation: "Consider reducing price elasticity or increasing market stability.",
      });
    }
    
    const priceRange = vol.maxPrice / vol.minPrice;
    if (priceRange > 10) {
      issues.push({
        severity: "critical",
        category: "Price Range",
        message: `${goodId} price varies by ${priceRange.toFixed(1)}x across systems`,
        recommendation: "Add price convergence mechanisms or reduce price elasticity.",
      });
    }
  }
  
  // Check for price extremes
  for (const systemMetric of monitoringData.systemMetrics.slice(-100)) {
    for (const [goodId, good] of Object.entries(systemMetric.goods)) {
      const priceRatio = good.basePrice > 0 ? good.price / good.basePrice : 1;
      if (priceRatio > 5) {
        issues.push({
          severity: "warning",
          category: "Price Extremes",
          message: `${goodId} in system ${systemMetric.systemId} is ${priceRatio.toFixed(1)}x base price`,
          recommendation: "Add maximum price caps or increase production to reduce scarcity.",
        });
      } else if (priceRatio < 0.2) {
        issues.push({
          severity: "warning",
          category: "Price Extremes",
          message: `${goodId} in system ${systemMetric.systemId} is ${priceRatio.toFixed(1)}x base price (very low)`,
          recommendation: "Reduce production or increase consumption to prevent oversupply.",
        });
      }
    }
  }
  
  return { issues, statistics: stats };
}

