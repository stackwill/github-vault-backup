export interface BackupSettings {
  secretName: string;
  owner: string;
  repo: string;
  branch: string;
  intervalMinutes: number;
  runOnStartup: boolean;
  exclusions: string[];
  lastBackupAt: number | null;
  lastCommitSha: string;
  lastError: string;
}

export const DEFAULT_SETTINGS: BackupSettings = {
  secretName: "",
  owner: "",
  repo: "",
  branch: "main",
  intervalMinutes: 60,
  runOnStartup: true,
  exclusions: [],
  lastBackupAt: null,
  lastCommitSha: "",
  lastError: ""
};

/** Safety and high-churn exclusions that users cannot accidentally remove. */
export const AUTOMATIC_EXCLUSIONS = [
  ".DS_Store",
  "**/.DS_Store",
  ".git/**",
  ".trash/**",
  ".obsidian/cache/**",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/plugins/edit-history/**",
  ".obsidian/plugins/draftline/**",
  ".obsidian/plugins/github-vault-backup/**"
];

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: { login: string };
  permissions?: { push?: boolean };
}

export interface BackupResult {
  changed: number;
  deleted: number;
  commitSha?: string;
  skipped: boolean;
}
