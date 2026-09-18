import { App, Modal, Platform, SecretComponent, Setting } from "obsidian";
import type GitHubBackupPlugin from "./main";
import { GitHubClient } from "./github";
import type { GitHubRepository } from "./types";
import { getExistingGitHubCliToken } from "./device-auth";

const DEVICE_SECRET_NAME = "github-vault-backup-device";

export class ConnectionModal extends Modal {
  private secretName: string;
  private statusEl?: HTMLElement;
  private actionsEl?: HTMLElement;
  private repositories: GitHubRepository[] = [];

  constructor(app: App, private readonly plugin: GitHubBackupPlugin) {
    super(app);
    this.secretName = plugin.settings.secretName;
  }

  onOpen(): void {
    this.renderAuthentication();
    void this.detectDeviceAuthentication();
  }
  onClose(): void { this.contentEl.empty(); }

  private frame(step: 1 | 2): void {
    this.contentEl.empty();
    this.modalEl.addClass("github-backup-modal");
    this.contentEl.createEl("h2", { text: "Connect GitHub sync" });
    const steps = this.contentEl.createDiv("github-backup-steps");
    steps.createSpan({ text: "1  Authenticate", cls: `github-backup-step${step === 1 ? " is-active" : ""}` });
    steps.createSpan({ text: "→" });
    steps.createSpan({ text: "2  Choose repository", cls: `github-backup-step${step === 2 ? " is-active" : ""}` });
  }

  private renderAuthentication(): void {
    this.frame(1);
    this.contentEl.createEl("p", {
      text: Platform.isDesktopApp
        ? "First, the plugin checks for an existing GitHub CLI login on this device. If one is not available, connect with a fine-grained token below."
        : "Connect with a fine-grained GitHub token. Obsidian stores it in SecretStorage; this plugin stores only its secret name."
    });
    if (Platform.isDesktopApp) {
      const device = this.contentEl.createDiv("github-backup-summary");
      device.createEl("strong", { text: "Existing device login" });
      device.createDiv({ text: "Checking GitHub CLI authentication…", cls: "setting-item-description github-backup-device-status" });
    }
    const link = this.contentEl.createEl("a", {
      text: "Create a fine-grained token on GitHub ↗",
      href: "https://github.com/settings/personal-access-tokens/new"
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener noreferrer");

    new Setting(this.contentEl)
      .setName("GitHub token")
      .setDesc("Choose an existing Obsidian secret or create a new one.")
      .addComponent((container) => new SecretComponent(this.app, container)
        .setValue(this.secretName)
        .onChange((value) => { this.secretName = value; }));

    this.statusEl = this.contentEl.createDiv("github-backup-status");
    this.actionsEl = this.contentEl.createDiv("github-backup-actions");
    const connect = this.actionsEl.createEl("button", { text: "Check connection", cls: "mod-cta" });
    connect.addEventListener("click", () => void this.authenticate(connect));
  }

  private async detectDeviceAuthentication(): Promise<void> {
    if (!Platform.isDesktopApp) return;
    const deviceStatus = this.contentEl.querySelector<HTMLElement>(".github-backup-device-status");
    const token = await getExistingGitHubCliToken();
    if (!deviceStatus || !this.contentEl.isConnected) return;
    if (!token) {
      deviceStatus.setText("No GitHub CLI login was found. You can run “gh auth login” outside Obsidian, reopen this window, or use a token below.");
      return;
    }
    deviceStatus.setText("GitHub CLI login found. Verifying repository access…");
    try {
      const client = new GitHubClient(token);
      const [viewer, repositories] = await Promise.all([client.getViewer(), client.listPrivateRepositories()]);
      if (repositories.length === 0) throw new Error("The login has no writable private repositories.");
      this.app.secretStorage.setSecret(DEVICE_SECRET_NAME, token);
      this.secretName = DEVICE_SECRET_NAME;
      this.repositories = repositories;
      this.renderRepositories(viewer.login);
    } catch (error) {
      deviceStatus.setText(`A GitHub CLI login was found but could not be used: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async authenticate(button: HTMLButtonElement): Promise<void> {
    this.setStatus("Checking GitHub…");
    button.disabled = true;
    try {
      if (!this.secretName) throw new Error("Choose or create a secret first.");
      const token = this.app.secretStorage.getSecret(this.secretName);
      if (!token) throw new Error("The selected secret is empty or unavailable.");
      const client = new GitHubClient(token);
      const [viewer, repositories] = await Promise.all([client.getViewer(), client.listPrivateRepositories()]);
      this.repositories = repositories;
      if (repositories.length === 0) throw new Error("No writable private repositories are available to this token.");
      this.renderRepositories(viewer.login);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), true);
      button.disabled = false;
    }
  }

  private renderRepositories(login: string): void {
    this.frame(2);
    this.contentEl.createEl("p", { text: `Connected as ${login}. Select a dedicated private repository. Its selected branch will mirror this vault, including file deletions.` });
    let selected = this.repositories.find((repo) => repo.full_name === `${this.plugin.settings.owner}/${this.plugin.settings.repo}`) ?? this.repositories[0];
    new Setting(this.contentEl)
      .setName("Sync repository")
      .setDesc(`${this.repositories.length} writable private ${this.repositories.length === 1 ? "repository" : "repositories"} available`)
      .addDropdown((dropdown) => {
        for (const repo of this.repositories) dropdown.addOption(repo.full_name, repo.full_name);
        dropdown.setValue(selected.full_name).onChange((value) => {
          selected = this.repositories.find((repo) => repo.full_name === value) ?? selected;
        });
      });
    this.contentEl.createEl("p", { text: "Tip: use a dedicated private repository. On additional devices, GitHub is pulled before any local changes are uploaded.", cls: "setting-item-description" });
    this.statusEl = this.contentEl.createDiv("github-backup-status");
    const actions = this.contentEl.createDiv("github-backup-actions");
    const back = actions.createEl("button", { text: "Back" });
    back.addEventListener("click", () => this.renderAuthentication());
    const save = actions.createEl("button", { text: "Save and back up", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      this.setStatus("Saving connection…");
      this.plugin.settings.secretName = this.secretName;
      this.plugin.settings.owner = selected.owner.login;
      this.plugin.settings.repo = selected.name;
      this.plugin.settings.branch = selected.default_branch || "main";
      await this.plugin.saveSettings();
      this.close();
      this.plugin.openDashboard();
    });
  }

  private setStatus(message: string, error = false): void {
    if (!this.statusEl) return;
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", error);
  }
}
