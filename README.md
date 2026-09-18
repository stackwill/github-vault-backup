# GitHub Vault Sync & Backup

An Obsidian community plugin that synchronizes multiple devices through a dedicated private GitHub repository while preserving versioned backups.

## Features

- Guided connection modal that first reuses an existing authenticated GitHub CLI session on desktop
- Fine-grained GitHub token fallback and private repository selection (also used on mobile)
- Tokens stored in Obsidian SecretStorage, never in plugin data or the backup
- Works without a local Git installation, including on mobile
- Pull-first synchronization with one commit per upload and binary-file support
- SHA comparison uploads only changed files
- Rate-limit reserve, 30-minute minimum schedule, and no commit when nothing changed
- Manual ribbon and command-palette sync
- Automatic exclusion of workspace state, caches, macOS `.DS_Store` files, Edit History, Draftline, trash, Git metadata, and the backup plugin itself
- Multi-device three-way synchronization with conflict detection and deletion protection
- Restore-from-GitHub workflow for new devices
- In-plugin update checks backed by GitHub release assets

## Set up

1. Create a new **private** GitHub repository. An empty repository is recommended.
2. In Obsidian, enable the plugin and select **Connect**.
3. If GitHub CLI is already authenticated (`gh auth login`), the plugin detects it and continues directly to repository selection.
4. Otherwise, create a fine-grained personal access token restricted to that repository with **Contents: Read and write** permission and save it as an Obsidian secret.
5. Select the repository and run the first sync. GitHub is always checked first.

An SSH key by itself proves Git transport access but cannot list and validate private repositories through GitHub's API. A `gh` login can use your existing device setup while supplying the API authentication the plugin needs.

The selected branch is the shared source of truth. Each device pulls and merges the latest remote state before uploading. Use a dedicated repository.

## Multiple devices

On a new device, connect the same repository and choose **Sync now**. A device-local identity ensures GitHub is authoritative on its first sync: remote paths replace differing local copies, while local-only files are preserved for upload. Before every later upload, the plugin compares the device's last synchronized commit with the current remote commit. Changes to different files merge automatically; the same file changed on both devices stops with a conflict and modifies neither copy. Remote deletions always require a separate confirmation.

## Releases

Pushing `main` makes GitHub Actions build the plugin and create or update the release matching `manifest.json`. It attaches `main.js`, `manifest.json`, and `styles.css`; installed copies can fetch them with **Check for plugin update**.

## Development

```bash
bun install
bun run build
```

Copy `manifest.json`, `main.js`, and `styles.css` into `.obsidian/plugins/github-vault-backup/` in a test vault.

## Security notes

The plugin never writes the token into the vault. Obsidian SecretStorage is the source of truth; `data.json` contains only the chosen secret's name and backup settings. Repository privacy is checked again before every backup.
