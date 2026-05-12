import { App, Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { VaultS3Settings } from "../settings";
import { createS3Client, listAllObjects } from "../s3Client";
import { ATTACHMENT_EXT } from "./fileClassifier";
import { parseAllRefs, isExternalRef } from "./linkParser";

function isIgnored(path: string, ignoreFolders: string[]): boolean {
  return path.split("/").some((p) => ignoreFolders.includes(p));
}

class StatusModal extends Modal {
  private data: Record<string, string>;

  constructor(app: App, data: Record<string, string>) {
    super(app);
    this.data = data;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Vault S3 Sync — Status" });

    const grid = contentEl.createDiv({ cls: "s3sync-status-grid" });
    for (const [label, value] of Object.entries(this.data)) {
      grid.createDiv({ cls: "s3sync-status-label", text: label });
      grid.createDiv({ cls: "s3sync-status-value", text: value });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

export async function cmdStatus(app: App, settings: VaultS3Settings): Promise<void> {
  const { attachmentFolders, ignoreFolders, s3 } = settings;
  new Notice("S3 Status: collecting data…");

  // ── Local stats ───────────────────────────────────────────────────────
  let localCount = 0;
  let localSize = 0;
  for (const folderName of attachmentFolders) {
    const folder = app.vault.getAbstractFileByPath(normalizePath(folderName));
    if (!(folder instanceof TFolder)) continue;
    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      const ext = "." + child.extension.toLowerCase();
      if (!ATTACHMENT_EXT.has(ext)) continue;
      localCount++;
      localSize += child.stat.size;
    }
  }

  // ── Markdown notes ────────────────────────────────────────────────────
  const mdFiles = app.vault.getMarkdownFiles().filter(
    (f) => !isIgnored(f.path, ignoreFolders)
  );

  // ── S3 stats ──────────────────────────────────────────────────────────
  let s3Count = 0;
  let s3Size = 0;
  const s3ByFolder: Record<string, number> = {};
  let s3Error = "";

  if (s3.bucket && s3.accessKey && s3.secretKey) {
    try {
      const client = createS3Client(s3);
      const objects = await listAllObjects(client, s3.bucket);
      s3Count = objects.length;
      s3Size = objects.reduce((sum, o) => sum + o.size, 0);
      for (const obj of objects) {
        const folder = obj.key.includes("/") ? obj.key.split("/")[0] : "root";
        s3ByFolder[folder] = (s3ByFolder[folder] ?? 0) + 1;
      }
    } catch (err) {
      s3Error = "Cannot connect to S3";
      console.error("[S3 Status]", err);
    }
  } else {
    s3Error = "S3 not configured";
  }

  // ── S3 refs in vault ──────────────────────────────────────────────────
  const publicEndpoint = s3.publicEndpoint.replace(/\/$/, "");
  let s3RefCount = 0;
  for (const md of mdFiles) {
    try {
      const text = await app.vault.read(md);
      const urls = text.match(/https?:\/\/[^\s)"'>]+/g) ?? [];
      for (const url of urls) {
        if (publicEndpoint && url.startsWith(publicEndpoint)) s3RefCount++;
      }
    } catch { /* skip */ }
  }

  // ── Build display data ────────────────────────────────────────────────
  const data: Record<string, string> = {
    "📝 Markdown files": String(mdFiles.length),
    "📎 Local attachments": `${localCount} files (${(localSize / 1024 / 1024).toFixed(2)} MB)`,
    "🔗 S3 links in notes": String(s3RefCount),
    "☁️ S3 objects": s3Error || `${s3Count} files (${(s3Size / 1024 / 1024).toFixed(2)} MB)`,
  };

  if (!s3Error) {
    for (const [folder, count] of Object.entries(s3ByFolder).sort()) {
      data[`  └ ${folder}/`] = `${count} objects`;
    }
  }

  data["🗑️ Trash folder"] = settings.trashFolder;
  data["🔒 Quarantine prefix"] = s3.quarantineFolder + "/";

  new StatusModal(app, data).open();
  console.log("[S3 Status]", data);
}
