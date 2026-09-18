import { App, Modal, Setting } from "obsidian";
import type GitHubBackupPlugin from "./main";
import { ConnectionModal } from "./connection-modal";
import { AUTOMATIC_EXCLUSIONS } from "./types";

export class BackupModal extends Modal {
  private statusEl?: HTMLElement;
  private runButton?: HTMLButtonElement;
  private unsubscribe?: () => void;

  constructor(app: App, private readonly plugin: GitHubBackupPlugin) { super(app); }

  onOpen(): void {
    this.unsubscribe = this.plugin.subscribeToBackupStatus((message, finished) => {
      if (finished) this.render();
      else {
        this.statusEl?.setText(message);
        if (this.runButton) {
          this.runButton.disabled = true;
          this.runButton.setText("Syncing…");
        }
      }
    });
    this.render();
  }
  onClose(): void { this.unsubscribe?.(); this.contentEl.empty(); }

  private render(): void {
    this.contentEl.empty();
    this.modalEl.addClass("github-backup-modal");
    this.contentEl.createEl("h2", { text: "GitHub Vault Sync" });
    this.contentEl.createEl("p", { text: "GitHub is checked first as the shared source of truth. Non-conflicting changes from every device are merged before this device uploads." });

    const summary = this.contentEl.createDiv("github-backup-summary");
    summary.createEl("strong", { text: this.plugin.currentStatusLabel() });
    summary.createDiv({ text: this.plugin.statusDescription(), cls: "setting-item-description" });
    if (this.plugin.settings.lastCommitSha) {
      summary.createDiv({ text: `Last commit: ${this.plugin.settings.lastCommitSha.slice(0, 7)}`, cls: "setting-item-description github-backup-code" });
    }

    new Setting(this.contentEl)
      .setName("Repository")
      .setDesc(`${this.plugin.settings.owner}/${this.plugin.settings.repo} · ${this.plugin.settings.branch}`)
      .addButton((button) => button.setButtonText("Change connection").onClick(() => {
        this.close();
        new ConnectionModal(this.app, this.plugin).open();
      }));

    new Setting(this.contentEl)
      .setName("Sync interval")
      .setDesc("Checks that find no changes do not create a commit.")
      .addDropdown((dropdown) => dropdown
        .addOption("5", "Every 5 minutes")
        .addOption("15", "Every 15 minutes")
        .addOption("30", "Every 30 minutes")
        .addOption("60", "Every hour")
        .addOption("180", "Every 3 hours")
        .addOption("360", "Every 6 hours")
        .addOption("720", "Every 12 hours")
        .addOption("1440", "Daily")
        .setValue(String(this.plugin.settings.intervalMinutes))
        .onChange(async (value) => {
          this.plugin.settings.intervalMinutes = Number(value);
          await this.plugin.saveSettings();
          this.plugin.restartSchedule();
        }));

    new Setting(this.contentEl)
      .setName("Sync when the vault opens")
      .setDesc("Pull the latest GitHub changes, merge, and upload shortly after Obsidian opens.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.runOnStartup).onChange(async (value) => {
        this.plugin.settings.runOnStartup = value;
        await this.plugin.saveSettings();
      }));

    new Setting(this.contentEl)
      .setName("Excluded paths")
      .setDesc("Additional exclusions, one vault-relative glob per line.")
      .addTextArea((text) => {
        text.setValue(this.plugin.settings.exclusions.join("\n"));
        text.inputEl.rows = 5;
        text.inputEl.cols = 34;
        text.onChange(async (value) => {
          this.plugin.settings.exclusions = value.split("\n").map((line) => line.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });
    const automatic = this.contentEl.createEl("details");
    automatic.createEl("summary", { text: "Automatically excluded volatile paths" });
    automatic.createEl("pre", { text: AUTOMATIC_EXCLUSIONS.join("\n"), cls: "github-backup-code" });

    this.statusEl = this.contentEl.createDiv("github-backup-status");
    const actions = this.contentEl.createDiv("github-backup-actions");
    this.runButton = actions.createEl("button", { text: "Sync now", cls: "mod-cta" });
    if (this.plugin.currentStatusLabel() === "Sync in progress") {
      this.runButton.disabled = true;
      this.runButton.setText("Syncing…");
    }
    this.runButton.addEventListener("click", () => void this.runBackup());
    if (this.plugin.settings.lastError.includes("explicitly confirm uploading these deletions")) {
      const confirmDelete = actions.createEl("button", { text: "Confirm remote deletions", cls: "mod-warning" });
      confirmDelete.addEventListener("click", async () => {
        confirmDelete.disabled = true;
        await this.plugin.runBackup(false, true);
        this.render();
      });
    }
    const restore = actions.createEl("button", { text: "Restore from GitHub" });
    restore.addEventListener("click", async () => {
      restore.disabled = true;
      await this.plugin.restoreFromGitHub();
      this.render();
    });
    const update = actions.createEl("button", { text: "Check for plugin update" });
    update.addEventListener("click", async () => {
      update.disabled = true;
      this.statusEl?.setText("Checking GitHub releases…");
      try {
        this.statusEl?.setText(await this.plugin.updatePlugin());
      } catch (error) {
        this.statusEl?.setText(error instanceof Error ? error.message : String(error));
        this.statusEl?.addClass("is-error");
      } finally {
        update.disabled = false;
      }
    });
  }

  private async runBackup(): Promise<void> {
    if (!this.runButton || !this.statusEl) return;
    this.runButton.disabled = true;
    this.statusEl.removeClass("is-error");
    this.statusEl.setText("Reading vault and comparing with GitHub…");
    await this.plugin.runBackup(false);
    this.render();
  }
}
