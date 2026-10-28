// "How to use it" tips generated from each item's own passive/active text (Data Dragon item descriptions), the same
// for every champion. One short line per item mechanic (stasis, spell shield, Spellblade, Grievous Wounds, Lifeline,
// ally heal/shield, Energized, on-hit, execute, burn, ultimate trigger, takedown, ramp-up…); items whose text has no
// mechanic to play around get no tip. The patterns are game-mechanic wording, never champion or item names.
//
// Pure module (client components use it too). On the server the live item catalog registers this patch's tips
// (registerItemTips); without that (the browser, or before the catalog loads) the generated table
// lib/item-tips-data.ts (scripts/build-item-tips.ts, from the same rules) answers.
import { ITEM_TIPS } from "@/lib/item-tips-data";

const key = (value = "") => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Item description → plain text without the <stats> block (the stats themselves have nothing to "use"). */
function bodyText(description = "") {
  return description
    .replace(/<stats>[\s\S]*?<\/stats>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

type Rule = { test: (text: string, active: boolean) => boolean; tip: (text: string) => string };
const has = (pattern: RegExp) => (text: string) => pattern.test(text);

/** First matching rule wins: the most specific mechanics first, generic ones (an active, ramp-up) last. */
const RULES: Rule[] = [
  { test: has(/enter stasis/), tip: () => "Stasis: commit your damage or crowd control first, then press it as the enemy collapses on you." },
  { test: has(/upon taking lethal damage/), tip: () => "Play more aggressively only while the revive is up, and check its cooldown before the next objective fight." },
  { test: has(/spell shield/), tip: () => "The spell shield blocks the next enemy ability: let it recharge before a risky angle and don't waste it on dodgeable poke." },
  { test: has(/remove\w* all crowd control/), tip: (text) => /\bally\b|allied/.test(text)
    ? "Save the cleanse for the disable that stops your carry from acting, not for minor crowd control."
    : "Hold the cleanse for the lockdown that would kill you (it does not remove Airborne effects)." },
  { test: has(/wounds/), tip: (text) => /when struck/.test(text)
    ? "Its Grievous Wounds apply when they attack you: be the target their healing carry has to hit."
    : "Apply Grievous Wounds before their big heal and keep it refreshed on the healer, not on a random target." },
  { test: has(/designate an ally/), tip: () => "Bind it to your main carry and stay next to them so you soak part of the damage they take." },
  { test: has(/after using an ability, your next attack/), tip: () => "Weave one basic attack after each ability so Spellblade is never left unused." },
  { test: has(/below 30% (?:health|causes)|reduce your health below/), tip: () => "Its emergency shield/heal fires on its own when you drop low: fight while it is ready and note its cooldown after." },
  { test: (text, active) => active && /\ballies\b|allied/.test(text) && /move speed/.test(text) && !/shield|restore|heal/.test(text), tip: () => "Use it to start (or escape) a fight together: every nearby ally gets the speed." },
  { test: (text, active) => active && /\ballies\b|allied|\bally\b/.test(text) && /shield|restore|heal/.test(text), tip: (text) => /after \d+(?:\.\d+)? seconds/.test(text)
    ? "Cast it where the fight is going to be: the effect lands after a delay."
    : "Pop it as the enemy engage lands so it covers your team when they need it, not before." },
  { test: has(/healing or shielding an ally/), tip: () => "Keep healing or shielding allies through the fight: the item pays off over many casts, not one spell." },
  { test: has(/on immobilizing an enemy|slowing or immobilizing an enemy/), tip: () => "Land your crowd control first: the mark/bonus starts when you slow or immobilize a champion." },
  { test: has(/excess healing/), tip: () => "Top up on a safe wave or camp before a fight so the overheal shield is already up." },
  { test: has(/energized attack/), tip: () => "Moving and attacking charges the Energized attack: release it on a champion, not a minion." },
  { test: has(/every (?:second|third|fourth|fifth|\d+(?:st|nd|rd|th)) attack/), tip: () => "Count your attacks: land the empowered one on a champion, not a minion." },
  { test: has(/nearby for a few seconds/), tip: () => "Stay near an enemy champion for a few seconds, then hit them to cash in the empowered attack." },
  { test: has(/on-hit/), tip: () => "Its damage comes from basic attacks: keep weaving attacks between your abilities." },
  { test: has(/600 range or greater|how far away/), tip: () => "Open from long range to trigger it, then follow up with your combo." },
  { test: has(/(?:increased damage|bonus damage|critically strike)[^.]*below \d+% health|below \d+% health[^.]*(?:increased damage|critically strike)|executes/), tip: () => "A finisher: save a reliable damage ability for enemies dropping low." },
  { test: has(/(?:damaging abilities|ability damage).*\b(?:burn|per second|for \d+ seconds)\b|\bburn\w*\b.*abilit/), tip: () => "Spread ability damage over several enemies and keep reapplying it in longer fights." },
  { test: has(/immolate|deal magic damage (?:per second )?to nearby enemies/), tip: () => "The burn needs you close: stay in the middle of the fight to keep it ticking." },
  { test: has(/(?:casting|after casting|with) your ultimate|ultimate ability's/), tip: () => "Play around your ultimate: casting it is what triggers this item." },
  { test: has(/attack range/), tip: () => "Use the extra range to hit them from safety." },
  { test: has(/manaflow|transforms into/), tip: () => "Stack it early: land attacks and abilities on champions to finish the transformation sooner." },
  { test: has(/takedowns? grant|lost on death/), tip: () => "Stacks are lost on death: play safer while you are stacked." },
  { test: has(/reduces? (?:the target's|their) (?:armor|magic resist)|reducing their magic resist/), tip: () => "Stick to one target so the resistance shred stacks fully before you switch." },
  { test: has(/a champion that you damaged (?:recently|within \d+ seconds) dies|champion kills grant/), tip: () => "Its bonus comes on takedowns: make sure you damaged the target shortly before it dies." },
  { test: has(/not tak\w+ (?:magic )?damage|have not taken damage/), tip: () => "It recharges while you avoid damage: take the next fight once it is back up." },
  { test: has(/(?:moving|attacking|dealing (?:magic or true )?damage|after taking|after dealing).{0,60}move speed|move speed.{0,40}after/), tip: () => "Use the move speed you gain in fights to kite, chase or reposition." },
  { test: has(/for each second in combat|seconds of champion combat|while in combat with champions/), tip: () => "It ramps up over a fight: it rewards staying in extended fights rather than one quick trade." },
  { test: has(/damaging abilities/), tip: () => "It triggers on ability damage: lead with the ability you land most reliably." },
  { test: (_text, active) => active, tip: () => "Has an active: keep it on a comfortable key and use it on purpose, not on cooldown." },
];

/**
 * One "how to use it" line from an item's Data Dragon description (with markup), or "" when it has no mechanic to use.
 * Consumables and trinkets (Data Dragon tags) get none: their use is obvious.
 */
export function itemUsageTip(description = "", tags: readonly string[] = []): string {
  if (tags.includes("Consumable") || tags.includes("Trinket")) return "";
  const active = /<active>/i.test(description);
  const text = bodyText(description);
  if (!text) return "";
  for (const rule of RULES) if (rule.test(text, active)) return rule.tip(text);
  return "";
}

// Server registry (globalThis so `next dev` reloads keep it): this patch's tips from the live item catalog.
type Registry = { byKey: Map<string, string>; version: string | null };
const registry: Registry = ((globalThis as { __riftLensItemTipsV1?: Registry }).__riftLensItemTipsV1 ??= { byKey: new Map(), version: null });

/** Registers this patch's tips (called once per Data Dragon catalog load). */
export function registerItemTips(version: string, items: Array<{ name: string; usageTip?: string }>) {
  registry.byKey = new Map(items.filter((item) => item.name).map((item) => [key(item.name), item.usageTip || ""]));
  registry.version = version;
}

/**
 * How to use an item. `champion` is accepted for callers that pass it, but tips come from the item's own text and are
 * the same for every champion.
 */
export function getItemUsageTip(champion: string, itemName: string) {
  void champion;
  const wanted = key(itemName);
  if (!wanted) return "";
  return registry.byKey.get(wanted) ?? ITEM_TIPS[wanted] ?? "";
}
