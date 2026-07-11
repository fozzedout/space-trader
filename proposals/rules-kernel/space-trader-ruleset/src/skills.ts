import { CLOAK_BONUS, MAX_SKILL, SKILL_BONUS } from './data.js';
import { CrewSkills, Difficulty, GadgetFlags } from './types.js';

export function effectiveSkills(crew: readonly CrewSkills[], gadgets: GadgetFlags = {}): CrewSkills {
  if (crew.length === 0) throw new Error('At least one crew member is required');
  const best = (key: keyof CrewSkills): number => Math.max(...crew.map((member) => member[key]));
  return {
    pilot: best('pilot') + (gadgets.navigatingSystem ? SKILL_BONUS : 0) + (gadgets.cloakingDevice ? CLOAK_BONUS : 0),
    fighter: best('fighter') + (gadgets.targetingSystem ? SKILL_BONUS : 0),
    trader: best('trader'),
    engineer: best('engineer') + (gadgets.autoRepairSystem ? SKILL_BONUS : 0),
  };
}

export function difficultyAdjustedSkill(skill: number, difficulty: Difficulty): number {
  const value = Math.max(1, Math.min(MAX_SKILL, Math.trunc(skill)));
  if (difficulty <= 1) return value + 1;
  if (difficulty === 4) return Math.max(1, value - 1);
  return value;
}

export function mercenaryDailyWage(skills: CrewSkills): number {
  return (skills.pilot + skills.fighter + skills.trader + skills.engineer) * 3;
}
