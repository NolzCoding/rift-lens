// End-of-game stats for all ten players straight from a .rofl file (ROFL2, patch 14+): the metadata JSON sits at the end
// of the file, its byte length in the last 4 bytes (uint32 LE); `statsJson` is a JSON string of one row per player
// (SKIN = champion, TEAM 100/200, TEAM_POSITION, LEVEL, ITEM0-6, CHAMPIONS_KILLED, NUM_DEATHS, ASSISTS, WIN…).
// The replay reader only exports the reviewed players and their lane opponents; the build review needs the whole enemy
// team's final items. Pure: works on a Buffer, never touches the file system.
import type { ReplayParticipant } from "@/lib/types";

type Row = Record<string, unknown>;

const num = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));

export type RoflMetadata = { gameLengthMs: number; participants: ReplayParticipant[] };

/** Null when the buffer is not a ROFL2 file with readable metadata. Item names are left empty (resolved later). */
export function readRoflMetadata(buffer: Buffer): RoflMetadata | null {
  if (buffer.length < 16 || buffer.subarray(0, 4).toString("latin1") !== "RIOT") return null;
  const length = buffer.readUInt32LE(buffer.length - 4);
  if (!length || length > buffer.length - 8) return null;
  let rows: Row[];
  let gameLengthMs = 0;
  try {
    const metadata = JSON.parse(buffer.subarray(buffer.length - 4 - length, buffer.length - 4).toString("utf8")) as { gameLength?: unknown; statsJson?: unknown };
    gameLengthMs = num(metadata.gameLength);
    rows = typeof metadata.statsJson === "string" ? JSON.parse(metadata.statsJson) as Row[] : [];
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const participants = rows.map((row, index): ReplayParticipant => {
    const gameName = text(row.RIOT_ID_GAME_NAME) || text(row.NAME);
    const tag = text(row.RIOT_ID_TAG_LINE);
    // ITEM6 is the trinket slot.
    const itemIds = [0, 1, 2, 3, 4, 5].map((slot) => num(row[`ITEM${slot}`])).filter((id) => id > 0);
    return {
      participantId: num(row.ID) || index + 1,
      champion: text(row.SKIN),
      name: gameName ? (tag ? `${gameName}#${tag}` : gameName) : "",
      team: num(row.TEAM),
      position: text(row.TEAM_POSITION) || text(row.INDIVIDUAL_POSITION),
      level: num(row.LEVEL),
      kills: num(row.CHAMPIONS_KILLED),
      deaths: num(row.NUM_DEATHS),
      assists: num(row.ASSISTS),
      gold: num(row.GOLD_EARNED),
      cs: num(row.MINIONS_KILLED) + num(row.NEUTRAL_MINIONS_KILLED),
      win: text(row.WIN).toLowerCase() === "win",
      itemIds,
      items: [],
    };
  });
  return { gameLengthMs, participants };
}

/** The Riot game id in a replay file name ("EUW1-1234567890.rofl" → 1234567890), else null. */
export function gameIdFromReplayName(name: string) {
  const match = /(?:^|[^0-9])(\d{8,12})(?:\.rofl)?$/i.exec(name.replace(/\.rofl$/i, ""));
  return match ? Number(match[1]) : null;
}
