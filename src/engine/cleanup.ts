import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { VaultS3Settings } from "../settings";
import type { SyncState } from "../state";
import { ATTACHMENT_EXT } from "./fileClassifier";
import { parseAllRefs, isExternalRef, isAlreadyS3Ref } from "./linkParser";

function isIgnored(path: string, ignoreFolders: string[]): boolean {
  return path.split("/").some((p) => ignoreFolders.includes(p));
}

function isIgnoredFile(name: string, ignoreFiles: string[]): boolean {
  for (const pattern of ignoreFiles) {
    if (pattern.startsWith("*")) {
      if (name.endsWith(pattern.slice(1))) return true;
    } else if (pattern.endsWith("*")) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
    } else {
      if (name === pattern) return true;
    }
  }
  return false;
}

export async function cmdCleanup(
  app: App,
  settings: VaultS3Settings,
  state: SyncState,
  dryRun = false
): Promise<{ moved: number; totalSize: number }> {
  const { attachmentFolders, ignoreFolders, ignoreFiles, trashFolder, s3 } = settings;

  // ── Collect ALL referenced file identifiers from vault notes ───────────
  // We collect: bare filename, full ref path, AND track which files are
  // already uploaded to S3 (present in syncState.processed)
  const referencedNames = new Set<string>();   // just filename
  const referencedPaths = new Set<string>();   // full vault-relative path

  const mdFiles = app.vault.getMarkdownFiles().filter(
    (f) => !isIgnored(f.path, ignoreFolders)
  );

  for (const md of mdFiles) {
    try {
      const text = await app.vault.read(md);
      for (const parsed of parseAllRefs(text)) {
        const ref = parsed.ref;
        // Skip already-S3 refs — those files are legitimately gone locally
        if (isAlreadyS3Ref(ref, s3.publicEndpoint, s3.endpoint, s3.bucket)) continue;
        if (isExternalRef(ref)) continue;

        // Collect both full path and bare filename
        const bare = ref.split("/").pop()?.split("?")[0] ?? ref;
        referencedNames.add(bare);
        referencedPaths.add(normalizePath(ref));
      }
    } catch { /* skip unreadable */ }
  }

  // Also protect files that are in syncState.processed —
  // they were uploaded to S3 and their local copy was already deleted by sync.
  // If somehow they still exist locally, they ARE orphans — so we don't protect them here.
  // But files NOT in state and NOT referenced → true orphans.

  // ── Find orphan files in attachment folders ────────────────────────────
  const orphans: TFile[] = [];

  for (const folderName of attachmentFolders) {
    const folder = app.vault.getAbstractFileByPath(normalizePath(folderName));
    if (!(folder instanceof TFolder)) continue;

    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      if (isIgnored(child.path, ignoreFolders)) continue;
      if (ignoreFiles && isIgnoredFile(child.name, ignoreFiles)) continue;

      const ext = "." + child.extension.toLowerCase();
      if (!ATTACHMENT_EXT.has(ext)) continue;

      // A file is an orphan ONLY if:
      // 1. Its name is NOT referenced in any note
      // 2. Its full path is NOT referenced in any note
      // 3. It is NOT already processed (uploaded) in syncState
      const isReferenced =
        referencedNames.has(child.name) ||
        referencedPaths.has(child.path);

      const isProcessed = !!state.processed[child.path];

      if (!isReferenced && !isProcessed) {
        orphans.push(child);
      }
    }
  }

  orphans.sort((a, b) => b.stat.size - a.stat.size);
  const totalSize = orphans.reduce((s, f) => s + f.stat.size, 0);

  // ── Dry run report ─────────────────────────────────────────────────────
  if (dryRun) {
    const lines = orphans.map(
      (f) => `  ${f.path}  (${(f.stat.size / 1024).toFixed(1)} KB)`
    );
    const summary = `DRY RUN: ${orphans.length} orphan files, ${(totalSize / 1024 / 1024).toFixed(2)} MB`;
    new Notice(summary, 10000);
    console.log("[S3 Cleanup] " + summary);
    console.log(lines.join("\n"));
    return { moved: 0, totalSize };
  }

  if (orphans.length === 0) {
    new Notice("✅ Cleanup: no orphan files found.", 5000);
    return { moved: 0, totalSize: 0 };
  }

  // ── Move orphans to trash folder ───────────────────────────────────────
  const trashAbstract = app.vault.getAbstractFileByPath(normalizePath(trashFolder));
  if (!trashAbstract) {
    await app.vault.createFolder(normalizePath(trashFolder));
  }

  let moved = 0;
  for (const file of orphans) {
    try {
      // Avoid collisions: if a file with same name exists in trash, add suffix
      let destName = file.name;
      let dest = normalizePath(`${trashFolder}/${destName}`);
      let counter = 1;
      while (app.vault.getAbstractFileByPath(dest)) {
        const nameParts = file.name.split(".");
        const nameNoExt = nameParts.slice(0, -1).join(".");
        const ext = nameParts.slice(-1)[0];
        destName = `${nameNoExt}_${counter}.${ext}`;
        dest = normalizePath(`${trashFolder}/${destName}`);
        counter++;
      }

      await app.vault.rename(file, dest);
      console.log(`[S3 Cleanup] → trash: ${file.path}`);
      moved++;
    } catch (err) {
      console.warn(`[S3 Cleanup] Could not move: ${file.name}`, err);
    }
  }

  const msg = `🗑️ Cleanup: ${moved} orphan files → ${trashFolder} (${(totalSize / 1024 / 1024).toFixed(2)} MB)`;
  new Notice(msg, 8000);
  console.log("[S3 Cleanup] " + msg);

  return { moved, totalSize };
}
