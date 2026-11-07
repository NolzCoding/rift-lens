import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// Windows: runs a program on a hidden desktop of its own, so no window it (or anything it starts) opens can show up.
// Antigravity CLI starts PowerShell/cmd helpers in new console windows that no spawn flag of ours reaches (a known
// Antigravity bug on Windows), which flashed a window on the player's screen during every AI call.
//
// A small PowerShell launcher creates the desktop "RiftLensHidden" in the user's window station and starts the program
// there with CREATE_NO_WINDOW, handing it its own stdin/stdout/stderr (the pipes from this process), so reading and
// writing works as with a plain spawn. Child processes start on their parent's desktop, so the whole tree stays there.
// When the desktop cannot be created the program runs on the normal desktop (as before), never not at all.

const LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class RiftLensHiddenDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, int flags, uint access, IntPtr attributes);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string commandLine, string directory) {
    IntPtr desktop = CreateDesktop("RiftLensHidden", IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
    STARTUPINFO startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(startup);
    startup.lpDesktop = desktop != IntPtr.Zero ? "RiftLensHidden" : null;
    startup.dwFlags = 0x101; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
    startup.wShowWindow = 0; // SW_HIDE
    startup.hStdInput = GetStdHandle(-10); startup.hStdOutput = GetStdHandle(-11); startup.hStdError = GetStdHandle(-12);
    PROCESS_INFORMATION info;
    if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0x08000000, IntPtr.Zero, directory, ref startup, out info)) return 9009;
    WaitForSingleObject(info.hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(info.hProcess, out code);
    CloseHandle(info.hThread); CloseHandle(info.hProcess);
    return (int)code;
  }
}
'@
exit [RiftLensHiddenDesktop]::Run($env:RIFT_LENS_HIDDEN_COMMAND, (Get-Location).Path)
`;
const ENCODED_LAUNCHER = Buffer.from(LAUNCHER, "utf16le").toString("base64");
/** The launcher's exit code when the program itself could not be started (cmd's "not found" code). */
export const HIDDEN_START_FAILED = 9009;

/** One argument quoted the way Windows programs split a command line (CommandLineToArgvW). */
export function quoteWindowsArgument(value: string) {
  if (value && !/[\s"]/.test(value)) return value;
  let quoted = "\"";
  let slashes = 0;
  for (const char of value) {
    if (char === "\\") { slashes++; continue; }
    quoted += char === "\"" ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${char}`;
    slashes = 0;
  }
  return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

/**
 * Like spawn(command, args, { cwd, env, windowsHide: true, stdio: "pipe" }), on a hidden desktop on Windows; a plain hidden
 * spawn elsewhere. The returned process is the launcher: stopping its tree (taskkill /T) stops the program too.
 */
export function spawnHidden(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  if (process.platform !== "win32") return spawn(command, args, { ...options, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const commandLine = [command, ...args].map(quoteWindowsArgument).join(" ");
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_LAUNCHER], {
    cwd: options.cwd, env: { ...options.env, RIFT_LENS_HIDDEN_COMMAND: commandLine }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
}
