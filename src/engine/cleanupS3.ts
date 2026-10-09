// src/engine/cleanupS3.ts

import { App, Modal, Notice, TFile, TFolder } from "obsidian";
import type { VaultS3Settings } from "../settings";
import { createS3Client, listAllObjects, moveObject, deleteObject } from "../s3Client";
import { extractPdfUrl } from "./pdfDummy";
import { ResultModal, type ResultData, type ResultList } from "./status";

function isIgnored(path: string, ignoreFolders: string[]): boolean {
  return path.split("/").some((p) => ignoreFolders.includes(p));
}

/**
 * Строит Set S3-ключей, на которые ссылается vault.
 *
 * Два источника:
 *   1. Все .md файлы — ищем https-URL с префиксом нашего S3
 *   2. Dummy PDF файлы — их содержимое и есть S3 URL
 *
 * Prefix вычисляется строго из publicUrlStyle:
 *   - path:         publicEndpoint/bucket
 *   - virtual-host: publicEndpoint
 * При virtual-host старые URL вида publicEndpoint/key продолжают совпадать,
 * поскольку prefix не включает bucket.
 */
async function collectS3Keys(app: App, settings: VaultS3Settings): Promise<Set<string>> {
  const { ignoreFolders, s3, pdfDummyFolder } = settings;

  // Строим prefix для матчинга URL → ключ в зависимости от publicUrlStyle
  const normalizedPublicEndpoint = s3.publicEndpoint?.replace(/\/+$/, "") ?? "";

  let prefix = "";
  if (normalizedPublicEndpoint && s3.bucket) {
    if (s3.publicUrlStyle === "virtual-host") {
      prefix = normalizedPublicEndpoint;
    } else {
      prefix = `${normalizedPublicEndpoint}/${s3.bucket}`;
    }
  }

  if (!prefix) {
    console.warn("[S3 CleanupS3] publicEndpoint and bucket must be configured — cannot collect S3 keys");
    return new Set();
  }

  const s3Keys = new Set<string>();

  // ── Scan all markdown files for S3 URLs ─────────────────────────────────
  const mdFiles = app.vault.getMarkdownFiles().filter(
    (f) => !isIgnored(f.path, ignoreFolders)
  );

  for (const md of mdFiles) {
    try {
      const text = await app.vault.read(md);
      const urlMatches = text.match(/https?:\/\/[^\s)"'>]+/g) ?? [];
      for (const url of urlMatches) {
        // Зачищаем хвостовую пунктуацию которую может прицепить regex
        const clean = url.replace(/[.,)'">\\]]+$/, "");
        if (clean.startsWith(prefix)) {
          const key = clean.slice(prefix.length).replace(/^\//, "");
          if (key) s3Keys.add(key);
        }
      }
    } catch { /* пропустить нечитаемый файл */ }
  }

  // ── Scan dummy PDF folder ────────────────────────────────────────────────
  const dummyFolder = app.vault.getAbstractFileByPath(pdfDummyFolder);
  if (dummyFolder instanceof TFolder) {
    for (const child of dummyFolder.children) {
      if (child instanceof TFile && child.extension.toLowerCase() === "pdf") {
        try {
          const content = await app.vault.read(child);
          const url = extractPdfUrl(content);
          if (url && url.startsWith(prefix)) {
            const key = url.slice(prefix.length).replace(/^\//, "");
            if (key) s3Keys.add(key);
          }
        } catch { /* пропустить */ }
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
  const quarantinePrefix  = s3.quarantineFolder.replace(/\/$/, "") + "/";
  const retentionDays     = s3.quarantineRetentionDays ?? 14;

  if (!s3.bucket || !s3.accessKey || !s3.secretKey) {
    showCleanupS3Result(app, true, { error: "S3 credentials not configured" });
    return { moved: 0 };
  }

  // Guard: без publicEndpoint и bucket нельзя определить какие ключи "наши"
  const hasPrefix = !!(s3.publicEndpoint && s3.bucket);
  if (!hasPrefix) {
    showCleanupS3Result(app, true, { error: "Configure publicEndpoint and bucket first" });
    console.warn("[S3 CleanupS3] Cannot run: no URL prefix configured");
    return { moved: 0 };
  }

  const client = createS3Client(s3);
  new Notice("S3 Cleanup: listing bucket objects…");

  // ── Collect referenced keys from vault ────────────────────────────────────
  const referencedKeys = await collectS3Keys(app, settings);
  console.log(`[S3 CleanupS3] Referenced keys in vault: ${referencedKeys.size}`);

  // ── List all S3 objects ───────────────────────────────────────────────────
  let allObjects: Awaited<ReturnType<typeof listAllObjects>> = [];
  try {
    allObjects = await listAllObjects(client, s3.bucket);
  } catch (err) {
    showCleanupS3Result(app, true, { error: "Cannot list S3 objects. Check credentials." });
    console.error("[S3 CleanupS3] List failed", err);
    return { moved: 0 };
  }

  // ── Find orphans (exclude quarantine prefix) ──────────────────────────────
  const orphans = allObjects.filter(
    (obj) => !obj.key.startsWith(quarantinePrefix) && !referencedKeys.has(obj.key)
  );
  const totalSize = orphans.reduce((s, o) => s + o.size, 0);

  console.log(
    `[S3 CleanupS3] Total: ${allObjects.length}, orphans: ${orphans.length}, ` +
    `${(totalSize / 1024 / 1024).toFixed(2)} MB`
  );

  // Сирот нет — подтверждение не нужно, просто сообщаем результат.
  // Раньше в этом случае всё равно спрашивали «Move 0 object(s)?».
  if (orphans.length === 0) {
    const data: ResultData = {
      title: "Cleanup S3 — Nothing to Do",
      icon: "✅",
      subtitle: "No orphan objects found in the bucket",
      sections: [
        {
          title: "",
          rows: {
            "☁️ Objects in bucket": String(allObjects.length),
            "🔗 Referenced by notes": String(referencedKeys.size),
          },
        },
      ],
    };
    new ResultModal(app, data).open();
    return { moved: 0 };
  }

  if (dryRun) {
    showCleanupS3Result(app, true, { orphans, totalSize });
    return { moved: 0 };
  }

  // ── Сначала показываем найденное, потом спрашиваем подтверждение ──────────
  showCleanupS3Result(app, true, { orphans, totalSize }, "Cleanup S3 — Found Orphans");

  // ── Confirm before real move ──────────────────────────────────────────────
  const confirmed = await askConfirmation(
    app,
    `Move ${orphans.length} orphan S3 object(s) to quarantine prefix "${s3.quarantineFolder}/"?`
  );
  if (!confirmed) {
    console.log("[S3 CleanupS3] Cancelled by user");
    return { moved: 0 };
  }

  // ── Delete expired quarantine objects ─────────────────────────────────────
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let deleted = 0;
  for (const obj of allObjects) {
    if (obj.key.startsWith(quarantinePrefix) && obj.lastModified < cutoff) {
      try {
        await deleteObject(client, s3.bucket, obj.key);
        deleted++;
      } catch { /* пропустить */ }
    }
  }

  // ── Move orphans to quarantine ────────────────────────────────────────────
  let moved = 0;
  for (const obj of orphans) {
    // Сохраняем оригинальный путь в имени: "media/abc.jpg" → "quarantine/media_abc.jpg"
    const quarantineKey = quarantinePrefix + obj.key.replace(/\//g, "_");
    try {
      await moveObject(client, s3.bucket, obj.key, quarantineKey);
      console.log(`[S3 CleanupS3] → quarantine: ${obj.key}`);
      moved++;
    } catch (err) {
      console.warn(`[S3 CleanupS3] Could not move: ${obj.key}`, err);
    }
  }

  console.log(`[S3 CleanupS3] 🪣 S3 Cleanup: ${moved} objects → quarantine, ${deleted} expired deleted`);

  showCleanupS3Result(app, false, { orphans, moved, deleted, totalSize });
  return { moved };
}

interface CleanupS3ResultInput {
  orphans?: Array<{ key: string; size: number }>;
  moved?: number;
  deleted?: number;
  totalSize?: number;
  error?: string;
}

function askConfirmation(app: App, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText("Confirm action");
    modal.contentEl.createEl("p", { text: message });
    const btnContainer = modal.contentEl.createDiv({ cls: "s3sync-confirm-buttons" });
    const ok = btnContainer.createEl("button", { text: "Move to quarantine", cls: "mod-cta" });
    const cancel = btnContainer.createEl("button", { text: "Cancel" });
    ok.addEventListener("click", () => { modal.close(); resolve(true); });
    cancel.addEventListener("click", () => { modal.close(); resolve(false); });
    modal.open();
  });
}

function groupByPrefix(keys: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const key of keys) {
    const prefix = key.includes("/") ? key.split("/")[0] : "root";
    (groups[prefix] ??= []).push(key);
  }
  return groups;
}

function showCleanupS3Result(
  app: App,
  dryRun: boolean,
  input: CleanupS3ResultInput,
  titleOverride?: string
): void {
  const { orphans = [], moved = 0, deleted = 0, totalSize = 0, error } = input;

  if (error) {
    const data: ResultData = {
      title: "Cleanup S3",
      icon: "❌",
      subtitle: "Failed",
      sections: [{ title: "", rows: { "⚠️ Error": error }, error: true }],
    };
    new ResultModal(app, data).open();
    return;
  }

  const sections: ResultData["sections"] = [
    {
      title: "",
      rows: {
        "☁️ Orphan objects found": String(orphans.length),
        "📦 Total size": `${(totalSize / 1024 / 1024).toFixed(2)} MB`,
      },
    },
  ];

  if (!dryRun) {
    sections[0].rows["🗑️ Moved to quarantine"] = String(moved);
    sections[0].rows["🧹 Expired quarantine deleted"] = String(deleted);
  }

  const grouped = groupByPrefix(orphans.map((o) => o.key));
  const lists: ResultList[] = [];
  for (const [prefix, keys] of Object.entries(grouped).sort()) {
  const prefixSize = orphans
    .filter((o) => (o.key.includes("/") ? o.key.split("/")[0] : "root") === prefix)
    .reduce((s, o) => s + o.size, 0);
  if (prefixSize) { /* Silence unused-variable in dev builds; shown if UI adds per-prefix size */ }
    lists.push({
      title: `${prefix}/`,
      icon: "☁️",
      items: keys.slice(0, 15).map((k) => {
        const obj = orphans.find((o) => o.key === k);
        const kb = obj ? obj.size / 1024 : 0;
        return { label: k, value: `(${kb.toFixed(1)} KB)` };
      }),
      initiallyExpanded: keys.length <= 15,
      maxInitialItems: 15,
    });
  }

  const data: ResultData = {
    title: titleOverride ?? (dryRun ? "Cleanup S3 - Dry Run" : "Cleanup S3 - Completed"),
    icon: dryRun ? "🔍" : "☁️🗑️",
    subtitle: dryRun
      ? `${orphans.length} orphan object(s) found`
      : `${moved} object(s) moved to quarantine`,
    sections,
    lists: lists.length > 0 ? lists : undefined,
  };

  new ResultModal(app, data).open();
}
