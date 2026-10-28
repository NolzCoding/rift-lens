"use client";

import type { ReactNode } from "react";
import { CircleDollarSign, Clock3, Flame, Skull, Sparkles } from "lucide-react";

import { formatTime, Kda, type Connection } from "@/components/live/shared";
import { csText } from "@/lib/live-coach";
import type { LiveGameSnapshot } from "@/lib/types";

export function CommandBar({ snapshot, connection, mock }: { snapshot: LiveGameSnapshot; connection: Connection; mock: string | null }) {
  const active = snapshot.activePlayer;
  return (
    <section className={`live-command-bar ${active.isDead ? "is-dead" : ""}`}>
      <div className="live-player-identity">
        <div className="champion-avatar champion-avatar-large">{active.champion.slice(0, 2).toUpperCase()}</div>
        <div>
          <span className="eyebrow">You are playing</span>
          <h1>{active.champion} <small>· {active.position}{snapshot.matchup.basis !== "riot-position" ? " · inferred" : ""}</small></h1>
          <p>{active.name}</p>
        </div>
      </div>
      <div className="live-primary-stats">
        <div><span>KDA</span><Kda player={active} /></div>
        <div><span>Level</span><strong>{active.level}</strong></div>
        <div title="Riot updates CS in steps of 10"><span>CS</span><strong>{csText(active.cs)}</strong></div>
        <div><span>Gold</span><strong className="gold"><CircleDollarSign size={14} />{Math.floor(active.currentGold)}</strong></div>
      </div>
      <div className="live-clock">
        <span><Clock3 size={13} /> {snapshot.game.modeLabel}</span>
        <strong>{formatTime(snapshot.game.time)}</strong>
        <small className={mock ? "is-mock" : connection === "live" ? "" : "is-stale"}>{mock ? `Mock fixture · ${mock}` : connection === "live" ? "Live · 2.5s refresh" : "Reconnecting"}</small>
      </div>
      <ObjectiveStrip snapshot={snapshot} />
    </section>
  );
}

function ObjectiveStrip({ snapshot }: { snapshot: LiveGameSnapshot }) {
  const time = snapshot.game.time;
  const objectives = snapshot.objectives || [];
  const dragons = snapshot.dragonState;
  if (!objectives.length && !dragons) return null;
  return (
    <div className="objective-strip">
      {objectives.map((objective) => {
        const remaining = objective.nextSpawnAt != null ? objective.nextSpawnAt - time : null;
        const up = objective.status === "up" || (remaining != null && remaining <= 0);
        const soon = !up && remaining != null && remaining <= 60;
        return (
          <div key={objective.id} className={`objective-chip ${up ? "is-up" : soon ? "is-soon" : ""} ${objective.status === "unknown" || objective.status === "taken" ? "is-unknown" : ""}`} title={objective.note || objective.label}>
            <span>{objective.label}</span>
            <strong>{up ? "UP" : remaining != null ? formatTime(remaining) : objective.status === "taken" ? "TAKEN" : "—"}</strong>
          </div>
        );
      })}
      {dragons && (
        <div className={`dragon-tally ${dragons.soulPoint ? `soul-${dragons.soulPoint}` : ""}`} title={[...dragons.alliedDragons.map((d) => `You: ${d}`), ...dragons.enemyDragons.map((d) => `Enemy: ${d}`)].join("\n") || "No dragons taken"}>
          <Flame size={13} />
          <span className="ally">{dragons.alliedDragons.length}</span>
          <small>–</small>
          <span className="enemy">{dragons.enemyDragons.length}</span>
          {dragons.soulType && <em>{dragons.soulType} rift</em>}
          {dragons.soulPoint && <b>{dragons.soulPoint === "both" ? "Both on soul point" : dragons.soulPoint === "ally" ? "You: soul point" : "Enemy: soul point"}</b>}
        </div>
      )}
    </div>
  );
}

function penLabel(flat: number, percent: number) {
  // lib/live-game.ts already normalises Riot's multiplier to a 0–100 percentage.
  const pct = Math.round(percent);
  return [flat > 0 ? Math.round(flat) : null, pct > 0 ? `${pct}%` : null].filter(Boolean).join(" · ");
}

export function VitalsAndStats({ snapshot, right }: { snapshot: LiveGameSnapshot; right?: ReactNode }) {
  const active = snapshot.activePlayer;
  const stats = active.stats;
  const healthPercent = active.maxHealth ? Math.max(0, Math.min(100, active.health / active.maxHealth * 100)) : 0;
  const resourcePercent = active.maxResource ? Math.max(0, Math.min(100, active.resource / active.maxResource * 100)) : 0;
  const magicPen = stats ? penLabel(stats.magicPenetrationFlat, stats.magicPenetrationPercent) : "";
  const armorPen = stats ? penLabel(stats.armorPenetrationFlat, stats.armorPenetrationPercent) : "";
  const abilities = active.abilityLevels;
  const keystone = active.runes?.keystone || active.keystone;
  return (
    <>
      <div className="live-vitals">
        <div className="live-health">
          <span style={{ width: `${healthPercent}%` }} />
          <small>{active.isDead ? <><Skull size={11} /> Dead</> : `${Math.round(active.health)} / ${Math.round(active.maxHealth)} HP`}</small>
        </div>
        {active.maxResource > 0 && <div className="live-resource"><span style={{ width: `${resourcePercent}%` }} /><small>{Math.round(active.resource)} / {Math.round(active.maxResource)} resource</small></div>}
      </div>
      <div className="live-statline">
        {stats && (
          <div className="stat-chips">
            {stats.abilityPower > 0 && <span><b>AP</b>{Math.round(stats.abilityPower)}</span>}
            <span><b>AD</b>{Math.round(stats.attackDamage)}</span>
            {magicPen && <span><b>Magic pen</b>{magicPen}</span>}
            {armorPen && <span><b>Armor pen</b>{armorPen}</span>}
            <span><b>AH</b>{Math.round(stats.abilityHaste)}</span>
            <span><b>Armor</b>{Math.round(stats.armor)}</span>
            <span><b>MR</b>{Math.round(stats.magicResist)}</span>
          </div>
        )}
        {abilities && <div className="ability-levels">{(["Q", "W", "E", "R"] as const).map((key) => <span key={key}><b>{key}</b>{abilities[key]}</span>)}</div>}
        {keystone && <span className="keystone-chip"><Sparkles size={11} />{keystone}{active.runes?.secondaryTree ? <small> · {active.runes.primaryTree} / {active.runes.secondaryTree}</small> : null}</span>}
        <div className="statline-right">{right}</div>
      </div>
    </>
  );
}
