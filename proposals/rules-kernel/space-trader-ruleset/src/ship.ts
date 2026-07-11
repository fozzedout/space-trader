import { GADGETS, SHIELDS, SHIP_TYPES, WEAPONS } from './data.js';
import { CrewSkills, InstalledEquipmentValue } from './types.js';

const trunc = Math.trunc;


/** Original BasePrice for purchasable weapons, shields and gadgets. */
export function equipmentPurchasePrice(
  itemTechLevel: number,
  basePrice: number,
  systemTechLevel: number,
  traderSkill: number,
): number {
  if (itemTechLevel > systemTechLevel) return 0;
  return trunc(Math.max(0, basePrice) * (100 - Math.max(0, traderSkill)) / 100);
}

/** Original BASESHIPPRICE macro; shipyard availability is checked separately. */
export function shipPurchasePrice(basePrice: number, traderSkill: number): number {
  return trunc(Math.max(0, basePrice) * (100 - Math.max(0, traderSkill)) / 100);
}

export function equipmentResaleValue(equipment: InstalledEquipmentValue): number {
  const weaponValue = equipment.weapons.reduce((sum, id) => sum + (WEAPONS[id]?.price ?? 0), 0);
  const shieldValue = equipment.shields.reduce((sum, id) => sum + (SHIELDS[id]?.price ?? 0), 0);
  const gadgetValue = equipment.gadgets.reduce((sum, id) => sum + (GADGETS[id]?.price ?? 0), 0);
  return trunc((weaponValue + shieldValue + gadgetValue) * 2 / 3);
}

/** Original EnemyShipPrice; gadgets affect skills and are not added directly. */
export function enemyShipPrice(
  shipTypeId: number,
  weapons: readonly number[],
  shields: readonly number[],
  effectiveSkills: Pick<CrewSkills, 'pilot' | 'fighter' | 'engineer'>,
): number {
  const ship = SHIP_TYPES[shipTypeId];
  if (!ship) throw new RangeError(`Unknown ship type ${shipTypeId}`);
  let value = ship.basePrice;
  value += weapons.reduce((sum, id) => sum + (WEAPONS[id]?.price ?? 0), 0);
  value += shields.reduce((sum, id) => sum + (SHIELDS[id]?.price ?? 0), 0);
  const skillWeight = 2 * effectiveSkills.pilot + effectiveSkills.engineer + 3 * effectiveSkills.fighter;
  return trunc(value * skillWeight / 60);
}

export function shipTradeInValue(
  shipTypeId: number,
  currentHull: number,
  currentFuel: number,
  equipment: InstalledEquipmentValue,
  tribbleInfestation = false,
): number {
  const ship = SHIP_TYPES[shipTypeId];
  if (!ship) throw new RangeError(`Unknown ship type ${shipTypeId}`);
  let value = trunc(ship.basePrice * (tribbleInfestation ? 1 : 3) / 4);
  value -= ship.repairCostPerHull * Math.max(0, ship.hullStrength - currentHull);
  value -= ship.fuelCostPerParsec * Math.max(0, ship.fuelTanks - currentFuel);
  value += equipmentResaleValue(equipment);
  return Math.max(0, value);
}

export function fuelPurchaseCost(shipTypeId: number, currentFuel: number, requestedFuel: number): number {
  const ship = SHIP_TYPES[shipTypeId];
  if (!ship) throw new RangeError(`Unknown ship type ${shipTypeId}`);
  const units = Math.max(0, Math.min(requestedFuel, ship.fuelTanks - currentFuel));
  return units * ship.fuelCostPerParsec;
}

export function repairCost(shipTypeId: number, currentHull: number, requestedHull: number): number {
  const ship = SHIP_TYPES[shipTypeId];
  if (!ship) throw new RangeError(`Unknown ship type ${shipTypeId}`);
  const units = Math.max(0, Math.min(requestedHull, ship.hullStrength - currentHull));
  return units * ship.repairCostPerHull;
}

export function totalCargoCapacity(shipTypeId: number, extraBayGadgets: number): number {
  const ship = SHIP_TYPES[shipTypeId];
  if (!ship) throw new RangeError(`Unknown ship type ${shipTypeId}`);
  return ship.cargoBays + Math.max(0, Math.trunc(extraBayGadgets)) * 5;
}
