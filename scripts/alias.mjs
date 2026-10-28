// Usage: node --import ./scripts/alias.mjs --experimental-transform-types <script.ts>
// Maps the project's "@/..." imports (tsconfig paths) to files so lib/*.ts runs under plain Node 22.
import { register } from "node:module";

register("./alias-hooks.mjs", import.meta.url);
