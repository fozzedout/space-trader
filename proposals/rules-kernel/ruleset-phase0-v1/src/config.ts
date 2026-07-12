/** Named executable configuration pin for Phase 0 (design §16.5). */
export const RULESET_VERSION = 'ruleset-phase0-v1' as const;
export const PRNG_VERSION = 'sto-xorshift32-v1' as const;

export type RulesetVersion = typeof RULESET_VERSION;

export const PHASE0_TUNING = {
  approachTicksMin: 15,
  approachTicksMax: 20,
  travelWindowMs: 5_000,
  maxOccupancyLifetimeMs: 120_000,
  minTravelTickIntervalMs: 250,
  encounterClaimTimeoutMs: 8_000,
  disconnectGraceMs: 8_000,
  tradeReservationMs: 5_000,
  reservationReconcileMs: 60_000,

  hostilityMinor: 5,
  hostilityMajor: 10,
  hostilityBetrayal: 50,
  surrenderMercyHostility: -10,
  hostilityDecayGraceMs: 86_400_000,
  hostilityDecayPerDay: 1,

  companionHostileWeightFactorBps: 4_000,

  cargoSurvivalPercent: 50,
  wreckLifetimeMs: 3_600_000,
  escapePodRecoveryMs: 300_000,

  crimeAttemptedPiracy: 8,
  crimeCompletedTheftBase: 15,
  crimeCompletedTheftMax: 45,
  crimeUnprovokedAttack: 12,
  crimeUnlawfulDestruction: 25,
  crimeEscapePodAttack: 20,
  crimeFleeInspection: 5,
  crimeAttackPolice: 20,
  crimeDestroyPolice: 40,

  baseWantedBounty: 500,
  bountyPerSeverityPoint: 50,
  rehabStandingPerSeverity: 1,
  wantedKillerRehabMultiplier: 2_000, // 2.0 in milli-units

  stockEffectMaxBps: 2_500,
  pressureMaxBps: 1_500,
  totalEffectMaxBps: 4_000,
  buyPressureStepBps: 40,
  sellPressureStepBps: 40,
  stockRecoveryRateBps: 500, // 5% of remaining gap per recovery period
  pressureDecayRateBps: 1_000, // 10% of remaining pressure per recovery period
  recoveryPeriodMs: 60_000,

  policePassWeight: 40,
  policeInspectionWeight: 45,
  policeSurrenderOrderWeight: 12,
  policeAttackOnSightWeight: 3,
  /** Base chance (out of 10_000) a routine police-contact check fires on a travel tick; scaled by local police presence. */
  policeContactCheckProbabilityBps: 1_000,
  inspectionFinePerIllegalUnit: 100,
  policeSurrenderFineBase: 500,

  outmatchStrengthThresholdBps: 6_500, // self/other * 10000; below = clearly outmatched

  npcDemandCreditsFractionBps: {
    passive: 1_000,
    neutral: 2_500,
    aggressive: 5_000,
  },
  npcSurrenderClaimFractionBps: {
    passive: 0,
    neutral: 3_000,
    aggressive: 7_000,
  },
  npcTradeMarkupBps: {
    passive: -500,
    neutral: 0,
    aggressive: 1_000,
  },
  npcNeutralActionWeights: {
    tradeOffer: 35,
    hail: 20,
    ignore: 20,
    demand: 10,
    attack: 5,
    flee: 10,
  },
  npcHostileActionWeights: {
    aggressive: { demand: 40, attack: 35, hail: 10, ignore: 5, flee: 10 },
    neutral: { hail: 25, ignore: 30, demand: 10, attack: 10, flee: 25 },
    passive: { flee: 50, ignore: 30, hail: 15, demand: 0, attack: 5 },
  },
  npcFavourableActionWeights: {
    hail: 40,
    tradeOffer: 40,
    ignore: 20,
  },
  activeNpcPopulationTarget: 24,
} as const;

export type Phase0Tuning = typeof PHASE0_TUNING;
