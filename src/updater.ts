import { requestUrl, type App, type PluginManifest } from "obsidian";

const RELEASE_API = "https://api.github.com/repos/stackwill/github-vault-backup/releases/latest";
const REQUIRED_ASSETS = ["main.js", "manifest.json", "styles.css"] as const;

interface ReleaseAsset { name: string; browser_download_url: string }
interface LatestRelease { tag_name: string; assets: ReleaseAsset[] }

export interface UpdateResult { updated: boolean; message: string }

export async function installLatestRelease(app: App, manifest: PluginManifest): Promise<UpdateResult> {
  const response = await requestUrl({ url: RELEASE_API, headers: { Accept: "application/vnd.github+json" }, throw: false });
  if (response.status === 404) return { updated: false, message: "No published plugin release is available yet." };
  if (response.status < 200 || response.status >= 300) throw new Error(`Update check failed: GitHub HTTP ${response.status}`);
  const release = response.json as LatestRelease;
  const latest = release.tag_name.replace(/^v/, "");
  if (compareVersions(latest, manifest.version) <= 0) return { updated: false, message: `Version ${manifest.version} is already current.` };

  const downloads = new Map<string, ArrayBuffer>();
  for (const filename of REQUIRED_ASSETS) {
    const asset = release.assets.find((item) => item.name === filename);
    if (!asset) throw new Error(`Release ${release.tag_name} is missing ${filename}.`);
    const file = await requestUrl({ url: asset.browser_download_url, throw: false });
    if (file.status < 200 || file.status >= 300) throw new Error(`Could not download ${filename}: HTTP ${file.status}`);
    downloads.set(filename, file.arrayBuffer);
  }
  if (!manifest.dir) throw new Error("Obsidian did not provide the plugin installation directory.");
  for (const filename of REQUIRED_ASSETS) {
    await app.vault.adapter.writeBinary(`${manifest.dir}/${filename}`, downloads.get(filename)!);
  }
  return { updated: true, message: `Installed ${release.tag_name}. Reload Obsidian to activate it.` };
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
