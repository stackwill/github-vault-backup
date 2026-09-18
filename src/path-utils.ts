export function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(path);
}

export function isExcluded(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern.trim()));
}

export function encodeGitHubPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
