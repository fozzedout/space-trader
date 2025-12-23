/**
 * API Documentation for Space Trader
 * 
 * This file contains comprehensive documentation for all API endpoints.
 * It is embedded in the dev interface and should be kept up-to-date.
 * 
 * IMPORTANT: When adding or modifying endpoints, update this documentation
 * and ensure it's reflected in the dev interface at /dev
 */

export interface ApiEndpoint {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  description: string;
  parameters?: {
    name: string;
    type: string;
    required: boolean;
    description: string;
  }[];
  requestBody?: {
    fields: Array<{
      name: string;
      type: string;
      required: boolean;
      description: string;
    }>;
  };
  response: {
    description: string;
    example?: any;
  };
  notes?: string[];
}

export const API_DOCUMENTATION: Record<string, ApiEndpoint[]> = {
  "Galaxy Operations": [
    {
      method: "POST",
      path: "/api/galaxy/initialize",
      description: "Initializes the entire galaxy with all star systems and NPC traders. This is a one-time setup operation that creates 256 star systems with randomized properties (population, tech level, government type) and spawns NPC traders (default: 50 per system). Each system gets its own deterministic RNG seed based on the galaxy seed.",
      requestBody: {
        fields: [
          {
            name: "seed",
            type: "string",
            required: false,
            description: "Optional seed for deterministic galaxy generation. If omitted, uses seed \"1\".",
          },
        ],
      },
      response: {
        description: "Returns the number of systems initialized and NPCs created.",
        example: {
          success: true,
          systemsInitialized: 256,
          npcsCreated: 12800,
        },
      },
      notes: [
        "This operation can take several seconds as it initializes 256 systems and thousands of NPCs.",
        "Each system is initialized with unique properties based on deterministic RNG.",
        "NPCs are randomly assigned to home systems.",
      ],
    },
    {
      method: "POST",
      path: "/api/galaxy/tick",
      description: "Processes a simulation tick for all star systems and NPC ships in the galaxy. This advances the simulation by one time step, updating market prices, production/consumption, processing ship arrivals/departures, and advancing NPC trader behavior (travel, trading decisions). NPCs that are resting or sleeping are skipped. This is typically called automatically via scheduled events in production.",
      response: {
        description: "Returns the number of systems and NPC ships that were ticked.",
        example: {
          success: true,
          systemsTicked: 256,
          shipsTicked: 12000,
          totalNPCs: 12800,
        },
      },
      notes: [
        "Ticking all systems and NPCs can take time depending on galaxy size.",
        "In production, this should be done via scheduled events (cron).",
        "Each tick advances market dynamics, ship travel, and NPC trading decisions.",
        "NPCs that are resting or sleeping are automatically skipped (they're in an 'ignore pool').",
      ],
    },
    {
      method: "POST",
      path: "/api/galaxy/reset-zero-inventory-monitoring",
      description: "Resets zero inventory monitoring state and clears trade logs. Also resets all systems' stock levels and prices to initial values, and resets all NPCs to be at station with 500cr and no cargo. This allows monitoring to restart after a zero inventory event has been detected. After calling this endpoint, zero inventory detection will resume and new trade logs will be collected.",
      response: {
        description: "Returns confirmation that monitoring has been reset.",
        example: {
          success: true,
          message: "Zero inventory monitoring reset. Trade logs cleared. All systems and NPCs reset.",
          zeroInventoryDetected: false,
          zeroInventorySystem: null,
          zeroInventoryGood: null,
        },
      },
      notes: [
        "This clears all trade logs and resets the zero inventory detection flags.",
        "Resets all systems: inventory set to 2000 units and prices reset to base prices for all goods.",
        "Resets all NPCs: placed at their current system (or system 0 if no current system) with 500 credits and empty cargo.",
        "After resetting, monitoring will resume and new zero inventory events will be detected and logged.",
        "Useful for restarting monitoring after investigating a zero inventory issue.",
      ],
    },
    {
      method: "POST",
      path: "/api/galaxy/check-and-log",
      description: "Writes a cycle summary log file and stops logging. This collects snapshots (low credit, trade logs, galaxy health) and writes them to cycle-log.json, then pauses logging until server restart. This does NOT reset or reinitialize the galaxy - it only writes logs and stops logging.",
      response: {
        description: "Returns status of log writing and logging pause.",
        example: {
          success: true,
          logWritten: true,
          loggingPaused: true,
          timestamp: 1234567890000,
          message: "Log written and logging paused. Restart server to resume logging.",
        },
      },
      notes: [
        "This writes the current cycle summary to cycle-log.json and pauses logging.",
        "The galaxy is NOT reset or reinitialized - only log writing and logging pause occur.",
        "Logging will remain paused until the server is restarted.",
      ],
    },
    {
      method: "GET",
      path: "/api/health",
      description: "Simple health check endpoint to verify the API is running and responsive. Returns a basic status message.",
      response: {
        description: "Returns a simple status object.",
        example: {
          status: "ok",
        },
      },
      notes: ["Useful for monitoring and testing connectivity."],
    },
    {
      method: "GET",
      path: "/api/galaxy-health",
      description: "Returns comprehensive galactic health metrics including ship spawn/removal rates, trade quality analysis, population health, and overall system status. Tracks ships being spawned vs removed, analyzes trade logs to determine good vs bad trades, and provides health status (healthy/warning/critical) with specific issues identified.",
      response: {
        description: "Returns detailed galactic health metrics including population stats, ship spawn/removal tracking, trade analysis, and health status.",
        example: {
          success: true,
          health: {
            timestamp: 1234567890000,
            population: {
              current: 12000,
              target: 12800,
              active: 12000,
              inactive: 0,
            },
            ships: {
              totalSpawns: 150,
              totalRemovals: 20,
              spawnsSinceStart: 5,
              removalsSinceStart: 2,
              netGrowth: 3,
              removalReasons: {
                bankrupt: 15,
                unknown: 5,
              },
            },
            trades: {
              totalTrades: 1000,
              successfulBuys: 450,
              successfulSells: 500,
              failedTrades: 50,
              profitableTrades: 800,
              unprofitableTrades: 100,
              totalProfit: 50000,
              totalLoss: 5000,
            },
            health: {
              status: "healthy",
              issues: [],
            },
          },
        },
      },
      notes: [
        "Tracks ship spawns and removals over time to monitor population health.",
        "Analyzes trade logs since server start to determine trade quality.",
        "Health status can be 'healthy', 'warning', or 'critical' with specific issues listed.",
      ],
    },
    {
      method: "GET",
      path: "/api/leaderboard",
      description: "Returns comprehensive galactic leaderboards showing top traders, best systems, and popular trade routes. Tracks traders by credits, ticks, trades, profit, and volume. Tracks systems by trade volume, number of trades, unique traders, and profit. Shows popular trade routes between systems.",
      parameters: [
        {
          name: "limit",
          type: "number",
          required: false,
          description: "Maximum number of entries to return per category (default: 100, max: 1000).",
        },
      ],
      response: {
        description: "Returns leaderboard data with top traders, systems, and routes in multiple categories.",
        example: {
          success: true,
          leaderboard: {
            traders: {
              byCredits: [
                { shipId: "npc-123", name: "Trader 123", credits: 50000 },
              ],
              byTicks: [
                { shipId: "npc-456", name: "Trader 456", ticks: 1000 },
              ],
              byTrades: [
                { shipId: "npc-789", name: "Trader 789", trades: 500 },
              ],
              byProfit: [
                { shipId: "npc-123", name: "Trader 123", profit: 10000 },
              ],
              byVolume: [
                { shipId: "npc-123", name: "Trader 123", volume: 100000 },
              ],
            },
            systems: {
              byTradeVolume: [
                { systemId: 0, name: "Sol", volume: 500000 },
              ],
              byTrades: [
                { systemId: 0, name: "Sol", trades: 5000 },
              ],
              byUniqueTraders: [
                { systemId: 0, name: "Sol", traders: 50 },
              ],
              byProfit: [
                { systemId: 0, name: "Sol", profit: 50000 },
              ],
            },
            routes: [
              {
                fromSystem: 0,
                toSystem: 1,
                tradeCount: 100,
                volume: 50000,
                profit: 5000,
                traders: 10,
              },
            ],
          },
        },
      },
      notes: [
        "Leaderboards are updated in real-time as trades and ticks occur.",
        "Routes show popular trade paths between systems.",
        "Use GET /api/leaderboard/trader/{id} for detailed trader stats.",
        "Use GET /api/leaderboard/system/{id} for detailed system stats.",
      ],
    },
    {
      method: "GET",
      path: "/api/leaderboard/trader/{id}",
      description: "Gets detailed statistics for a specific trader including credits, ticks, trades, profit, volume, and systems visited.",
      parameters: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "Ship ID (e.g., 'npc-0', 'npc-123').",
        },
      ],
      response: {
        description: "Returns detailed trader statistics.",
        example: {
          success: true,
          trader: {
            shipId: "npc-123",
            name: "Trader 123",
            currentCredits: 50000,
            peakCredits: 55000,
            totalTicks: 1000,
            totalTrades: 500,
            successfulTrades: 480,
            totalProfit: 10000,
            totalVolume: 100000,
            systemsVisited: [0, 1, 2, 3],
            lastUpdated: 1234567890000,
          },
        },
      },
      notes: ["Returns 404 if trader not found in leaderboard."],
    },
    {
      method: "GET",
      path: "/api/leaderboard/system/{id}",
      description: "Gets detailed statistics for a specific system including trade volume, number of trades, unique traders, profit, and average prices.",
      parameters: [
        {
          name: "id",
          type: "number",
          required: true,
          description: "System ID (0-255).",
        },
      ],
      response: {
        description: "Returns detailed system statistics.",
        example: {
          success: true,
          system: {
            systemId: 0,
            name: "Sol",
            totalTradeVolume: 500000,
            totalTrades: 5000,
            uniqueTraders: ["npc-0", "npc-1", "npc-2"],
            totalProfit: 50000,
            averagePrice: {
              food: 10.5,
              metals: 25.3,
            },
            lastUpdated: 1234567890000,
          },
        },
      },
      notes: ["Returns 404 if system not found in leaderboard."],
    },
    {
      method: "POST",
      path: "/api/leaderboard/clear",
      description: "Clears all leaderboard tracking data (trader stats, system stats, and trade routes). Useful for resetting metrics after balance changes or for testing.",
      response: {
        description: "Returns success confirmation.",
        example: {
          success: true,
          message: "Leaderboard data cleared",
        },
      },
      notes: ["This only clears tracking data, not the actual ships or systems."],
    },
    {
      method: "POST",
      path: "/api/flush",
      description: "Manually triggers a flush of all in-memory state to the database. The system normally works in-memory for performance and flushes automatically every hour, but this endpoint allows immediate persistence. Useful before shutdown or when you want to ensure data is saved.",
      response: {
        description: "Returns success confirmation with number of systems and ships flushed.",
        example: {
          success: true,
          message: "State flushed to database",
        },
      },
      notes: [
        "This is a write operation that persists all current state to SQLite.",
        "The system uses lazy writes - state is kept in memory and only written periodically.",
        "Flush happens automatically every hour, on shutdown, and on this manual request.",
        "Useful for ensuring data persistence before important operations or shutdown.",
      ],
    },
  ],
  "Player Accounts": [
    {
      method: "GET",
      path: "/api/player?name={name}",
      description: "Fetch a player account by name.",
      parameters: [
        {
          name: "name",
          type: "string",
          required: true,
          description: "Player name (unique key).",
        },
      ],
      response: {
        description: "Returns the player record if found.",
        example: {
          player: {
            name: "Ace Pilot",
            shipId: "player-Ace%20Pilot",
            createdAt: 1730000000000,
            lastSeen: 1730000000000,
          },
        },
      },
      notes: ["Returns 404 if no player is found."],
    },
    {
      method: "POST",
      path: "/api/player",
      description: "Create or update a player account by name. If the player exists, updates last seen.",
      requestBody: {
        fields: [
          {
            name: "name",
            type: "string",
            required: true,
            description: "Player name (unique key).",
          },
        ],
      },
      response: {
        description: "Returns the player record and a created flag.",
        example: {
          created: true,
          player: {
            name: "Ace Pilot",
            shipId: "player-Ace%20Pilot",
            createdAt: 1730000000000,
            lastSeen: 1730000000000,
          },
        },
      },
    },
  ],
  "System Operations": [
    {
      method: "GET",
      path: "/api/system/{id}?action=snapshot",
      description: "Gets a complete snapshot of a star system's current state. This is the 'teleportation' feature - you can observe any system without affecting it. Returns system properties, all market data (prices, inventory, supply/demand), ships currently in system, and price history.",
      parameters: [
        {
          name: "id",
          type: "number",
          required: true,
          description: "System ID (0-255). Must be a valid system ID within the galaxy size.",
        },
        {
          name: "action",
          type: "string",
          required: true,
          description: "Must be 'snapshot' for this endpoint.",
        },
      ],
      response: {
        description: "Returns complete system state including markets, ships, and price history.",
        example: {
          state: {
            id: 0,
            name: "Sol",
            population: 88.7,
            techLevel: 4,
            government: "dictatorship",
            currentTick: 5,
          },
          markets: {
            food: {
              price: 14,
              inventory: 6733,
              production: 4.9,
              consumption: 5.5,
            },
          },
          shipsInSystem: ["npc-0", "npc-1"],
        },
      },
      notes: [
        "This is a read-only operation - it doesn't affect the simulation.",
        "Useful for finding trading opportunities across systems.",
      ],
    },
  ],
  "Ship Operations": [
    {
      method: "GET",
      path: "/api/ship/{id}",
      description: "Gets the current state of a ship (NPC trader or player ship). Returns location, cargo, credits, travel status, and other ship properties. NPCs are autonomous traders that buy low and sell high, traveling between systems.",
      parameters: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "Ship ID (e.g., 'npc-0', 'npc-1', or custom player ship ID).",
        },
      ],
      response: {
        description: "Returns complete ship state including location, cargo, credits, and travel status.",
        example: {
          id: "npc-0",
          name: "Trader 0",
          currentSystem: 0,
          destinationSystem: 5,
          departureTime: 1234567890,
          arrivalTime: 1234567890,
          cargo: { food: 10, metals: 5 },
          credits: 100,
          isNPC: true,
          positionX: 0,
          positionY: 0,
          armaments: {
            lasers: { front: "pulse", rear: null, left: null, right: null },
            missiles: 0,
            ecm: false,
            energyBomb: false,
          },
          fuelLy: 15,
          fuelCapacityLy: 15,
        },
      },
      notes: [
        "NPC ships make autonomous trading decisions based on deterministic RNG.",
        "Ships can be traveling between systems - check departureTime and arrivalTime.",
        "Cargo is stored as a map of good IDs to quantities.",
      ],
    },
    {
      method: "GET",
      path: "/api/ship/{id}?action=armaments",
      description: "Gets current armaments, fuel status, and available upgrades based on the system tech level.",
      parameters: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "Ship ID.",
        },
      ],
      response: {
        description: "Returns armament loadout, fuel, and available upgrades.",
        example: {
          armaments: {
            lasers: { front: "pulse", rear: null, left: null, right: null },
            missiles: 2,
            ecm: false,
            energyBomb: false,
          },
          fuelLy: 12,
          fuelCapacityLy: 15,
          techLevel: 4,
          available: {
            lasers: ["pulse", "beam"],
            missiles: true,
            ecm: true,
            energyBomb: false,
          },
        },
      },
      notes: [
        "Availability is based on the current system tech level.",
        "Fuel costs 2 credits per light year when refueling.",
      ],
    },
    {
      method: "POST",
      path: "/api/ship/{id}?action=armaments",
      description: "Purchases armaments or refuels the hyperspace tank (Elite-style equipment list).",
      parameters: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "Ship ID.",
        },
      ],
      requestBody: {
        fields: [
          {
            name: "category",
            type: "string",
            required: true,
            description: "One of: 'laser', 'missile', 'ecm', 'energyBomb', or 'fuel'.",
          },
          {
            name: "mount",
            type: "string",
            required: false,
            description: "Laser mount (front, rear, left, right). Required for laser purchases.",
          },
          {
            name: "laserType",
            type: "string",
            required: false,
            description: "Laser type (pulse, beam, military). Required for laser purchases.",
          },
          {
            name: "quantity",
            type: "number",
            required: false,
            description: "Missile quantity to purchase (1-4).",
          },
        ],
      },
      response: {
        description: "Returns purchase success, cost, and updated armaments or fuel.",
        example: {
          success: true,
          cost: 600,
          armaments: {
            lasers: { front: "pulse", rear: "beam", left: null, right: null },
            missiles: 2,
            ecm: true,
            energyBomb: false,
          },
        },
      },
      notes: [
        "Purchases require sufficient credits and minimum tech level.",
        "Refueling fills the tank to 15 ly at 2 credits per light year.",
      ],
    },
    {
      method: "POST",
      path: "/api/ship/{id}",
      description: "Performs an action on a ship. Currently supports 'tick' action which processes the ship's simulation step (handles travel, trading decisions, etc.).",
      parameters: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "Ship ID.",
        },
      ],
      requestBody: {
        fields: [
          {
            name: "action",
            type: "string",
            required: true,
            description: "Action to perform. Currently only 'tick' is supported.",
          },
        ],
      },
      response: {
        description: "Returns updated ship state after the action.",
        example: {
          success: true,
          ship: {
            /* updated ship state */
          },
        },
      },
      notes: [
        "NPC ships tick automatically when accessed, but you can manually trigger ticks for testing.",
        "Ship ticks handle travel completion, trading decisions, and cargo management.",
      ],
    },
  ],
};

/**
 * Get formatted documentation for display in dev interface
 */
export function getFormattedDocs(): string {
  let docs = "# API Documentation\n\n";
  
  for (const [category, endpoints] of Object.entries(API_DOCUMENTATION)) {
    docs += `## ${category}\n\n`;
    
    for (const endpoint of endpoints) {
      docs += `### ${endpoint.method} ${endpoint.path}\n\n`;
      docs += `${endpoint.description}\n\n`;
      
      if (endpoint.parameters && endpoint.parameters.length > 0) {
        docs += "**Parameters:**\n";
        for (const param of endpoint.parameters) {
          docs += `- \`${param.name}\` (${param.type}${param.required ? ", required" : ", optional"}): ${param.description}\n`;
        }
        docs += "\n";
      }
      
      if (endpoint.requestBody) {
        docs += "**Request Body:**\n";
        for (const field of endpoint.requestBody.fields) {
          docs += `- \`${field.name}\` (${field.type}${field.required ? ", required" : ", optional"}): ${field.description}\n`;
        }
        docs += "\n";
      }
      
      docs += `**Response:** ${endpoint.response.description}\n\n`;
      
      if (endpoint.response.example) {
        docs += "```json\n";
        docs += JSON.stringify(endpoint.response.example, null, 2);
        docs += "\n```\n\n";
      }
      
      if (endpoint.notes && endpoint.notes.length > 0) {
        docs += "**Notes:**\n";
        for (const note of endpoint.notes) {
          docs += `- ${note}\n`;
        }
        docs += "\n";
      }
      
      docs += "---\n\n";
    }
  }
  
  return docs;
}

/**
 * Escape HTML special characters to prevent XSS and template literal issues
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Get inline documentation HTML for a specific endpoint
 * Used to embed documentation directly in the dev interface sections
 * Returns HTML string that can be safely embedded in template literals
 */
export function getEndpointDocHtml(endpoint: ApiEndpoint): string {
  const method = escapeHtml(endpoint.method);
  const path = escapeHtml(endpoint.path);
  const description = escapeHtml(endpoint.description);
  
  let html = '<div class="endpoint-doc">';
  html += `<div class="endpoint-header"><code>${method} ${path}</code></div>`;
  html += `<div class="endpoint-description">${description}</div>`;
  
  if (endpoint.parameters && endpoint.parameters.length > 0) {
    html += '<div class="endpoint-params"><strong>Parameters:</strong><ul>';
    for (const param of endpoint.parameters) {
      const paramName = escapeHtml(param.name);
      const paramType = escapeHtml(param.type);
      const paramDesc = escapeHtml(param.description);
      const required = param.required ? ", required" : ", optional";
      html += `<li><code>${paramName}</code> (${paramType}${required}): ${paramDesc}</li>`;
    }
    html += '</ul></div>';
  }
  
  if (endpoint.requestBody) {
    html += '<div class="endpoint-body"><strong>Request Body:</strong><ul>';
    for (const field of endpoint.requestBody.fields) {
      const fieldName = escapeHtml(field.name);
      const fieldType = escapeHtml(field.type);
      const fieldDesc = escapeHtml(field.description);
      const required = field.required ? ", required" : ", optional";
      html += `<li><code>${fieldName}</code> (${fieldType}${required}): ${fieldDesc}</li>`;
    }
    html += '</ul></div>';
  }
  
  const responseDesc = escapeHtml(endpoint.response.description);
  html += `<div class="endpoint-response"><strong>Response:</strong> ${responseDesc}</div>`;
  
  if (endpoint.notes && endpoint.notes.length > 0) {
    html += '<div class="endpoint-notes"><strong>Notes:</strong><ul>';
    for (const note of endpoint.notes) {
      html += `<li>${escapeHtml(note)}</li>`;
    }
    html += '</ul></div>';
  }
  
  html += '</div>';
  return html;
}

/**
 * Get documentation for a category (e.g., "Galaxy Operations")
 * Returns HTML for all endpoints in that category
 */
export function getCategoryDocsHtml(category: string): string {
  const endpoints = API_DOCUMENTATION[category];
  if (!endpoints) return "";
  
  let html = `<div class="category-docs">`;
  for (const endpoint of endpoints) {
    html += getEndpointDocHtml(endpoint);
  }
  html += `</div>`;
  return html;
}

/**
 * Find endpoint documentation by path pattern
 * Useful for matching buttons to their documentation
 */
export function findEndpointByPath(pathPattern: string): ApiEndpoint | null {
  for (const endpoints of Object.values(API_DOCUMENTATION)) {
    for (const endpoint of endpoints) {
      // Simple pattern matching - check if path contains the pattern
      if (endpoint.path.includes(pathPattern) || pathPattern.includes(endpoint.path.split('/').pop() || '')) {
        return endpoint;
      }
    }
  }
  return null;
}

/**
 * Find endpoint by category and action name
 * e.g., "Galaxy Operations" + "initialize" -> POST /api/galaxy/initialize
 */
export function findEndpointByAction(category: string, action: string): ApiEndpoint | null {
  const endpoints = API_DOCUMENTATION[category];
  if (!endpoints) return null;
  
  // Try to match by action name in path
  const actionLower = action.toLowerCase();
  for (const endpoint of endpoints) {
    const pathLower = endpoint.path.toLowerCase();
    if (pathLower.includes(actionLower)) {
      return endpoint;
    }
  }
  
  return null;
}
