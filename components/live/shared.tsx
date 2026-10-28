"use client";

import { useEffect, useState } from "react";

import { getItemUsageTip } from "@/lib/item-synergy";
import type { LiveGameSnapshot, LiveHelpEnvelope, LiveItem, LivePlayer } from "@/lib/types";

export type Connection = "connecting" | "live" | "offline" | "error";

export function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

export function itemImage(version: string, id: number) {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${id}.png`;
}

const SPELL_KEYS: Record<string, string> = {
  flash: "SummonerFlash", ignite: "SummonerDot", teleport: "SummonerTeleport", "unleashed teleport": "SummonerTeleport",
  heal: "SummonerHeal", barrier: "SummonerBarrier", exhaust: "SummonerExhaust", cleanse: "SummonerBoost",
  ghost: "SummonerHaste", smite: "SummonerSmite", clarity: "SummonerMana", mark: "SummonerSnowball",
};

export function spellImage(version: string, name: string) {
  const key = SPELL_KEYS[name.toLowerCase().replace(/^summoner ?/, "").trim()];
  return key ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${key}.png` : null;
}

/** "Fast · medium reasoning · 3.2s · cached" — tolerant of envelopes from an older route without mode/elapsedMs/reasoning. */
export function helpMeta(help: LiveHelpEnvelope) {
  return [
    help.mode ? help.mode[0].toUpperCase() + help.mode.slice(1) : null,
    help.reasoning ? `${help.reasoning} reasoning` : null,
    typeof help.elapsedMs === "number" ? `${(help.elapsedMs / 1000).toFixed(1)}s` : null,
    help.source === "cache" ? "cached" : "generated",
  ].filter(Boolean).join(" · ");
}

/** Re-renders every `intervalMs` while `active`, returning Date.now(). */
export function useNow(intervalMs: number, active = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active]);
  return now;
}

export function ItemStrip({ items, version, champion }: { items: LiveItem[]; version: string; champion?: string }) {
  return (
    <div className="live-items">
      {items.length ? items.map((item, index) => {
        const usageTip = champion ? getItemUsageTip(champion, item.name) : "";
        return (
          <div className="live-item" key={`${item.id}-${index}`} data-tip={item.name} title={[item.name, item.description, usageTip ? `Tip: ${usageTip}` : ""].filter(Boolean).join("\n")}>
            {/* Data Dragon is Riot's public static asset catalog. */}
            <img src={itemImage(version, item.id)} alt={item.name} />
            {item.count > 1 && <span>{item.count}</span>}
          </div>
        );
      }) : <span className="empty-items">No completed inventory yet</span>}
    </div>
  );
}

export function ItemIcon({ version, id, name, size = 34 }: { version: string; id: number | null | undefined; name: string; size?: number }) {
  // data-tip: the item name shows instantly on hover (app/globals.css), not after the browser's slow title delay.
  return (
    <span className="item-tip" data-tip={name}>
      {id
        ? <img className="live-item-icon" src={itemImage(version, id)} alt={name} width={size} height={size} />
        : <span className="live-item-icon live-item-icon-fallback" style={{ width: size, height: size }}>{name.slice(0, 2).toUpperCase()}</span>}
    </span>
  );
}

export function Kda({ player }: { player: Pick<LivePlayer, "kills" | "deaths" | "assists"> }) {
  return <strong className="live-kda">{player.kills} <span>/ {player.deaths} /</span> {player.assists}</strong>;
}

/** Item ids the snapshot already knows by name (recommendations, inventories, death buys). */
export function snapshotItemIds(snapshot: LiveGameSnapshot) {
  const map = new Map<string, number>();
  const add = (name: string | undefined, id: number | undefined) => { if (name && id) map.set(name.toLowerCase(), id); };
  for (const choice of [...snapshot.recommendations, ...(snapshot.mobilityRecommendation ? [snapshot.mobilityRecommendation] : [])]) {
    add(choice.item, choice.itemId); add(choice.nextStep?.item, choice.nextStep?.itemId); add(choice.swapPlan?.sellItem, choice.swapPlan?.sellItemId);
  }
  for (const p of [snapshot.activePlayer, ...snapshot.allies, ...snapshot.enemies]) for (const item of p.items) add(item.name, item.id);
  for (const buy of snapshot.deathMoment?.buyNow || []) add(buy.item, buy.itemId);
  return map;
}
