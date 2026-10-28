// Scans source files for control characters; with --fix, turns stray backspaces (0x08) back into the regex escape "\b".
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const fix = process.argv.includes("--fix");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (["node_modules", ".next", ".git"].includes(entry.name)) return [];
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : /\.(ts|tsx|mjs|cjs|js|css|json)$/.test(entry.name) ? [full] : [];
});
let found = 0;
for (const file of ["app", "lib", "components", "scripts", "tests"].flatMap((d) => fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : [])) {
  const text = fs.readFileSync(file, "utf8");
  const bad = [...text.matchAll(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g)];
  if (!bad.length) continue;
  found += bad.length;
  console.log(`${path.relative(root, file)}: ${bad.length} control char(s) [${[...new Set(bad.map((m) => m[0].charCodeAt(0)))].join(",")}]`);
  if (fix) fs.writeFileSync(file, text.replace(/\x08/g, "\\b"), "utf8");
}
console.log(found ? `${found} found${fix ? " (backspaces fixed)" : ""}` : "clean");
if (found && !fix) process.exitCode = 1;
