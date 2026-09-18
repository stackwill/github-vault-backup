import { Platform } from "obsidian";

interface ChildProcessModule {
  execFile: (
    file: string,
    args: string[],
    options: { timeout: number; windowsHide: boolean },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => void;
}

/** Returns the token for an existing GitHub CLI login without opening a prompt. */
export async function getExistingGitHubCliToken(): Promise<string | null> {
  if (!Platform.isDesktopApp) return null;
  try {
    const load = Function("return require")() as (id: string) => ChildProcessModule;
    const { execFile } = load("node:child_process");
    const token = await new Promise<string>((resolve, reject) => {
      execFile("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 8_000, windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    return token || null;
  } catch {
    return null;
  }
}
