/**
 * Boots in the role-quest boots slot. Once a role quest moves boots out of the six item slots, the Live Client API stops
 * listing them: in a 2026 draft game Boots vanished from the item list at 13:07 while move speed kept their +25, and an
 * upgrade to Berserker's Greaves later only showed as +45 move speed.
 *
 * Boots can also go straight into the slot without ever being listed (a dead-shop Berserker's: move speed 325 → 370).
 *
 * Per game (process-local, like lib/live-history.ts): the last boots seen stay owned. The player's plain move speed (see
 * `resting`) minus the champion's base (calibrated while boots are listed, else Data Dragon's) is the boots bonus: one that
 * fits a boots item while none is listed means boots in the slot, one that grew past the hidden boots' own means they were
 * upgraded, and one that dropped to nothing means they were sold.
 */

export type BootsItem = {
  id: number;
  name: string;
  price: number;
  description?: string;
  /** Data Dragon flat movement speed. */
  flat: number;
  from?: number[];
};
export type MoveStats = { moveSpeed: number; attackSpeed: number; armor: number; magicResist: number; magicPenetrationFlat: number; abilityHaste: number; abilityPower: number; attackDamage: number };
type Sample = { time: number; ms: number; key: string; dead: boolean };
type GameState = { boots: BootsItem | null; base: number | null; samples: Sample[]; settled: MoveStats | null; seen: number };

const WINDOW_SECONDS = 60;
const MIN_SAMPLES = 3;
const MAX_GAMES = 4;
const MAX_WALKING_SPEED = 550;
/** How far the measured bonus may be from a boots item's Data Dragon move speed (real boots land on it exactly). */
const FIT_TOLERANCE = 3;

const holder = globalThis as typeof globalThis & { __riftLensBootsSlotV1?: Map<string, GameState> };
const games: Map<string, GameState> = holder.__riftLensBootsSlotV1 ??= new Map();

function stateFor(gameId: string) {
  let state = games.get(gameId);
  if (!state) {
    state = { boots: null, base: null, samples: [], settled: null, seen: 0 };
    games.set(gameId, state);
    while (games.size > MAX_GAMES) games.delete(games.keys().next().value!);
  }
  return state;
}

/**
 * The player's plain move speed: the last two samples taken while dead when they agree (dead, the game reports it without
 * slows, buffs or fountain speed, so a death-shop purchase counts at once), else the most common value among this
 * inventory's samples in the window; null until it repeats often enough.
 */
function resting(samples: Sample[], key: string, now: number) {
  const [before, last] = samples.filter((sample) => sample.key === key).slice(-2);
  if (before?.dead && last?.dead && before.ms === last.ms) return last.ms;
  const counts = new Map<number, number>();
  for (const sample of samples) if (sample.key === key && now - sample.time <= WINDOW_SECONDS) counts.set(sample.ms, (counts.get(sample.ms) || 0) + 1);
  let best: [number, number] | null = null;
  for (const entry of counts) if (!best || entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0])) best = entry;
  return best && best[1] >= MIN_SAMPLES ? best[0] : null;
}

/** Stat words in an item's description that its effect on the player's stats can confirm. */
const SIGNATURES: Array<{ text: RegExp; moved: (before: MoveStats, after: MoveStats) => boolean }> = [
  { text: /attack speed/i, moved: (before, after) => after.attackSpeed - before.attackSpeed >= 0.09 },
  { text: /magic penetration/i, moved: (before, after) => after.magicPenetrationFlat - before.magicPenetrationFlat >= 8 },
  { text: /ability haste/i, moved: (before, after) => after.abilityHaste - before.abilityHaste >= 7 },
  { text: /\bmagic resist/i, moved: (before, after) => after.magicResist - before.magicResist >= 12 },
  { text: /\barmor\b/i, moved: (before, after) => after.armor - before.armor >= 15 },
];

/** Which upgrade the bonus and the stat jump point to: fitting move speed first, then the stat that moved, then the kit's damage type. */
function pickUpgrade(candidates: BootsItem[], bonus: number, before: MoveStats | null, after: MoveStats) {
  const close = Math.min(...candidates.map((item) => Math.abs(item.flat - bonus)));
  const fitting = candidates.filter((item) => Math.abs(item.flat - bonus) <= close + 2);
  const score = (item: BootsItem) => {
    const matched = before ? SIGNATURES.filter((signature) => signature.text.test(item.description || "") && signature.moved(before, after)).length : 0;
    const ap = after.abilityPower > after.attackDamage;
    const fits = /attack speed/i.test(item.description || "") ? !ap : /magic penetration/i.test(item.description || "") ? ap : false;
    return matched * 2 + (fits ? 1 : 0);
  };
  return [...fitting].sort((a, b) => score(b) - score(a) || a.price - b.price)[0] || null;
}

/**
 * The boots to count as owned this sample though the item list does not show them, or null. `visible` = boots in the item
 * list; `boots` = every boots item (plain Boots and upgrades); `percent` = the listed items' percent move speed (0.04 = 4%);
 * `baseMoveSpeed` = the champion's Data Dragon base move speed, which spots boots bought straight into the boots slot
 * (never listed: 325 → 370 on a dead-shop Berserker's) before any listed boots could calibrate it; `roleQuests` = the
 * queue has role quests (Summoner's Rift draft, not Swiftplay), the only place boots enter the slot unlisted, so a jungle
 * pet's move speed elsewhere is never taken for boots.
 */
export function slottedBoots(gameId: string, input: {
  time: number;
  stats: MoveStats;
  dead: boolean;
  visible: BootsItem | null;
  percent: number;
  boots: BootsItem[];
  baseMoveSpeed: number | null;
  roleQuests: boolean;
}): BootsItem | null {
  const state = stateFor(gameId);
  const { time, stats, visible, percent, dead } = input;
  // A replay or a reloaded game going back in time starts over.
  if (time < state.seen - 5) { state.boots = null; state.base = null; state.samples = []; state.settled = null; }
  state.seen = time;
  const boots = visible || state.boots;
  const key = `${boots?.id || 0}:${visible ? "listed" : "hidden"}:${percent.toFixed(3)}`;
  // Fountain speed (~700) is not walking speed, however long the player shops.
  if (stats.moveSpeed > 0 && stats.moveSpeed < MAX_WALKING_SPEED) {
    state.samples.push({ time, ms: Math.round(stats.moveSpeed * 100) / 100, key, dead });
    state.samples = state.samples.filter((sample) => time - sample.time <= WINDOW_SECONDS);
  }
  const speed = resting(state.samples, key, time);
  if (visible) {
    state.boots = visible;
    if (speed !== null) {
      state.base = speed / (1 + percent) - visible.flat;
      if (Math.abs(stats.moveSpeed - speed) < 0.01) state.settled = stats;
    }
    return null;
  }
  // Calibrated from listed boots beats the Data Dragon base (it already holds runes and other constant bonuses).
  const base = state.base ?? input.baseMoveSpeed;
  if (speed === null || !base) return state.boots;
  const bonus = speed / (1 + percent) - base;
  const fits = (item: BootsItem) => Math.abs(item.flat - bonus) <= FIT_TOLERANCE;
  if (!state.boots) {
    // No boots known yet: a resting bonus that fits a boots item is boots bought straight into the boots slot.
    const candidates = input.boots.filter((item) => item.flat > 0 && fits(item));
    if (input.roleQuests && bonus >= 15 && candidates.length) state.boots = pickUpgrade(candidates, bonus, state.settled, stats);
  } else if (bonus < Math.min(8, state.boots.flat / 2)) {
    state.boots = null;
  } else if (bonus > state.boots.flat + 10) {
    // Only what these boots build into, and only a move speed that fits the bonus.
    const candidates = input.boots.filter((item) => item.from?.includes(state.boots!.id) && fits(item));
    const upgrade = candidates.length ? pickUpgrade(candidates, bonus, state.settled, stats) : null;
    if (upgrade) state.boots = upgrade;
  }
  // Stats from a sample at the settled speed: the "before" an upgrade's stat jump is compared against.
  if (Math.abs(stats.moveSpeed - speed) < 0.01) state.settled = stats;
  return state.boots;
}

/** Forget every game (tests that reuse one roster for unrelated scenarios). */
export function resetBootsSlot() {
  games.clear();
}
