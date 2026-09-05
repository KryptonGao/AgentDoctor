import { spawn } from "node:child_process";
import * as os from "node:os";

export interface ClipboardResult {
  success: boolean;
  error?: string;
}

type ClipboardWriter = (text: string) => Promise<ClipboardResult>;

let customClipboardWriter: ClipboardWriter | null = null;

/**
 * For testing purposes: allow overriding the clipboard writer.
 */
export function setCustomClipboardWriter(writer: ClipboardWriter | null) {
  customClipboardWriter = writer;
}

function runSpawnCommand(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));

      if (proc.stdin) {
        proc.stdin.write(input);
        proc.stdin.end();
      } else {
        resolve(false);
      }
    } catch {
      resolve(false);
    }
  });
}

/**
 * Copy text to system clipboard across macOS, Windows, and Linux.
 * Never throws or crashes.
 */
export async function copyToClipboard(text: string): Promise<ClipboardResult> {
  if (customClipboardWriter) {
    return customClipboardWriter(text);
  }

  const platform = os.platform();

  try {
    if (platform === "darwin") {
      const ok = await runSpawnCommand("pbcopy", [], text);
      if (ok) return { success: true };
      return { success: false, error: "Failed to execute pbcopy." };
    }

    if (platform === "win32") {
      // clip.exe is built into Windows
      let ok = await runSpawnCommand("clip", [], text);
      if (ok) return { success: true };

      // PowerShell fallback
      ok = await runSpawnCommand("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ], text);
      if (ok) return { success: true };

      return { success: false, error: "Failed to execute clip or powershell Set-Clipboard." };
    }

    // Linux & others: try wl-copy -> xclip -> xsel
    if (await runSpawnCommand("wl-copy", [], text)) {
      return { success: true };
    }
    if (await runSpawnCommand("xclip", ["-selection", "clipboard"], text)) {
      return { success: true };
    }
    if (await runSpawnCommand("xsel", ["--clipboard", "--input"], text)) {
      return { success: true };
    }

    return {
      success: false,
      error: "No supported clipboard command found (tried wl-copy, xclip, xsel).",
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}
