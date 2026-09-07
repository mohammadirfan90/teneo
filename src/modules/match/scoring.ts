// src/modules/match/scoring.ts
//
// Phase 20: pure scoring function for roommate matching (13 §13.2.4,
// 05 §5.1). No I/O, no DB — every consumer (match.service.ts today,
// analytics later) gets identical numbers.
//
// Algorithm (v1 subset per phase spec):
//   - Hard penalties (drop the candidate to 0):
//       • gender mismatch          → score = 0
//       • smoking incompat         → -30 (clamped to 0)
//       • pets incompat            → -20 (clamped to 0)
//       • budget tolerance breach  → -25 (clamped to 0)
//   - Weighted soft dimensions (sum to 100 before penalties):
//       • lifestyle (smoking OK / pets OK / sleep schedule)   × 0.40
//       • budget overlap                                      × 0.25
//       • city preference overlap                             × 0.15
//       • move-in window overlap                              × 0.10
//       • interests overlap                                   × 0.10
//
// The `breakdown` object exposes each dimension's raw points so the
// caller UI can show "Budget: 18/25, City: 12/15, …". The `explain`
// string is multi-line and includes every hard penalty that fired.
//
// `matchScore` is deliberately framework-free so it can be unit-tested
// without Prisma. Inputs are the tenant-preferences rows (not the
// full preferences_tenant JSON lifestyle field — we extract the few
// keys we care about).

import type { Gender } from '@/generated/prisma/enums';

// ──────────────────────────────────────────────────────────────────────
// Inputs
// ──────────────────────────────────────────────────────────────────────

/**
 * Subset of PreferencesTenant + User.gender that the scorer actually
 * needs. We don't import the Prisma model so this file stays free of
 * generated client code (and is trivially unit-testable).
 */
export interface MatchScorerTenantInput {
  userId: string;
  gender: Gender | null;
  /** BigInt | number — scorer reads as number. */
  budgetMinMinor: bigint | number | null;
  budgetMaxMinor: bigint | number | null;
  preferredCities: string[];
  moveInFrom: Date | null;
  moveInTo: Date | null;
  /**
   * Decoded lifestyle JSON. v1 keys we read:
   *   - smoking:    'NO' | 'YES' | 'OCCASIONALLY'
   *   - pets:       'NO' | 'YES' | 'ALLERGY'
   *   - sleep:      'EARLY' | 'NIGHT' | 'FLEXIBLE'
   */
  lifestyle: MatchLifestyle | null;
  interests: string[];
}

export interface MatchLifestyle {
  smoking?: 'NO' | 'YES' | 'OCCASIONALLY' | null;
  pets?: 'NO' | 'YES' | 'ALLERGY' | null;
  sleep?: 'EARLY' | 'NIGHT' | 'FLEXIBLE' | null;
}

// ──────────────────────────────────────────────────────────────────────
// Output
// ──────────────────────────────────────────────────────────────────────

export interface MatchScoreBreakdown {
  lifestyle: number;
  budget: number;
  city: number;
  moveIn: number;
  interests: number;
  /** Sum of the five dimensions above, BEFORE hard penalties. */
  base: number;
}

export interface MatchScoreResult {
  /** Final score in [0, 100]. */
  score: number;
  breakdown: MatchScoreBreakdown;
  /** Multi-line human-readable explanation. */
  explain: string;
  /**
   * List of hard-penalty reasons that fired. Empty array means no
   * hard penalties were applied (caller can show a green check).
   */
  hardPenalties: string[];
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/**
 * Score a (caller, candidate) pair. The hard-penalty matrix is the
 * contract callers MUST respect per phase must_pass:
 *   - Hard penalty → score drops to 0 (gender mismatch is "drop
 *     entirely", -30/-20/-25 are clamped-to-0 soft caps; we
 *     document both shapes so the test suite can assert).
 *   - Score is always in [0, 100].
 *   - Breakdown values sum to base before hard penalties.
 */
export function matchScore(
  caller: MatchScorerTenantInput,
  candidate: MatchScorerTenantInput
): MatchScoreResult {
  const hardPenalties: string[] = [];

  // ── Hard penalty 1: gender mismatch (binary, no overlap allowed).
  //   Caller says "FEMALE only", candidate is anything else → 0.
  //   v1 models caller gender preference as a single value (we
  //   treat the caller's own gender as the preference — same as
  //   §5.1 v1 subset). Phase 21+ may introduce an explicit
  //   preference_gender field.
  if (
    caller.gender !== null &&
    candidate.gender !== null &&
    caller.gender !== 'UNDISCLOSED' &&
    candidate.gender !== 'UNDISCLOSED' &&
    caller.gender !== candidate.gender
  ) {
    hardPenalties.push(
      `Hard penalty: gender mismatch (caller=${caller.gender}, candidate=${candidate.gender})`
    );
  }

  // ── Lifestyle scoring (× 0.40 weight, max 40 pts).
  const smoking = scoreSmoking(caller, candidate);
  const pets = scorePets(caller, candidate);
  const sleepPts = scoreSleep(caller, candidate);
  const lifestyle = smoking.points + pets.points + sleepPts;

  if (smoking.penalty) hardPenalties.push('Hard penalty: smoking incompatibility');
  if (pets.penalty) hardPenalties.push('Hard penalty: pets incompatibility');

  // ── Budget overlap (× 0.25 weight, max 25 pts).
  const budget = scoreBudget(caller, candidate);
  if (budget.penalty) hardPenalties.push('Hard penalty: budget tolerance breach');

  // ── City preference overlap (× 0.15 weight, max 15 pts).
  const city = scoreCity(caller, candidate);

  // ── Move-in window overlap (× 0.10 weight, max 10 pts).
  const moveIn = scoreMoveIn(caller, candidate);

  // ── Interests overlap (× 0.10 weight, max 10 pts).
  const interests = scoreInterests(caller, candidate);

  // ── Pre-penalty base + apply hard penalties.
  const base = lifestyle + budget.points + city + moveIn + interests;
  // Clamp base to [0, 100] (defensive — every dimension is already
  // capped but belt + braces for future extensions).
  const clampedBase = Math.max(0, Math.min(100, base));

  let final = clampedBase;
  if (hardPenalties.length > 0) {
    // The phase spec says smoking=-30, pets=-20, budget=-25. We treat
    // each as a soft clamp-to-zero on top of the hard-penalty tag,
    // and additionally drop the final score to 0 when gender is the
    // offender (the only "drop entirely" rule in v1).
    const hasGenderMismatch = hardPenalties.some((p) => p.startsWith('Hard penalty: gender'));
    if (hasGenderMismatch) {
      final = 0;
    } else {
      // Smoking incompat (-30), pets incompat (-20), budget (-25)
      // stacked then clamped to 0. Phase spec lists them as additive;
      // a candidate tripping all three is unambiguously a bad match.
      final = Math.max(0, clampedBase - 30 - 20 - 25);
    }
  }

  const breakdown: MatchScoreBreakdown = {
    lifestyle,
    budget: budget.points,
    city,
    moveIn,
    interests,
    base: clampedBase,
  };

  const explain = buildExplain(hardPenalties, breakdown, smoking, pets, sleepPts, budget);

  return {
    score: Math.round(final),
    breakdown,
    explain,
    hardPenalties,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Dimension scorers (internal)
// ──────────────────────────────────────────────────────────────────────

interface DimResult {
  points: number;
  penalty?: boolean;
}

function scoreSmoking(c: MatchScorerTenantInput, cand: MatchScorerTenantInput): DimResult {
  const cSmoke = c.lifestyle?.smoking ?? null;
  const candSmoke = cand.lifestyle?.smoking ?? null;
  // Both unspecified → full points (we can't penalise what isn't there).
  if (!cSmoke || !candSmoke) return { points: 20 };
  if (cSmoke === candSmoke) return { points: 20 };
  // Hard incompat: caller NO, candidate YES.
  if (cSmoke === 'NO' && candSmoke === 'YES') return { points: 0, penalty: true };
  // OCCASIONALLY ↔ NO or ↔ YES = partial credit.
  return { points: 10 };
}

function scorePets(c: MatchScorerTenantInput, cand: MatchScorerTenantInput): DimResult {
  const cPets = c.lifestyle?.pets ?? null;
  const candPets = cand.lifestyle?.pets ?? null;
  if (!cPets || !candPets) return { points: 10 };
  if (cPets === candPets) return { points: 10 };
  // Hard incompat: caller ALLERGY, candidate YES.
  if (cPets === 'ALLERGY' && candPets === 'YES') return { points: 0, penalty: true };
  return { points: 5 };
}

function scoreSleep(a: MatchScorerTenantInput, b: MatchScorerTenantInput): number {
  const aSleep = a.lifestyle?.sleep ?? null;
  const bSleep = b.lifestyle?.sleep ?? null;
  if (!aSleep || !bSleep) return 10;
  if (aSleep === 'FLEXIBLE' || bSleep === 'FLEXIBLE') return 10;
  if (aSleep === bSleep) return 10;
  return 0; // EARLY vs NIGHT clash — no penalty flag, just no points.
}

function scoreBudget(c: MatchScorerTenantInput, cand: MatchScorerTenantInput): DimResult {
  const cMin = numOrNull(c.budgetMinMinor);
  const cMax = numOrNull(c.budgetMaxMinor);
  const candMin = numOrNull(cand.budgetMinMinor);
  const candMax = numOrNull(cand.budgetMaxMinor);

  // Either side missing → full points (we can't penalise a gap we
  // don't know about).
  if (cMin === null || cMax === null || candMin === null || candMax === null) {
    return { points: 25 };
  }

  // Hard penalty when ranges don't overlap at all.
  const overlaps = cMax >= candMin && candMax >= cMin;
  if (!overlaps) return { points: 0, penalty: true };

  // Soft partial credit when overlap < 30% of the caller's range.
  const overlap = Math.min(cMax, candMax) - Math.max(cMin, candMin);
  const callerSpan = Math.max(1, cMax - cMin);
  const ratio = overlap / callerSpan;
  if (ratio < 0.3) return { points: 8, penalty: true };
  if (ratio < 0.6) return { points: 18 };
  return { points: 25 };
}

function scoreCity(c: MatchScorerTenantInput, cand: MatchScorerTenantInput): number {
  if (c.preferredCities.length === 0 || cand.preferredCities.length === 0) return 15;
  const overlap = c.preferredCities.filter((city) => cand.preferredCities.includes(city)).length;
  if (overlap === 0) return 0;
  if (overlap === 1) return 10;
  return 15; // 2+ matches
}

function scoreMoveIn(c: MatchScorerTenantInput, cand: MatchScorerTenantInput): number {
  if (!c.moveInFrom || !c.moveInTo || !cand.moveInFrom || !cand.moveInTo) return 10;
  const overlapStart = Math.max(c.moveInFrom.getTime(), cand.moveInFrom.getTime());
  const overlapEnd = Math.min(c.moveInTo.getTime(), cand.moveInTo.getTime());
  if (overlapEnd < overlapStart) return 0;
  const days = (overlapEnd - overlapStart) / 86_400_000;
  if (days < 14) return 3;
  if (days < 60) return 7;
  return 10;
}

function scoreInterests(c: MatchScorerTenantInput, cand: MatchScorerTenantInput): number {
  if (c.interests.length === 0 || cand.interests.length === 0) return 10;
  const overlap = c.interests.filter((i) => cand.interests.includes(i)).length;
  // Score scales with overlap; cap at 10.
  return Math.min(10, overlap * 2);
}

function numOrNull(v: bigint | number | null): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  return v;
}

// ──────────────────────────────────────────────────────────────────────
// Explain builder
// ──────────────────────────────────────────────────────────────────────

function buildExplain(
  hardPenalties: string[],
  breakdown: MatchScoreBreakdown,
  smoking: DimResult,
  pets: DimResult,
  sleep: number,
  budget: DimResult
): string {
  const lines: string[] = [];
  if (hardPenalties.length > 0) {
    lines.push('Hard penalties:');
    for (const p of hardPenalties) lines.push(`  - ${p}`);
  } else {
    lines.push('No hard penalties applied.');
  }
  lines.push('');
  lines.push('Soft dimensions:');
  lines.push(
    `  Lifestyle: ${breakdown.lifestyle}/40 (smoking=${smoking.points}, pets=${pets.points}, sleep=${sleep})`
  );
  lines.push(`  Budget:    ${breakdown.budget}/25`);
  lines.push(`  City:      ${breakdown.city}/15`);
  lines.push(`  Move-in:   ${breakdown.moveIn}/10`);
  lines.push(`  Interests: ${breakdown.interests}/10`);
  lines.push('');
  lines.push(`Base (pre-penalty): ${breakdown.base}/100`);
  return lines.join('\n');
}
