/** Original PalmOS galaxy geometry constants. */
export const ORIGINAL_GALAXY = {
  solarSystems: 120,
  wormholes: 6,
  width: 150,
  height: 110,
  minimumSystemDistance: 6,
  closeDistance: 13,
  wormholeDistance: 3,
  maximumFuelRange: 20,
} as const;

/** Fixed indices referenced by original quest and location logic. */
export const ORIGINAL_FIXED_SYSTEM_INDICES = {
  Acamar: 0,
  Baratas: 6,
  Daled: 17,
  Devidia: 22,
  Gemulon: 32,
  Japori: 41,
  Kravat: 50,
  Melina: 59,
  Nix: 67,
  Og: 70,
  Regulas: 82,
  Sol: 92,
  Utopia: 109,
  Zalkon: 118,
} as const;
