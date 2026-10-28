"use client";

import { useMemo, useRef } from "react";

import type { LiveGameSnapshot, LiveHelpEnvelope, LiveItem, LiveResolvedBuy } from "@/lib/types";

/** AI picks go stale after this much game time. */
export const AI_TTL_SECONDS = 180;
export const MODE_LABEL: Record<string, string> = { fast: "Ask coach", deep: "deep read", death: "death read", pregame: "game plan" };

export type AiRead = {
  help: LiveHelpEnvelope;
  buys: LiveResolvedBuy[];
  /** Game seconds since the read was generated, or null for older envelopes without a game time. */
  age: number | null;
  /** Why the read no longer applies (bought the item, too old, …), or null while it is still live. */
  expired: string | null;
  label: string;
  /** The read's words (summary, next-five-minutes) still apply: not too old and nothing bought — even if it had no item picks. */
  textLive: boolean;
};

const counts = (items: LiveItem[]) => {
  const map = new Map<number, number>();
  for (const item of items) map.set(item.id, (map.get(item.id) ?? 0) + Math.max(1, item.count));
  return map;
};

/**
 * Re-checks AI picks against the inventory *now* (every poll): an AI answer can land 30–60s after the request,
 * often after the player already shopped. Owned goals are dropped; a component pick is replaced by the engine's
 * live next piece toward the same goal (it accounts for components already bought); a held component is dropped.
 */
export function refreshBuys(buys: LiveResolvedBuy[], snapshot: LiveGameSnapshot): LiveResolvedBuy[] {
  const now = counts(snapshot.activePlayer.items);
  const gold = Math.max(0, Math.floor(snapshot.activePlayer.currentGold));
  const engine = [...snapshot.recommendations, ...(snapshot.mobilityRecommendation ? [snapshot.mobilityRecommendation] : [])];
  const price = (buy: LiveResolvedBuy, cost: number) => ({ ...buy, cost, affordable: gold >= cost, goldNeeded: Math.max(0, cost - gold) });
  return buys.flatMap((buy) => {
    if ((now.get(buy.targetItemId) ?? 0) > 0) return [];
    if (buy.itemId === buy.targetItemId) return [price(buy, buy.cost)];
    const step = engine.find((entry) => entry.itemId === buy.targetItemId)?.nextStep;
    if (step) return [price({ ...buy, itemId: step.itemId, item: step.item }, step.cost)];
    return (now.get(buy.itemId) ?? 0) > 0 ? [] : [price(buy, buy.cost)];
  });
}

/**
 * Freshness of the newest AI read for this game. A read expires after AI_TTL_SECONDS of game time,
 * when the player buys one of its suggestions, or when none of its picks matched Riot's catalog.
 * `live` is the read while still valid; `read` is kept even when expired (for the "outdated" note).
 */
const NO_ITEMS: LiveItem[] = [];

export function useAiRead(help: LiveHelpEnvelope | null, snapshot: LiveGameSnapshot | null): { read: AiRead | null; live: AiRead | null } {
  const items = snapshot?.activePlayer.items ?? NO_ITEMS;
  const gameTime = snapshot?.game.time ?? 0;
  // Inventory when this AI read first showed up: a later increase of a suggested item means the player bought it.
  const helpId = help ? `${help.cacheKey}:${help.generatedAt}:${help.mode}` : null;
  // A ref, not state: recording the baseline must not trigger a render (it is only read for the same read id).
  const baselineRef = useRef<{ id: string | null; counts: Map<number, number> }>({ id: null, counts: new Map() });
  if (helpId !== baselineRef.current.id) baselineRef.current = { id: helpId, counts: counts(items) };
  const baseline = baselineRef.current;

  const read = useMemo<AiRead | null>(() => {
    if (!help || !snapshot) return null;
    const original: LiveResolvedBuy[] = Array.isArray(help.buys) ? help.buys : [];
    const buys = refreshBuys(original, snapshot);
    const age = typeof help.gameTime === "number" ? Math.max(0, gameTime - help.gameTime) : null;
    const now = counts(items);
    const sameRead = baseline.id === helpId;
    const gained = (id: number) => sameRead && (now.get(id) ?? 0) > (baseline.counts.get(id) ?? 0);
    const owns = (id: number) => (now.get(id) ?? 0) > 0;
    const bought = original.flatMap((buy) => owns(buy.targetItemId) ? [buy.targetItem] : gained(buy.itemId) ? [buy.item] : [])[0];
    const expired = bought && !buys.length ? `you already have ${bought}`
      : age === null ? "older read without a game time"
        : age >= AI_TTL_SECONDS ? `${Math.floor(age / 60)}+ min of game since`
          : !original.length ? "no item picks matched Riot's catalog"
            : !buys.length ? "you already bought everything it suggested" : null;
    const textLive = !bought && age !== null && age < AI_TTL_SECONDS;
    return { help, buys, age, expired, label: MODE_LABEL[help.mode] ?? "AI read", textLive };
  }, [help, helpId, baseline, gameTime, items, snapshot]);

  return { read, live: read && !read.expired ? read : null };
}
