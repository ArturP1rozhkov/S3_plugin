import { App, Notice, TFile, TFolder } from "obsidian";
import type { VaultS3Settings } from "../settings";
import { createS3Client, listAllObjects, moveObject, deleteObject } from "../s3Client";

function isIgnored(path: string, ignoreFolders: string[]): boolean {
  return path.split("/").some((p) => ignoreFolders.includes(p));
}

async function collectS3Keys(app: App, settings: VaultS3Settings): Promise<Set<string>> {
  const { ignoreFolders, s3, pdfDummyFolder } = settings;
  const publicEndpoint = s3.publicEndpoint.replace(/\/$/, "");
  const s3Keys = new Set<string>();

  // ── Scan all markdown files for S3 URLs ───────────────────────────────
  const mdFiles = app.vault.getMarkdownFiles().filter(
    (f) => !isIgnored(f.path, ignoreFolders)
  );

  for (const md of mdFiles) {
    try {
      const text = await app.vault.read(md);
      const urlMatches = text.match(/https?:\/\/[^\s)"'>]+/g) ?? [];
      for (const url of urlMatches) {
        const clean = url.replace(/[.,)'">\]]+$/, "");
        if (publicEndpoint && clean.startsWith(publicEndpoint)) {
          const key = clean.slice(publicEndpoint.length + 1);
          if (key) s3Keys.add(key);
        }
      }
    } catch { /* skip */ }
  }

  // ── Scan dummy PDF folder ─────────────────────────────────────────────
  const dummyFolder = app.vault.getAbstractFileByPath(pdfDummyFolder);
  if (dummyFolder instanceof TFolder) {
    for (const child of dummyFolder.children) {
      if (child instanceof TFile && child.extension.toLowerCase() === "pdf") {
        try {
          const content = (await app.vault.read(child)).trim();
          if (publicEndpoint && content.startsWith(publicEndpoint)) {
            const key = content.slice(publicEndpoint.length + 1);
            if (key) s3Keys.add(key);
          }
        } catch { /* skip */ }
      }
    }
  }

  return s3Keys;
}

export async function cmdCleanupS3(
  app: App,
  settings: VaultS3Settings,
  dryRun = false
): Promise<{ moved: number }> {
  const { s3 } = settings;
  const quarantinePrefix = s3.quarantineFolder.replace(/\/$/, "") + "/";
  const retentionDays = s3.quarantineRetentionDays ?? 14;

  if (!s3.bucket || !s3.accessKey || !s3.secretKey) {
    new Notice("⚠️ S3 credentials not configured.", 5000);
    return { moved: 0 };
  }

  const client = createS3Client(s3);
  new Notice("S3 Cleanup: listing bucket objects…");

  // ── Get referenced keys from vault ────────────────────────────────────
  const referencedKeys = await collectS3Keys(app, settings);
  console.log(`[S3 CleanupS3] Referenced keys in vault: ${referencedKeys.size}`);

  // ── List all S3 objects ───────────────────────────────────────────────
  let allObjects: Awaited<ReturnType<typeof listAllObjects>> = [];
  try {
    allObjects = await listAllObjects(client, s3.bucket);
  } catch (err) {
    new Notice("❌ Cannot list S3 objects. Check credentials.", 6000);
    console.error("[S3 CleanupS3] List failed", err);
    return { moved: 0 };
  }

  // ── Find orphans (exclude quarantine prefix) ──────────────────────────
  const orphans = allObjects.filter(
    (obj) => !obj.key.startsWith(quarantinePrefix) && !referencedKeys.has(obj.key)
  );
  const totalSize = orphans.reduce((s, o) => s + o.size, 0);

  console.log(`[S3 CleanupS3] Total: ${allObjects.length}, orphans: ${orphans.length}, ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

  if (dryRun) {
    const lines = orphans.map((o) => `  ${o.key}  (${(o.size / 1024).toFixed(1)} KB)`);
    new Notice(`DRY RUN S3: ${orphans.length} orphan objects, ${(totalSize / 1024 / 1024).toFixed(2)} MB`, 8000);
    console.log("[S3 CleanupS3] DRY RUN:\n" + lines.join("\n"));
    return { moved: 0 };
  }

  // ── Delete expired quarantine objects ─────────────────────────────────
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let deleted = 0;
  for (const obj of allObjects) {
    if (obj.key.startsWith(quarantinePrefix) && obj.lastModified < cutoff) {
      try {
        await deleteObject(client, s3.bucket, obj.key);
        deleted++;
      } catch { /* skip */ }
    }
  }

  // ── Move orphans to quarantine ────────────────────────────────────────
  let moved = 0;
  for (const obj of orphans) {
    const quarantineKey = quarantinePrefix + obj.key.replace(/\//g, "_");
    try {
      await moveObject(client, s3.bucket, obj.key, quarantineKey);
      console.log(`[S3 CleanupS3] → quarantine: ${obj.key}`);
      moved++;
    } catch (err) {
      console.warn(`[S3 CleanupS3] Could not move: ${obj.key}`, err);
    }
  }

  const msg = `🪣 S3 Cleanup: ${moved} objects → quarantine, ${deleted} expired deleted`;
  new Notice(msg, 8000);
  console.log("[S3 CleanupS3] " + msg);

  return { moved };
}
