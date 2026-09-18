import { App, PluginSettingTab, Setting } from "obsidian";
import type GitHubBackupPlugin from "./main";
import { ConnectionModal } from "./connection-modal";
import { AUTOMATIC_EXCLUSIONS } from "./types";

export class BackupSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GitHubBackupPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GitHub Vault Sync" });

    const destination = this.plugin.isConfigured()
      ? `${this.plugin.settings.owner}/${this.plugin.settings.repo} · ${this.plugin.settings.branch}`
      : "Not connected";
    new Setting(containerEl)
      .setName("GitHub connection")
      .setDesc(destination)
      .addButton((button) => button
        .setButtonText(this.plugin.isConfigured() ? "Change" : "Connect")
        .setCta()
        .onClick(() => new ConnectionModal(this.app, this.plugin).open()));

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("GitHub is pulled first, then local non-conflicting changes are uploaded. Unchanged vaults do not create a commit.")
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

    new Setting(containerEl)
      .setName("Sync when the vault opens")
      .setDesc("Pull, merge, and upload shortly after the vault is ready.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.runOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.runOnStartup = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc(`Additional exclusions, one per line. Automatically excluded: ${AUTOMATIC_EXCLUSIONS.join(", ")}`)
      .addTextArea((text) => {
        text.setValue(this.plugin.settings.exclusions.join("\n"));
        text.inputEl.rows = 7;
        text.inputEl.cols = 36;
        text.onChange(async (value) => {
          this.plugin.settings.exclusions = value.split("\n").map((line) => line.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc(this.plugin.statusDescription())
      .addButton((button) => button.setButtonText("Run sync").onClick(() => void this.plugin.runBackup(true)));
  }
}
