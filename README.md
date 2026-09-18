# GitHub Vault Backup

An Obsidian community plugin that mirrors a vault to a dedicated private GitHub repository on a schedule.

## Features

- Guided connection modal that first reuses an existing authenticated GitHub CLI session on desktop
- Fine-grained GitHub token fallback and private repository selection (also used on mobile)
- Tokens stored in Obsidian SecretStorage, never in plugin data or the backup
- Works without a local Git installation, including on mobile
- One commit per backup with binary-file support and remote deletion mirroring
- SHA comparison uploads only changed files
- Rate-limit reserve, 30-minute minimum schedule, and no commit when nothing changed
- Manual ribbon and command-palette backup
- Automatic exclusion of workspace state, caches, Edit History, Draftline, trash, Git metadata, and the backup plugin itself
- Multi-device three-way synchronization with conflict detection and deletion protection
- Restore-from-GitHub workflow for new devices
- In-plugin update checks backed by GitHub release assets

## Set up

1. Create a new **private** GitHub repository. An empty repository is recommended.
2. In Obsidian, enable the plugin and select **Connect**.
3. If GitHub CLI is already authenticated (`gh auth login`), the plugin detects it and continues directly to repository selection.
4. Otherwise, create a fine-grained personal access token restricted to that repository with **Contents: Read and write** permission and save it as an Obsidian secret.
5. Select the repository and run the first backup.

An SSH key by itself proves Git transport access but cannot list and validate private repositories through GitHub's API. A `gh` login can use your existing device setup while supplying the API authentication the plugin needs.

The selected branch is treated as a mirror of the vault. Use a dedicated repository: files present in the branch but absent from the vault are deleted by the next backup.

## Multiple devices

On a new device, connect the same repository and choose **Restore from GitHub** before uploading. Before every upload, the plugin compares the device's last synchronized commit with the current remote commit. Non-conflicting remote changes are pulled first; conflicting paths stop the sync without modifying files. Remote deletions always require a separate confirmation.

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
