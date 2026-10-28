"use client";

import { Crosshair, Shield, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ItemStrip, Kda, spellImage } from "@/components/live/shared";
import { csText } from "@/lib/live-coach";
import type { LiveGameSnapshot, LivePlayer } from "@/lib/types";

const hundreds = (value: number) => Math.round(value / 50) * 50;

function ThreatCard({ player, version, deathsTo }: { player: LivePlayer; version: string; deathsTo: number }) {
  const spells = player.summonerSpells || [];
  const roles = player.roles || [];
  return (
    <article className={`threat-card threat-${player.threat}`}>
      <div className="threat-top">
        <div className="champion-avatar">{player.champion.slice(0, 2).toUpperCase()}</div>
        <div>
          <span>{player.position === "UNKNOWN" ? "Enemy" : player.position}</span>
          <h3>{player.champion}</h3>
          <small>{player.name}</small>
        </div>
        <Badge tone={player.threat === "critical" ? "bad" : player.threat === "high" ? "warn" : "info"}>{player.threat}</Badge>
      </div>
      {(roles.length > 0 || spells.length > 0 || player.keystone) && (
        <div className="threat-meta">
          {spells.length > 0 && (
            <span className="threat-spells">
              {spells.map((spell) => {
                const src = spellImage(version, spell);
                return src ? <img key={spell} src={src} alt={spell} title={spell} /> : <em key={spell}>{spell}</em>;
              })}
            </span>
          )}
          {player.keystone && <span className="threat-keystone" title="Keystone rune"><Sparkles size={10} />{player.keystone}</span>}
          {roles.map((role) => <span key={role} className="threat-role">{role}</span>)}
        </div>
      )}
      <div className="threat-stats">
        <Kda player={player} />
        <span>Lv {player.level}</span>
        <span title="Riot updates CS in steps of 10">{csText(player.cs)} CS</span>
        <span>{player.damageProfile} dmg*</span>
      </div>
      {player.estStats && (
        <p className="threat-est" title="Estimated from Data Dragon base stats, level and items (no runes, stacks or buffs)">
          <Shield size={11} /> est. {player.estStats.armor} armor · {player.estStats.magicResist} MR · {hundreds(player.estStats.hp)} HP
        </p>
      )}
      <ItemStrip items={player.items} version={version} champion={player.champion} />
      {deathsTo > 0 && <p className="death-warning"><Crosshair size={13} /> Has killed you {deathsTo}× this game</p>}
    </article>
  );
}

export function ThreatGrid({ snapshot }: { snapshot: LiveGameSnapshot }) {
  return (
    <>
      <section className="live-section-heading">
        <div><span className="eyebrow">Enemy scan</span><h2>Who can punish you right now</h2></div>
        <p>Sorted by an inferred score using KDA, level, CS and visible inventory.</p>
      </section>
      <EnemyTeamLine snapshot={snapshot} />
      <section className="threat-grid">
        {snapshot.enemies.map((enemy) => (
          <ThreatCard key={enemy.riotId || enemy.name} player={enemy} version={snapshot.dataDragonVersion} deathsTo={snapshot.deathSources.find((source) => source.champion === enemy.champion || source.playerName === enemy.name)?.deathsTo || 0} />
        ))}
      </section>
    </>
  );
}

/** One compact line: the enemy team's estimated counter-build signals (lib/enemy-stats.ts), only those that fired. */
function EnemyTeamLine({ snapshot }: { snapshot: LiveGameSnapshot }) {
  const profile = snapshot.enemyProfile;
  if (!profile) return null;
  const signals: Array<[string, { level: string; reasons: string[] }]> = [
    ["Armor", profile.armorStack], ["MR", profile.mrStack], ["HP", profile.hpStack], ["Healing", profile.healing],
    ["Burst", profile.burstThreat], ["Hard CC", profile.hardCc], ["Poke", profile.poke],
  ];
  const fired = signals.filter(([, signal]) => signal.level !== "none");
  return (
    <p className="enemy-team-line" title="Estimated from Data Dragon base stats, level growth and item stats; runes, stacks and buffs are not included.">
      <b>Enemy team</b>
      {fired.map(([label, signal]) => (
        <span key={label} className={`enemy-signal is-${signal.level}`}>{label} {signal.level}{signal.reasons[0] ? `: ${signal.reasons[0]}` : ""}</span>
      ))}
      <span className="enemy-signal">{profile.physicalShare.reasons[0]}</span>
      <em>estimated</em>
    </p>
  );
}
