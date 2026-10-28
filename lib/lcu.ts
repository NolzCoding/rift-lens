import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";

type Credentials = { port: number; password: string };
type LcuState = { auth: Credentials | null; installDir: string | null; processCheckedAt: number; pending: Promise<Credentials | null> | null };

// Spawning PowerShell costs ~0.5-1s, so the process lookup is throttled; lockfile reads are cheap and always allowed.
const PROCESS_RETRY_MS = 30_000;
const KNOWN_DIRS = ["C:\\Riot Games\\League of Legends", "P:\\Riot\\Riot Games\\League of Legends", "D:\\Riot Games\\League of Legends"];
const globalStore = globalThis as typeof globalThis & { __riftLensLcuV1?: LcuState };
const lcu: LcuState = globalStore.__riftLensLcuV1 ??= { auth: null, installDir: null, processCheckedAt: 0, pending: null };

async function lockfileIn(directory: string): Promise<Credentials | null> {
  try {
    const [, , port, password] = (await readFile(path.join(directory, "lockfile"), "utf8")).trim().split(":");
    return Number(port) > 0 && password ? { port: Number(port), password } : null;
  } catch { return null; }
}

async function fromLockfile(): Promise<Credentials | null> {
  const directories = [process.env.RIFT_LENS_LOL_DIR, lcu.installDir, ...KNOWN_DIRS].filter((entry): entry is string => Boolean(entry));
  for (const directory of [...new Set(directories)]) {
    const found = await lockfileIn(directory);
    if (found) return found;
  }
  return null;
}

/** LeagueClientUx.exe: lockfile next to its ExecutablePath first, else --app-port/--remoting-auth-token. The token is never logged. */
function fromProcess(): Promise<Credentials | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object ExecutablePath, CommandLine | ConvertTo-Json -Compress",
    ], { timeout: 6000, windowsHide: true }, async (error, stdout) => {
      if (error || !stdout.trim()) return resolve(null);
      try {
        const parsed = JSON.parse(stdout) as { ExecutablePath?: string; CommandLine?: string } | Array<{ ExecutablePath?: string; CommandLine?: string }>;
        for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
          if (entry.ExecutablePath) {
            const directory = path.dirname(entry.ExecutablePath);
            const found = await lockfileIn(directory);
            if (found) { lcu.installDir = directory; return resolve(found); }
          }
          const line = entry.CommandLine || "";
          const port = /--app-port=(\d+)/.exec(line)?.[1];
          const password = /--remoting-auth-token=([\w-]+)/.exec(line)?.[1];
          if (port && password) return resolve({ port: Number(port), password });
        }
      } catch { /* Unexpected output: treat as not running. */ }
      resolve(null);
    });
  });
}

async function credentials(): Promise<Credentials | null> {
  if (lcu.auth) return lcu.auth;
  if (lcu.pending) return lcu.pending;
  lcu.pending = (async () => {
    try {
      let found = await fromLockfile();
      if (!found && Date.now() - lcu.processCheckedAt >= PROCESS_RETRY_MS) {
        lcu.processCheckedAt = Date.now();
        found = await fromProcess();
      }
      lcu.auth = found;
      return found;
    } finally { lcu.pending = null; }
  })();
  return lcu.pending;
}

function lcuGet<T>(auth: Credentials, endpoint: string, timeoutMs = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1", port: auth.port, path: endpoint, method: "GET", rejectUnauthorized: false, timeout: timeoutMs,
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`riot:${auth.password}`).toString("base64")}` },
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; if (body.length > 4_000_000) req.destroy(); });
      response.on("end", () => {
        // 401 means the cached token belongs to a previous client session.
        if (response.statusCode === 401 && lcu.auth === auth) lcu.auth = null;
        if ((response.statusCode || 500) >= 400) return resolve(null);
        try { resolve(JSON.parse(body) as T); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", (error: NodeJS.ErrnoException) => {
      // Client closed or restarted on a new port: drop the cached credentials so the next call re-resolves.
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") { if (lcu.auth === auth) lcu.auth = null; }
      resolve(null);
    });
    req.end();
  });
}

/** Read-only GET against the running League Client; null when the client is closed, the endpoint 404s, or anything fails. */
export async function lcuJson<T>(endpoint: string, timeoutMs = 3000): Promise<T | null> {
  try {
    const auth = await credentials();
    return auth ? await lcuGet<T>(auth, endpoint, timeoutMs) : null;
  } catch { return null; }
}

type EogBlock = {
  gameLength?: number;
  localPlayer?: { championName?: string; stats?: Record<string, number> };
  teams?: Array<{ isPlayerTeam?: boolean; isWinningTeam?: boolean }>;
};
type MatchHistory = { games?: { games?: Array<{ gameCreation?: number; gameDuration?: number; participants?: Array<{ stats?: { win?: boolean } }> }> } };

/**
 * Best-effort result of the game that just ended, from the League Client.
 * Returns null whenever the client is closed, the data does not match, or anything fails.
 */
export async function lcuLastGameResult(durationSeconds: number, endedAt: number): Promise<"win" | "loss" | null> {
  try {
    // A remake (< 3:00) has no meaningful result, and the client's "last game" would be the previous match.
    if (durationSeconds < 180) return null;
    const auth = await credentials();
    if (!auth) return null;
    // Both sources must carry a length that matches what we watched: the real game ran at least as long as our last
    // sample (minus slack) and not more than 3 minutes longer. A missing length is never trusted.
    const sameGame = (length: number | undefined) => typeof length === "number" && length >= durationSeconds - 30 && length - durationSeconds < 180;
    const eog = await lcuGet<EogBlock>(auth, "/lol-end-of-game/v1/eog-stats-block");
    if (eog && sameGame(eog.gameLength)) {
      const team = eog.teams?.find((entry) => entry.isPlayerTeam);
      if (typeof team?.isWinningTeam === "boolean") return team.isWinningTeam ? "win" : "loss";
      const stats = eog.localPlayer?.stats || {};
      if (stats.WIN) return "win";
      if (stats.LOSE) return "loss";
    }
    const history = await lcuGet<MatchHistory>(auth, "/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=1");
    const game = history?.games?.games?.[0];
    const win = game?.participants?.[0]?.stats?.win;
    if (!game || typeof win !== "boolean") return null;
    const finishedAt = (game.gameCreation || 0) + (game.gameDuration || 0) * 1000;
    if (!game.gameCreation || Math.abs(finishedAt - endedAt) > 20 * 60_000 || !sameGame(game.gameDuration)) return null;
    return win ? "win" : "loss";
  } catch { return null; }
}
