import { ROLES, type Role } from "./goods.js";
import { Rng } from "./rng.js";
import { StarSystem } from "./system.js";
import { Trader } from "./trader.js";

export interface GalaxyOptions {
  /** Number of star systems; rounded up to a multiple of the role count. */
  systems: number;
  /** NPC traders per system. */
  tradersPerSystem: number;
  /** Side length of the square map. */
  size: number;
}

export const DEFAULT_GALAXY_OPTIONS: GalaxyOptions = {
  systems: 12,
  tradersPerSystem: 3,
  size: 160,
};

export interface Galaxy {
  systems: StarSystem[];
  traders: Trader[];
}

const NAME_PREFIXES = [
  "Altair", "Vega", "Rigel", "Deneb", "Sirius", "Procyon", "Antares", "Castor",
  "Pollux", "Capella", "Arcturus", "Spica", "Mira", "Lyra", "Naos", "Tarsis",
];

const AVG_POP = 5;

/**
 * Deterministic galaxy generation, needs-consistent by construction:
 * roles are dealt round-robin so every role is represented evenly, and
 * each role's TOTAL population is normalized to the same value. Individual
 * systems still vary in size, but no role can randomly end up too small to
 * supply the galaxy — which would create a deficit no trader could fix.
 * (balance.test.ts checks the resulting aggregate surplus per good.)
 */
export function generateGalaxy(seed: number | string, opts?: Partial<GalaxyOptions>): Galaxy {
  const o = { ...DEFAULT_GALAXY_OPTIONS, ...opts };
  const rng = new Rng(seed).fork("galaxy");
  const count = Math.ceil(o.systems / ROLES.length) * ROLES.length;
  const perRole = count / ROLES.length;

  // Draw raw sizes, then scale within each role so role totals match.
  const rawPops = Array.from({ length: count }, () => rng.range(2, 8));
  const roleTotals = new Map<Role, number>();
  for (let i = 0; i < count; i++) {
    const role = ROLES[i % ROLES.length]!;
    roleTotals.set(role, (roleTotals.get(role) ?? 0) + rawPops[i]!);
  }

  const systems: StarSystem[] = [];
  for (let i = 0; i < count; i++) {
    const role: Role = ROLES[i % ROLES.length]!;
    const prefix = NAME_PREFIXES[i % NAME_PREFIXES.length];
    const pop = (rawPops[i]! / roleTotals.get(role)!) * perRole * AVG_POP;
    systems.push(
      new StarSystem({
        id: i,
        name: `${prefix}-${Math.floor(i / NAME_PREFIXES.length) + 1}`,
        x: rng.range(0, o.size),
        y: rng.range(0, o.size),
        role,
        pop,
      }),
    );
  }

  const traders: Trader[] = [];
  const traderRng = rng.fork("traders");
  const traderCount = count * o.tradersPerSystem;
  for (let i = 0; i < traderCount; i++) {
    traders.push(
      new Trader({
        id: i,
        credits: traderRng.range(4000, 8000),
        capacity: Math.round(traderRng.range(60, 140)),
        locationId: traderRng.int(0, count - 1),
      }),
    );
  }

  return { systems, traders };
}
