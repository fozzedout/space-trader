import { LaserMount, LaserType, ShipArmaments, TechLevel } from "./types";

export const FUEL_TANK_RANGE_LY = 15;
export const FUEL_PRICE_PER_LY = 2;

export const LASER_PRICES: Record<LaserType, number> = {
  pulse: 400,
  beam: 1000,
  military: 6000,
};

export const LASER_TECH_LEVEL: Record<LaserType, TechLevel> = {
  pulse: TechLevel.AGRICULTURAL,
  beam: TechLevel.RENAISSANCE,
  military: TechLevel.POST_INDUSTRIAL,
};

export const ARMAMENT_PRICES = {
  missile: 30,
  ecm: 600,
  energyBomb: 900,
};

export const ARMAMENT_TECH_LEVEL = {
  missile: TechLevel.MEDIEVAL,
  ecm: TechLevel.INDUSTRIAL,
  energyBomb: TechLevel.POST_INDUSTRIAL,
};

export const MAX_MISSILES = 4;

export function getDefaultArmaments(): ShipArmaments {
  return {
    lasers: {
      front: "pulse",
      rear: null,
      left: null,
      right: null,
    },
    missiles: 0,
    ecm: false,
    energyBomb: false,
  };
}

export function canInstallLaser(techLevel: TechLevel, laserType: LaserType): boolean {
  return techLevel >= LASER_TECH_LEVEL[laserType];
}

export function getLaserPrice(laserType: LaserType): number {
  return LASER_PRICES[laserType];
}

export function getLaserOptions(techLevel: TechLevel): LaserType[] {
  return (Object.keys(LASER_TECH_LEVEL) as LaserType[]).filter(
    (laserType) => techLevel >= LASER_TECH_LEVEL[laserType]
  );
}

export function getAvailableArmaments(techLevel: TechLevel, armaments: ShipArmaments) {
  return {
    lasers: getLaserOptions(techLevel),
    missiles: armaments.missiles < MAX_MISSILES && techLevel >= ARMAMENT_TECH_LEVEL.missile,
    ecm: !armaments.ecm && techLevel >= ARMAMENT_TECH_LEVEL.ecm,
    energyBomb: !armaments.energyBomb && techLevel >= ARMAMENT_TECH_LEVEL.energyBomb,
  };
}

export function isValidLaserMount(mount: string): mount is LaserMount {
  return mount === "front" || mount === "rear" || mount === "left" || mount === "right";
}
