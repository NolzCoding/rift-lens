// Regenerates lib/champion-traits-fallback.json (the offline champion traits table) from CommunityDragon for the current
// Data Dragon patch, using the same derivation the live loader uses (lib/champion-traits.ts). Run from the project folder:
//   node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings scripts/build-champion-traits.ts [--print [filter]]
// --print lists the derived traits (one line per champion) instead of only writing the file.
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { loadChampionIndex } from "@/lib/champion-data";
import { buildClass, fetchChampionData, isDiver, isEnchanter, isMarksman, isTank, traitsTable, type RawChampionData } from "@/lib/champion-traits";

const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json() as string[];
const version = versions[0];
const index = await loadChampionIndex(version);
if (!index.size) throw new Error("Data Dragon champion list unavailable");
const champions = [...new Map([...index.values()].map((entry) => [entry.id, entry])).values()];
const raws: Array<{ id: string; key: string; name: string; raw: RawChampionData }> = [];
const base = await fetchChampionData(version, champions.map((entry) => ({ id: entry.id, key: entry.key, name: entry.name })), (champion, raw) => raws.push({ ...champion, raw }));
const table = traitsTable(version, `${base} champions/<id>.json (roles, tacticalInfo, playstyleInfo, passive/spell text and ranges)`, raws);
// One champion per line: small, and a regeneration diffs per champion.
const { champions: rows, ...header } = table;
const body = Object.entries(rows).map(([id, traits]) => `  ${JSON.stringify(id)}: ${JSON.stringify(traits)}`).join(",\n");
const text = `${JSON.stringify(header, null, 2).replace(/\n}$/, "")},\n  "champions": {\n${body}\n  }\n}\n`;
JSON.parse(text);
await writeFile(path.join(process.cwd(), "lib", "champion-traits-fallback.json"), text, "utf8");
console.log(`Wrote lib/champion-traits-fallback.json: ${Object.keys(table.champions).length} champions, patch ${version}, algorithm ${table.algorithm}.`);

const at = process.argv.indexOf("--print");
if (at >= 0) {
  const filter = process.argv[at + 1] ? new RegExp(process.argv[at + 1], "i") : null;
  for (const traits of Object.values(table.champions)) {
    if (filter && !filter.test(traits.name) && !filter.test(traits.id)) continue;
    const flags = [isTank(traits) && "tank", isMarksman(traits) && "marksman", isEnchanter(traits) && "enchanter", isDiver(traits) && "diver", traits.critScaling && "crit", traits.onHit && "on-hit"].filter(Boolean).join(",");
    console.log(`${traits.name.padEnd(14)} ${traits.roles.join("/").padEnd(18)} ${traits.damage.padEnd(8)} ${buildClass(traits).padEnd(14)} heal ${traits.healing} (${traits.healScore}) cc ${traits.hardCc} [${traits.ccKinds.join(" ")}] poke ${traits.poke} (${traits.pokeScore}, ${traits.pokeRange}) dash ${traits.dashes} ${flags}`);
  }
}
