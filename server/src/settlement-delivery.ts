import {
  markSettlementAcked,
  markPoliceEffectAcked,
  markRelationshipEffectAcked,
  markWreckEffectAcked,
  policeApplyOwed,
  relationshipAckKey,
  allSecondaryEffectsAcked,
  createSettlementEffectAcks,
  type EncounterState,
} from './encounter-authority.js';

export interface SettlementDeliveryPorts {
  settleCaptain(args: {
    captainId: string;
    body: Record<string, unknown>;
  }): Promise<boolean>;
  applyPolice(args: {
    captainId: string;
    body: Record<string, unknown>;
  }): Promise<boolean>;
  upsertRelationship(args: {
    npcCaptainId: string;
    body: Record<string, unknown>;
  }): Promise<boolean>;
  addWreck(args: {
    systemId: string;
    body: Record<string, unknown>;
  }): Promise<boolean>;
}

/**
 * Deliver primary settle + secondary police/relationship/wreck writes with
 * independent ack tracking. Returns true when every write is acked and the
 * encounter may proceed to D1 projection.
 */
export async function deliverSettlement(
  state: EncounterState,
  nowMs: number,
  ports: SettlementDeliveryPorts,
): Promise<boolean> {
  if (!state.settlementDeltas) return false;
  if (!state.settlementEffectAcks) {
    state.settlementEffectAcks = createSettlementEffectAcks(state.settlementEffects);
  }
  const effects = state.settlementEffects;
  const acks = state.settlementEffectAcks;

  for (const delta of state.settlementDeltas) {
    const participant = state.participants.a.captainId === delta.captainId
      ? state.participants.a
      : state.participants.b;
    const award = effects?.creditsAwards[delta.captainId] ?? 0;
    const primaryAcked = participant.settlementState === 'acked'
      || participant.settlementState === 'complete';

    if (!primaryAcked) {
      const ok = await ports.settleCaptain({
        captainId: delta.captainId,
        body: {
          encounterId: state.encounterId,
          deltaHash: delta.deltaHash,
          credits: delta.creditsDelta + award,
          cargo: participant.snapshot.cargo,
          hull: delta.hull,
          shields: delta.shields,
          lifecycleAfter: delta.lifecycleAfter,
          ...(effects?.combatProfileAfter[delta.captainId] !== undefined
            ? { combatProfileAfter: effects.combatProfileAfter[delta.captainId] }
            : {}),
          ...(effects?.tradeProfileAfter[delta.captainId] !== undefined
            ? { tradeProfileAfter: effects.tradeProfileAfter[delta.captainId] }
            : {}),
        },
      });
      if (!ok) return false;
      markSettlementAcked(state, delta.captainId);
    }

    if (effects && policeApplyOwed(effects, delta.captainId) && !acks.policeAcked[delta.captainId]) {
      const policeDelta = effects.policeDeltas[delta.captainId] ?? 0;
      const ok = await ports.applyPolice({
        captainId: delta.captainId,
        body: {
          operationId: `police-${state.encounterId}-${delta.captainId}`,
          policeDelta,
          creditsAward: 0,
        },
      });
      if (!ok) return false;
      markPoliceEffectAcked(state, delta.captainId);
    }
  }

  if (effects) {
    for (const rel of effects.relationshipUpdates) {
      const key = relationshipAckKey(rel.npcCaptainId, rel.otherCaptainId);
      if (acks.relationshipAcked[key]) continue;
      const ok = await ports.upsertRelationship({
        npcCaptainId: rel.npcCaptainId,
        body: { relationship: rel.next },
      });
      if (!ok) return false;
      markRelationshipEffectAcked(state, rel.npcCaptainId, rel.otherCaptainId);
    }
    if (effects.wreck && !acks.wreckAcked) {
      const ok = await ports.addWreck({
        systemId: state.systemId,
        body: { wreck: effects.wreck },
      });
      if (!ok) return false;
      markWreckEffectAcked(state);
    }
  }

  return (
    state.participants.a.settlementState === 'acked'
    && state.participants.b.settlementState === 'acked'
    && allSecondaryEffectsAcked(state)
  );
}
