"use client";

import { Sparkles } from "lucide-react";
import type { BuildItemVerdict, BuildReview, Player } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const unrated = (player: Player, index: number): BuildItemVerdict => ({
  itemId: player.itemIds[index] ?? 0,
  item: player.items[index] ?? "Item",
  kind: "unrated",
  tone: "info",
  label: "Not checked",
  reason: "Upload this replay to Rift Lens to compare the build with the top build and the enemy team's items.",
});

/** Final inventory with Rift Lens's verdict per item (lib/replay-build-review.ts), the top build it was compared to, and build findings. */
export function ItemBuild({ player, build, version }: { player: Player; build: BuildReview | null; version: string }) {
  const verdicts = player.items.map((_, index) => build?.items[index] ?? unrated(player, index));
  const findings = build?.findings ?? [];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="eyebrow">Final build</span>
        <span className="text-xs text-slate-500">Hover an item for the verdict</span>
      </div>
      <div className="flex flex-wrap gap-2.5">
        {verdicts.map((verdict, index) => (
          <Tooltip key={`${verdict.item}-${index}`}>
            <TooltipTrigger asChild>
              <button className={`item-tile item-${verdict.tone}`} aria-label={`${verdict.item}: ${verdict.label}`}>
                <span className="item-fallback">{verdict.item.slice(0, 1)}</span>
                {verdict.itemId ? (
                  <img
                    alt=""
                    src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${verdict.itemId >= 100000 ? verdict.itemId % 10000 : verdict.itemId}.png`}
                    onError={(event) => { event.currentTarget.style.display = "none"; }}
                  />
                ) : <Sparkles size={19} />}
                <span className={`verdict-dot dot-${verdict.tone}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <div className="max-w-64 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <strong className="text-sm text-white">{verdict.item}</strong>
                  <Badge tone={verdict.tone}>{verdict.label}</Badge>
                </div>
                <p className="text-xs leading-5 text-slate-300">{verdict.reason}</p>
              </div>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      {build?.topBuild && (
        <div className="mt-4">
          <span className="eyebrow">{build.topBuild.label}{build.topBuild.builtFor ? ` (made for ${build.topBuild.builtFor.toLowerCase()})` : ""}</span>
          <div className="top-build-row">
            {build.topBuild.slots.map((slot) => (
              <span key={slot.label} className={`top-build-slot${slot.matched ? " hit" : ""}`}>
                <b>{slot.label}</b>{slot.matched ?? slot.options.slice(0, 2).join(" / ")}
              </span>
            ))}
          </div>
        </div>
      )}
      {build && !build.topBuild && (
        <p className="mt-3 text-xs text-slate-500">No top build is saved for {player.champion} in this role yet, so items are only checked for fit and counters.</p>
      )}

      {findings.length > 0 && (
        <ul className="finding-list">
          {findings.map((finding) => (
            <li key={`${finding.kind}-${finding.title}`} className={`finding-${finding.tone}`}>
              <strong>{finding.title}</strong>
              <p>{finding.detail}</p>
            </li>
          ))}
        </ul>
      )}
      {build && !findings.length && <p className="mt-3 text-xs text-emerald-300">No build mistakes found against the top build and the enemy team.</p>}
      {build && build.enemySignals.length > 0 && (
        <p className="enemy-signals"><strong className="text-slate-400">Enemy team (final items):</strong> {build.enemySignals.join(" · ")}</p>
      )}
    </div>
  );
}
