// Publishes the current commit's files to the public GitHub repo as one new commit on its `main` branch.
// Only the file tree is published: none of the private history, and the author is a GitHub noreply address.
// Refuses when a tracked file contains a secret-looking string or a term from `.publish-denylist` (one term per
// line, kept local and never published: your Riot IDs, email, real name...).
// Usage: node scripts/publish.mjs "What changed"   (add --check to only run the scan)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const REMOTE = "public";
const BRANCH = "main";
const AUTHOR = { name: "NolzCoding", email: "NolzCoding@users.noreply.github.com" };

const git = (args, options = {}) => execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options }).trim();
const fail = (message) => { console.error(`\n[publish] ${message}`); process.exit(1); };

const checkOnly = process.argv.includes("--check");
const message = process.argv.slice(2).filter((arg) => arg !== "--check").join(" ").trim() || "Update";
if (git(["status", "--porcelain", "--untracked-files=no"])) fail("Commit your changes first: only committed files are published.");

// Secret-looking strings anywhere in the tracked files.
const secretPatterns = [
  "sk-[A-Za-z0-9_-]{20,}", "AIza[0-9A-Za-z_-]{30,}", "gh[pousr]_[A-Za-z0-9]{30,}", "github_pat_[A-Za-z0-9_]{30,}",
  "ya29\\.[0-9A-Za-z_-]{20,}", "\"(refresh|access|id)_token\"\\s*:\\s*\"[^\"]{12,}", "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "remoting-auth-token=[A-Za-z0-9_-]{10,}",
];
const hits = [];
for (const pattern of secretPatterns) {
  try { hits.push(git(["grep", "-n", "-I", "-E", "-e", pattern, "HEAD", "--", ".", ":!package-lock.json"])); } catch { /* No match. */ }
}
// Personal terms from the local deny list.
const denyFile = ".publish-denylist";
if (!existsSync(denyFile)) fail(`Create ${denyFile} (one private term per line: Riot IDs, email, name) before publishing.`);
const terms = readFileSync(denyFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
for (const term of terms) {
  try { hits.push(git(["grep", "-n", "-I", "-i", "-F", "-e", term, "HEAD", "--", "."])); } catch { /* No match. */ }
}
if (hits.length) fail(`Not published: private data found in tracked files.\n${hits.join("\n")}`);
if (checkOnly) { console.log("[publish] Clean: no secrets or private terms in the committed files."); process.exit(0); }

const tree = git(["rev-parse", "HEAD^{tree}"]);
let parent = null;
try { git(["fetch", "--quiet", REMOTE, BRANCH]); parent = git(["rev-parse", `${REMOTE}/${BRANCH}`]); } catch { /* First publish. */ }
if (parent && git(["rev-parse", `${parent}^{tree}`]) === tree) { console.log("[publish] Nothing new to publish."); process.exit(0); }

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email,
};
const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { env });
execFileSync("git", ["push", REMOTE, `${commit}:refs/heads/${BRANCH}`], { stdio: "inherit" });
console.log(`[publish] Published ${commit.slice(0, 7)} to ${REMOTE}/${BRANCH}.`);
