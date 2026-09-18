import { Notice, Plugin, normalizePath } from "obsidian";
import { GitHubClient, gitBlobSha } from "./github";
import { ConnectionModal } from "./connection-modal";
import { BackupSettingTab } from "./settings-tab";
import { AUTOMATIC_EXCLUSIONS, DEFAULT_SETTINGS, type BackupSettings } from "./types";
import { isExcluded } from "./path-utils";
import { BackupModal } from "./backup-modal";
import { installLatestRelease } from "./updater";

export default class GitHubBackupPlugin extends Plugin {
  settings: BackupSettings = { ...DEFAULT_SETTINGS };
  private backupRunning = false;
  private scheduleId?: number;
  private statusBar?: HTMLElement;
  private currentDeviceId = "";
  private backupStatus = "Idle";
  private readonly backupStatusListeners = new Set<(message: string, finished: boolean) => void>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.currentDeviceId = this.getOrCreateDeviceId();
    this.statusBar = this.addStatusBarItem();
    this.updateStatusBar();
    this.addRibbonIcon("refresh-cw", "Sync vault with GitHub", () => {
      if (this.isConfigured()) this.openDashboard();
      else new ConnectionModal(this.app, this).open();
    });
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.isConfigured() ? this.openDashboard() : new ConnectionModal(this.app, this).open()
    });
    this.addCommand({ id: "configure", name: "Configure GitHub sync", callback: () => new ConnectionModal(this.app, this).open() });
    this.addSettingTab(new BackupSettingTab(this.app, this));
    this.restartSchedule();
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.runOnStartup && this.isConfigured()) {
        window.setTimeout(() => void this.runBackup(false), 5_000);
      }
    });
  }

  onunload(): void { if (this.scheduleId !== undefined) window.clearInterval(this.scheduleId); }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData() as Partial<BackupSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
    this.settings.exclusions = (saved?.exclusions ?? [...DEFAULT_SETTINGS.exclusions])
      .filter((pattern) => !AUTOMATIC_EXCLUSIONS.includes(pattern));
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); this.updateStatusBar(); }

  isConfigured(): boolean {
    return Boolean(this.settings.secretName && this.settings.owner && this.settings.repo && this.settings.branch);
  }

  openDashboard(): void { new BackupModal(this.app, this).open(); }

  async updatePlugin(): Promise<string> {
    const result = await installLatestRelease(this.app, this.manifest);
    return result.message;
  }

  subscribeToBackupStatus(listener: (message: string, finished: boolean) => void): () => void {
    this.backupStatusListeners.add(listener);
    return () => this.backupStatusListeners.delete(listener);
  }

  restartSchedule(): void {
    if (this.scheduleId !== undefined) window.clearInterval(this.scheduleId);
    const milliseconds = Math.max(5, this.settings.intervalMinutes) * 60_000;
    this.scheduleId = window.setInterval(() => void this.runBackup(false), milliseconds);
    this.registerInterval(this.scheduleId);
  }

  async runBackup(showNotices: boolean, allowDeletions = false): Promise<void> {
    if (this.backupRunning) {
      if (showNotices) new Notice("A GitHub sync is already running.");
      return;
    }
    if (!this.isConfigured()) {
      if (showNotices) new ConnectionModal(this.app, this).open();
      return;
    }
    const token = this.app.secretStorage.getSecret(this.settings.secretName);
    if (!token) {
      this.settings.lastError = "GitHub token is missing from Obsidian SecretStorage.";
      await this.saveSettings();
      if (showNotices) new Notice(this.settings.lastError);
      return;
    }
    this.backupRunning = true;
    this.setBackupStatus("Reading vault files…");
    this.statusBar?.setText("GitHub sync: working…");
    try {
      const client = new GitHubClient(token);
      const repo = await client.getRepository(this.settings.owner, this.settings.repo);
      if (!repo.private) throw new Error("Sync stopped: the selected GitHub repository is not private.");
      const isFirstSyncOnDevice = this.settings.lastSyncedDeviceId !== this.currentDeviceId;
      await this.reconcileRemote(client, isFirstSyncOnDevice);
      const files = await this.readVaultFiles();
      const result = await client.backup(this.settings.owner, this.settings.repo, this.settings.branch, files, this.settings.lastCommitSha, allowDeletions, (message) => this.setBackupStatus(message));
      this.settings.lastBackupAt = Date.now();
      this.settings.lastCommitSha = result.commitSha ?? this.settings.lastCommitSha;
      this.settings.lastSyncedDeviceId = this.currentDeviceId;
      this.settings.lastError = "";
      await this.saveSettings();
      this.setBackupStatus(result.skipped ? "Already up to date." : `Complete: ${result.changed} changed, ${result.deleted} deleted.`);
      if (showNotices) {
        new Notice(result.skipped ? "GitHub sync is already up to date." : `GitHub sync complete: ${result.changed} uploaded, ${result.deleted} deleted.`);
      }
    } catch (error) {
      this.settings.lastError = error instanceof Error ? error.message : String(error);
      await this.saveSettings();
      this.setBackupStatus(`Failed: ${this.settings.lastError}`);
      console.error("GitHub Vault Sync failed", error);
      if (showNotices) new Notice(`GitHub sync failed: ${this.settings.lastError}`, 10_000);
    } finally {
      this.backupRunning = false;
      this.updateStatusBar();
      for (const listener of this.backupStatusListeners) listener(this.backupStatus, true);
    }
  }

  async restoreFromGitHub(): Promise<void> {
    if (this.backupRunning) return;
    const token = this.app.secretStorage.getSecret(this.settings.secretName);
    if (!token) throw new Error("GitHub token is missing from Obsidian SecretStorage.");
    this.backupRunning = true;
    this.setBackupStatus("Inspecting the GitHub backup…");
    try {
      await this.reconcileRemote(new GitHubClient(token), true);
      this.settings.lastSyncedDeviceId = this.currentDeviceId;
      this.settings.lastBackupAt = Date.now();
      this.settings.lastError = "";
      await this.saveSettings();
      this.setBackupStatus("Restore complete. Local-only files were preserved.");
    } catch (error) {
      this.settings.lastError = error instanceof Error ? error.message : String(error);
      await this.saveSettings();
      this.setBackupStatus(`Restore failed: ${this.settings.lastError}`);
    } finally {
      this.backupRunning = false;
      this.updateStatusBar();
      for (const listener of this.backupStatusListeners) listener(this.backupStatus, true);
    }
  }

  statusDescription(): string {
    if (this.backupRunning) return this.backupStatus;
    if (this.settings.lastError) return `Last error: ${this.settings.lastError}`;
    if (!this.settings.lastBackupAt) return "No successful sync yet.";
    return `Last successful sync: ${new Date(this.settings.lastBackupAt).toLocaleString()}`;
  }

  private setBackupStatus(message: string): void {
    this.backupStatus = message;
    for (const listener of this.backupStatusListeners) listener(message, false);
  }

  private getOrCreateDeviceId(): string {
    const secretId = "github-vault-backup-device-id";
    const existing = this.app.secretStorage.getSecret(secretId);
    if (existing) return existing;
    const created = crypto.randomUUID();
    this.app.secretStorage.setSecret(secretId, created);
    return created;
  }

  private async reconcileRemote(client: GitHubClient, allowFirstRestore: boolean): Promise<void> {
    this.setBackupStatus("Comparing this device with GitHub…");
    const remote = await client.getSnapshot(this.settings.owner, this.settings.repo, this.settings.branch);
    if (remote.commitSha === this.settings.lastCommitSha && !allowFirstRestore) return;
    if (!this.settings.lastCommitSha && !allowFirstRestore) {
      throw new Error("A backup already exists on GitHub. Use Restore from GitHub before this device can upload.");
    }

    const exclusions = [...AUTOMATIC_EXCLUSIONS, ...this.settings.exclusions];
    const relevant = (path: string): boolean => !isExcluded(path, exclusions);
    const remoteFiles = new Map([...remote.files].filter(([path]) => relevant(path)));
    const baseFiles = this.settings.lastCommitSha && !allowFirstRestore
      ? (await client.getSnapshot(this.settings.owner, this.settings.repo, this.settings.branch, this.settings.lastCommitSha)).files
      : new Map<string, string>();
    const localEntries = await this.readVaultFiles();
    const localFiles = new Map<string, string>();
    for (let index = 0; index < localEntries.length; index += 1) {
      this.setBackupStatus(`Checking local changes ${index + 1}/${localEntries.length}…`);
      localFiles.set(localEntries[index].path, await gitBlobSha(localEntries[index].bytes));
    }

    const allPaths = new Set([...baseFiles.keys(), ...remoteFiles.keys(), ...localFiles.keys()]);
    const conflicts: string[] = [];
    const pulls: Array<{ path: string; sha?: string }> = [];
    for (const path of allPaths) {
      if (!relevant(path)) continue;
      const baseSha = baseFiles.get(path);
      const remoteSha = remoteFiles.get(path);
      const localSha = localFiles.get(path);
      // On a device's first sync, GitHub is authoritative for paths it already
      // contains. Local-only files are preserved and uploaded after the pull.
      if (allowFirstRestore) {
        if (remoteSha && localSha !== remoteSha) pulls.push({ path, sha: remoteSha });
        continue;
      }
      const localChanged = localSha !== baseSha;
      const remoteChanged = remoteSha !== baseSha;
      if (localChanged && remoteChanged && localSha !== remoteSha) conflicts.push(path);
      else if (remoteChanged && !localChanged) pulls.push({ path, sha: remoteSha });
    }
    if (conflicts.length > 0) {
      throw new Error(`Sync conflict on ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : ""}. No files were changed.`);
    }

    for (let index = 0; index < pulls.length; index += 1) {
      const change = pulls[index];
      this.setBackupStatus(`Pulling remote change ${index + 1}/${pulls.length}: ${change.path}`);
      if (!change.sha) {
        if (await this.app.vault.adapter.exists(change.path)) await this.app.vault.adapter.remove(change.path);
      } else {
        await this.ensureParentFolders(change.path);
        const bytes = await client.downloadBlob(this.settings.owner, this.settings.repo, change.sha);
        await this.app.vault.adapter.writeBinary(change.path, bytes);
      }
    }
    this.settings.lastCommitSha = remote.commitSha;
    await this.saveSettings();
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.adapter.mkdir(current);
    }
  }

  currentStatusLabel(): string {
    if (this.backupRunning) return "Sync in progress";
    if (this.settings.lastError) return "Sync needs attention";
    if (this.settings.lastBackupAt) return "Sync is healthy";
    return "Ready for first sync";
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;
    if (this.settings.lastError) this.statusBar.setText("GitHub sync: attention needed");
    else if (this.settings.lastBackupAt) this.statusBar.setText(`GitHub sync: ${new Date(this.settings.lastBackupAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    else this.statusBar.setText("GitHub sync: not run");
    this.statusBar.setAttr("aria-label", this.statusDescription());
  }

  private async readVaultFiles(): Promise<Array<{ path: string; bytes: ArrayBuffer }>> {
    const paths: string[] = [];
    const exclusions = [...AUTOMATIC_EXCLUSIONS, ...this.settings.exclusions];
    const walk = async (folder: string): Promise<void> => {
      const listing = await this.app.vault.adapter.list(folder);
      for (const file of listing.files) {
        const path = normalizePath(file);
        if (!isExcluded(path, exclusions)) paths.push(path);
      }
      for (const child of listing.folders) {
        const path = normalizePath(child);
        if (!isExcluded(`${path}/`, exclusions) && !isExcluded(`${path}/placeholder`, exclusions)) await walk(path);
      }
    };
    await walk("");
    paths.sort();
    const output: Array<{ path: string; bytes: ArrayBuffer }> = [];
    for (const path of paths) {
      const bytes = await this.app.vault.adapter.readBinary(path);
      if (bytes.byteLength > 95 * 1024 * 1024) throw new Error(`${path} exceeds GitHub's 100 MB file limit.`);
      output.push({ path, bytes });
    }
    return output;
  }
}
