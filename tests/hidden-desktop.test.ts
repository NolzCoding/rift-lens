// Programs run on a hidden desktop (lib/hidden-desktop.ts): Antigravity's helper windows must never reach the screen.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/hidden-desktop.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { HIDDEN_START_FAILED, quoteWindowsArgument, spawnHidden } from "@/lib/hidden-desktop";

test("Windows command-line quoting: spaces, quotes and trailing backslashes survive", () => {
  assert.equal(quoteWindowsArgument("plain"), "plain");
  assert.equal(quoteWindowsArgument(""), "\"\"");
  assert.equal(quoteWindowsArgument("C:\\a dir\\"), "\"C:\\a dir\\\\\"");
  assert.equal(quoteWindowsArgument("say \"hi\""), "\"say \\\"hi\\\"\"");
  assert.equal(quoteWindowsArgument("a\\\"b c"), "\"a\\\\\\\"b c\"");
});

function run(command: string, args: string[], input: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawnHidden(command, args, { cwd: process.cwd(), env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("a window the program opens lands on the hidden desktop; stdin, stdout, stderr and the exit code pass through", { skip: process.platform !== "win32" }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "rift-lens-hidden-"));
  try {
    const report = path.join(folder, "report.txt");
    // The helper reports the desktop its new console window was created on, and whether that window is visible.
    await writeFile(path.join(folder, "report.ps1"), [
      "Add-Type -Name D -Namespace R -MemberDefinition @'",
      "[DllImport(\"user32.dll\")] public static extern System.IntPtr GetThreadDesktop(int id);",
      "[DllImport(\"kernel32.dll\")] public static extern int GetCurrentThreadId();",
      "[DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(System.IntPtr h, int index, System.Text.StringBuilder buf, int len, out int needed);",
      "[DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetConsoleWindow();",
      "[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(System.IntPtr h);",
      "'@",
      "$name = New-Object System.Text.StringBuilder 256; $needed = 0",
      "[void][R.D]::GetUserObjectInformation([R.D]::GetThreadDesktop([R.D]::GetCurrentThreadId()), 2, $name, 512, [ref]$needed)",
      "\"$($name.ToString()) $([R.D]::IsWindowVisible([R.D]::GetConsoleWindow()))\" | Out-File -Encoding ascii $args[0]",
    ].join("\n"));
    // A stand-in for agy: opens a NEW console window (as agy's helpers do), echoes stdin, writes stderr, exits 3.
    const fake = path.join(folder, "fake.cjs");
    await writeFile(fake, [
      "const { spawnSync } = require('node:child_process');",
      "let input = ''; process.stdin.on('data', (c) => { input += c; });",
      "process.stdin.on('end', () => {",
      `  spawnSync('cmd.exe', ['/c', 'start', '""', '/wait', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${JSON.stringify(path.join(folder, "report.ps1"))}, ${JSON.stringify(report)}]);`,
      "  process.stdout.write(`${input.length}:${process.argv.slice(2).join('|')}`); process.stderr.write('warn'); process.exit(3);",
      "});",
    ].join("\n"));
    const result = await run(process.execPath, [fake, "a b", "C:\\x y\\"], "prompt é ".repeat(3000));
    assert.equal(result.code, 3);
    assert.equal(result.stdout, `${"prompt é ".repeat(3000).length}:a b|C:\\x y\\`);
    assert.equal(result.stderr, "warn");
    assert.equal((await readFile(report, "utf8")).trim(), "RiftLensHidden False");
    assert.equal((await run(path.join(folder, "missing.exe"), [], "")).code, HIDDEN_START_FAILED);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
