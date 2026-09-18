import { requestUrl, RequestUrlParam } from "obsidian";
import type { BackupResult, GitHubRepository } from "./types";
import { encodeGitHubPath } from "./path-utils";

const API_VERSION = "2022-11-28";
const RATE_LIMIT_RESERVE = 100;

interface TreeEntry { path: string; mode: string; type: "blob" | "tree"; sha: string; size?: number }
interface NewTreeEntry { path: string; mode: "100644"; type: "blob"; sha: string | null }
interface VaultEntry { path: string; bytes: ArrayBuffer }
export interface RepositorySnapshot { commitSha: string; files: Map<string, string> }

export class GitHubClient {
  private remaining = Number.POSITIVE_INFINITY;
  private resetAt = 0;

  constructor(private readonly token: string) {}

  private async request<T>(path: string, options: Partial<RequestUrlParam> = {}): Promise<T> {
    if (this.remaining <= RATE_LIMIT_RESERVE && Date.now() < this.resetAt) {
      throw new Error(`GitHub API rate limit reserve reached. Backup paused until ${new Date(this.resetAt).toLocaleTimeString()}.`);
    }
    const response = await requestUrl({
      url: path.startsWith("http") ? path : `https://api.github.com${path}`,
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...options.headers
      },
      body: options.body,
      throw: false
    });
    this.remaining = Number(response.headers["x-ratelimit-remaining"] ?? this.remaining);
    const resetSeconds = Number(response.headers["x-ratelimit-reset"] ?? 0);
    if (resetSeconds) this.resetAt = resetSeconds * 1000;
    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.message ?? response.text ?? `HTTP ${response.status}`;
      const error = new Error(`GitHub: ${message}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.json as T;
  }

  async getViewer(): Promise<{ login: string }> { return this.request("/user"); }

  async listPrivateRepositories(): Promise<GitHubRepository[]> {
    const repositories: GitHubRepository[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const batch = await this.request<GitHubRepository[]>(`/user/repos?visibility=private&affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=${page}`);
      repositories.push(...batch.filter((repo) => repo.private && repo.permissions?.push !== false));
      if (batch.length < 100) break;
    }
    return repositories;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  async getSnapshot(owner: string, repo: string, branch: string, commitSha?: string): Promise<RepositorySnapshot> {
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const sha = commitSha ?? (await this.request<{ object: { sha: string } }>(`${base}/git/ref/heads/${encodeGitHubPath(branch)}`)).object.sha;
    const commit = await this.request<{ tree: { sha: string } }>(`${base}/git/commits/${sha}`);
    const tree = await this.request<{ tree: TreeEntry[]; truncated: boolean }>(`${base}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error("The repository tree is too large to synchronize safely.");
    return {
      commitSha: sha,
      files: new Map(tree.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.sha]))
    };
  }

  async downloadBlob(owner: string, repo: string, sha: string): Promise<ArrayBuffer> {
    const blob = await this.request<{ content: string; encoding: string }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${sha}`);
    if (blob.encoding !== "base64") throw new Error(`GitHub returned unsupported blob encoding: ${blob.encoding}`);
    const binary = atob(blob.content.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }

  async backup(owner: string, repo: string, branch: string, files: VaultEntry[], expectedRemoteSha: string, allowDeletions: boolean, onProgress?: (message: string) => void): Promise<BackupResult> {
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const readRefPath = `${base}/git/ref/heads/${encodeGitHubPath(branch)}`;
    const writeRefPath = `${base}/git/refs/heads/${encodeGitHubPath(branch)}`;
    let parentSha: string | undefined;
    let baseTreeSha: string | undefined;
    let existing = new Map<string, string>();

    onProgress?.("Reading the repository state…");
    try {
      const ref = await this.request<{ object: { sha: string } }>(readRefPath);
      parentSha = ref.object.sha;
      const commit = await this.request<{ tree: { sha: string } }>(`${base}/git/commits/${parentSha}`);
      baseTreeSha = commit.tree.sha;
      const tree = await this.request<{ tree: TreeEntry[]; truncated: boolean }>(`${base}/git/trees/${baseTreeSha}?recursive=1`);
      if (tree.truncated) throw new Error("The repository tree is too large for a safe backup. Use a dedicated empty repository.");
      existing = new Map(tree.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.sha]));
      if (!expectedRemoteSha && [...existing.keys()].some((path) => path !== ".github-vault-backup-init")) {
        throw new Error("This repository already contains a backup. Restore from GitHub on this device before uploading.");
      }
      if (expectedRemoteSha && parentSha !== expectedRemoteSha) {
        throw new Error("The GitHub backup changed on another device. Synchronize again before uploading.");
      }
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status !== 404 && status !== 409) throw error;
      onProgress?.("Initializing the empty repository…");
      await this.initializeEmptyRepository(base);
      const ref = await this.request<{ object: { sha: string } }>(readRefPath);
      parentSha = ref.object.sha;
      const commit = await this.request<{ tree: { sha: string } }>(`${base}/git/commits/${parentSha}`);
      baseTreeSha = commit.tree.sha;
      const tree = await this.request<{ tree: TreeEntry[] }>(`${base}/git/trees/${baseTreeSha}?recursive=1`);
      existing = new Map(tree.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.sha]));
    }

    const desiredPaths = new Set(files.map((file) => file.path));
    const entries: NewTreeEntry[] = [];
    const changedFiles: Array<{ file: VaultEntry; expectedSha: string }> = [];
    const deletedPaths = [...existing.keys()].filter((path) => !desiredPaths.has(path));
    if (deletedPaths.length > 0 && !allowDeletions) {
      throw new Error(`Local vault is missing ${deletedPaths.length} remote files. Restore from GitHub, or explicitly confirm uploading these deletions.`);
    }
    let changed = 0;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      onProgress?.(`Comparing files ${index + 1}/${files.length}…`);
      const sha = await gitBlobSha(file.bytes);
      if (existing.get(file.path) === sha) continue;
      changedFiles.push({ file, expectedSha: sha });
    }
    const requiredRequests = changedFiles.length + 3;
    if (this.remaining - RATE_LIMIT_RESERVE < requiredRequests) {
      throw new Error(`This backup needs about ${requiredRequests} GitHub API requests, but only ${this.remaining} remain. It will retry after the rate limit resets.`);
    }
    for (let index = 0; index < changedFiles.length; index += 1) {
      const { file, expectedSha } = changedFiles[index];
      onProgress?.(`Uploading changed file ${index + 1}/${changedFiles.length}: ${file.path}`);
      const blob = await this.request<{ sha: string }>(`${base}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: arrayBufferToBase64(file.bytes), encoding: "base64" })
      });
      if (blob.sha !== expectedSha) throw new Error(`GitHub returned an unexpected blob checksum for ${file.path}.`);
      entries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
      changed += 1;
      // Mutation requests cost more against GitHub's secondary limits. Keep a
      // conservative pace instead of bursting through a large first backup.
      await delay(400);
    }
    let deleted = 0;
    for (const path of deletedPaths) {
      entries.push({ path, mode: "100644", type: "blob", sha: null });
      deleted += 1;
    }
    if (entries.length === 0) return { changed: 0, deleted: 0, skipped: true };

    onProgress?.("Creating the repository tree…");
    const newTree = await this.request<{ sha: string }>(`${base}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ ...(baseTreeSha ? { base_tree: baseTreeSha } : {}), tree: entries })
    });
    onProgress?.("Creating the backup commit…");
    const commit = await this.request<{ sha: string }>(`${base}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: `Vault sync ${new Date().toISOString()}`,
        tree: newTree.sha,
        parents: parentSha ? [parentSha] : []
      })
    });
    if (parentSha) {
      onProgress?.("Updating the backup branch…");
      await this.request(writeRefPath, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
    } else {
      await this.request(`${base}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
    }
    return { changed, deleted, commitSha: commit.sha, skipped: false };
  }

  private async initializeEmptyRepository(base: string): Promise<void> {
    try {
      await this.request(`${base}/contents/.github-vault-backup-init`, {
        method: "PUT",
        body: JSON.stringify({
          message: "Initialize vault backup",
          content: btoa("GitHub Vault Backup initialization\n")
        })
      });
    } catch (error) {
      if ((error as Error & { status?: number }).status === 404) {
        throw new Error("GitHub can read this repository but cannot initialize it. Edit or recreate the fine-grained token with Repository permissions → Contents → Read and write for this exact repository, then replace the Obsidian secret.");
      }
      throw error;
    }
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function gitBlobSha(buffer: ArrayBuffer): Promise<string> {
  const content = new Uint8Array(buffer);
  const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
  const combined = new Uint8Array(header.length + content.length);
  combined.set(header);
  combined.set(content, header.length);
  const digest = await crypto.subtle.digest("SHA-1", combined);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
