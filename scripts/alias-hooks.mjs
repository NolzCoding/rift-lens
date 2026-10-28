import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Project root = the parent of this scripts/ folder.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXTENSIONS = [".ts", ".tsx", "/index.ts", ".mjs", ".js"];

function resolveFile(base) {
  if (/\.(m?[jt]sx?|json)$/.test(base) && existsSync(base)) return base;
  for (const extension of EXTENSIONS) if (existsSync(base + extension)) return base + extension;
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const file = resolveFile(ROOT + specifier.slice(2));
    if (file) return next(pathToFileURL(file).href, context);
  }
  // Extensionless relative imports inside TypeScript sources.
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:") && !/\.[a-z]+$/i.test(specifier)) {
    const file = resolveFile(fileURLToPath(new URL(specifier, context.parentURL)));
    if (file) return next(pathToFileURL(file).href, context);
  }
  return next(specifier, context);
}
