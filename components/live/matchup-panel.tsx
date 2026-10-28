"use client";

import { Activity, Target, Users } from "lucide-react";

import { ItemStrip } from "@/components/live/shared";
import { csGap } from "@/lib/live-coach";
import type { LiveGameSnapshot, LivePlayer } from "@/lib/types";

export function MatchupPanel({ snapshot }: { snapshot: LiveGameSnapshot }) {
  const active = snapshot.activePlayer;
  const opponent = snapshot.laneOpponent;
  const team: LivePlayer[] = [active, ...snapshot.allies];
  const sum = (players: LivePlayer[], pick: (player: LivePlayer) => number) => players.reduce((total, player) => total + pick(player), 0);
  const mix = snapshot.enemies.reduce((counts, enemy) => { counts[enemy.damageProfile] += 1; return counts; }, { physical: 0, magic: 0, mixed: 0, unknown: 0 });

  return (
    <article className="live-panel matchup-panel">
      <div className="live-panel-title">
        <div><span className="eyebrow">{snapshot.matchup.basis === "highest-threat" ? "Priority threat" : "Likely lane matchup"}</span><h2>{opponent ? `${active.champion} vs ${opponent.champion}` : "Waiting for enemy data"}</h2></div>
        <Target size={18} />
      </div>
      <p className="matchup-source">{snapshot.matchup.note}</p>
      {opponent ? (
        <>
          <div className="matchup-versus">
            <div><strong>{active.level} <small>v {opponent.level}</small></strong><span>Levels</span></div>
            <div title="Riot reports CS in steps of 10, so gaps under 20 are within the noise.">
              <strong>{csGap(active.cs, opponent.cs).label}</strong><span>CS gap (±10)</span>
            </div>
            <div><strong>{opponent.kills}/{opponent.deaths}</strong><span>Enemy K/D</span></div>
          </div>
          <ItemStrip items={opponent.items} version={snapshot.dataDragonVersion} champion={opponent.champion} />
          <p className="matchup-note">Likely {opponent.damageProfile} damage*. {opponent.threat === "critical" || opponent.threat === "high" ? "Treat this lane as high risk and preserve your shutdown/tempo." : "No extreme scoreboard threat detected yet."}</p>
        </>
      ) : <p className="matchup-note">Enemy player data has not appeared yet.</p>}
      <p className="team-damage-read">Whole team*: {mix.physical} physical · {mix.magic} magic · {mix.mixed} mixed{mix.unknown ? ` · ${mix.unknown} unknown` : ""}</p>
      <div className="team-pulse">
        <div><Users size={14} /><span>Team kills</span><strong>{sum(team, (p) => p.kills)} – {sum(snapshot.enemies, (p) => p.kills)}</strong></div>
        <div><Activity size={14} /><span>Total levels</span><strong>{sum(team, (p) => p.level)} – {sum(snapshot.enemies, (p) => p.level)}</strong></div>
      </div>
    </article>
  );
}
