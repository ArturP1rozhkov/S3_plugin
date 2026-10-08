// src/engine/cleanup.ts

import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import type { VaultS3Settings } from "../settings";
import type { SyncState } from "../state";
import {
  parseAllRefs,
  isExternalRef,
  isAlreadyS3Ref,
  refExt,
  refFilename,
} from "./linkParser";
import { ATTACHMENT_EXT } from "./fileClassifier";
import { ResultModal, type ResultData } from "./status";

function askConfirmation(app: App, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText("Confirm action");
    modal.contentEl.createEl("p", { text: message });
    const btnContainer = modal.contentEl.createDiv({ cls: "s3sync-confirm-buttons" });
    const ok = btnContainer.createEl("button", { text: "Move to trash", cls: "mod-cta" });
    const cancel = btnContainer.createEl("button", { text: "Cancel" });
    ok.addEventListener("click", () => { modal.close(); resolve(true); });
    cancel.addEventListener("click", () => { modal.close(); resolve(false); });
    modal.open();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isIgnored(path: string, ignoreFolders: string[]): boolean {
  return path.split("/").some((p) => ignoreFolders.includes(p));
}

function isIgnoredFile(name: string, ignoreFiles: string[]): boolean {
  for (const pattern of ignoreFiles) {
    if (pattern.startsWith("*") && name.endsWith(pattern.slice(1)))        return true;
    if (pattern.endsWith("*")   && name.startsWith(pattern.slice(0, -1))) return true;
    if (name === pattern)                                                    return true;
  }
  return false;
}

function iconForFile(name: string): string {
  const ext = refExt(name);
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff", ".ico"].includes(ext)) return "🖼️";
  if (ext === ".pdf") return "📄";
  if ([".mp3", ".m4a", ".ogg", ".wav", ".flac", ".3gp"].includes(ext)) return "🎵";
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".ogv"].includes(ext)) return "🎬";
  return "📎";
}

// ── Сбор referenced-файлов из vault ──────────────────────────────────────────
//
// Правило: ссылка защищает файл от orphan-детекта если и только если:
//   • ref имеет attachment-расширение (после стрипинга #anchor и ?query)
//   • ИЛИ ref — already-S3 URL (не локальный файл — не попадает в orphan)
//
// Источники ссылок:
//   1. metadataCache.embeds / links  — wiki-ссылки (![[file]], [[file]])
//   2. parseAllRefs по тексту        — HTML-теги, markdown embeds и links
//      (Obsidian не кеширует HTML src= атрибуты)
//
// Защита от удаления шире, чем sync upload pipeline: обычная ссылка на
// локальный attachment всё ещё считается валидной ссылкой, поэтому md-link
// и wiki-link остаются в referenced set.

async function collectReferencedFilenames(
  app: App,
  settings: VaultS3Settings
): Promise<Set<string>> {
  const referenced = new Set<string>();

  const mdFiles = app.vault.getMarkdownFiles().filter(
    (f) => !isIgnored(f.path, settings.ignoreFolders)
  );

  for (const md of mdFiles) {
    // 1. Из metadataCache — wiki embeds и links (быстро, без чтения файла)
    const cache = app.metadataCache.getFileCache(md);

    for (const embed of cache?.embeds ?? []) {
      const e = refExt(embed.link);
      if (ATTACHMENT_EXT.has(e)) referenced.add(refFilename(embed.link));
    }

    for (const link of cache?.links ?? []) {
      const e = refExt(link.link);
      if (ATTACHMENT_EXT.has(e)) referenced.add(refFilename(link.link));
    }

    // 2. Из текста — HTML-теги и markdown-ссылки
    //    (metadataCache не покрывает <img src=...>, <video>, <audio>)
    const content = await app.vault.cachedRead(md);
    const allRefs = parseAllRefs(content);

    for (const { ref, kind } of allRefs) {
      if (
        (kind === "html-img" || kind === "html-video" || kind === "html-audio" ||
         kind === "html-source" ||
         kind === "md-embed" || kind === "md-link" ||
         kind === "wiki-embed" || kind === "wiki-link") &&
        !isExternalRef(ref) &&
        !isAlreadyS3Ref(ref, settings.s3.publicEndpoint, settings.s3.endpoint, settings.s3.bucket)
      ) {
        const e = refExt(ref);
        if (ATTACHMENT_EXT.has(e)) referenced.add(refFilename(ref));
      }
    }
  }

  return referenced;
}

// ── cmdCleanup ────────────────────────────────────────────────────────────────

export async function cmdCleanup(
  app: App,
  settings: VaultS3Settings,
  state: SyncState,           // передаётся из main.ts, зарезервирован для будущего
  dryRun = false,
  logger?: { info: (m: string) => void; warn: (m: string) => void }
): Promise<{ orphans: number; moved: number }> {
  const log = logger ?? {
    info: (m: string) => console.log(`[Cleanup] ${m}`),
    warn: (m: string) => console.warn(`[Cleanup] ${m}`),
  };

  log.info(dryRun ? "CLEANUP local — DRY RUN" : "CLEANUP local — started");

  // 1. Собираем все referenced filenames
  const referenced = await collectReferencedFilenames(app, settings);
  log.info(`Referenced attachment filenames: ${referenced.size}`);

  // 2. Обходим attachment folders + pdfDummyFolder и ищем orphans.
  // pdfDummyFolder сканируем явно, даже если он не указан в attachmentFolders,
  // чтобы dummy PDF, на которые есть ссылки, не считались orphan.
  const orphans: TFile[] = [];
  const foldersToScan = new Set([...settings.attachmentFolders, settings.pdfDummyFolder]);

  for (const folderName of foldersToScan) {
    const folder = app.vault.getAbstractFileByPath(normalizePath(folderName));
    if (!folder) continue;

    for (const file of app.vault.getFiles()) {
      if (!file.path.startsWith(folderName + "/")) continue;
      if (!ATTACHMENT_EXT.has(refExt(file.name))) continue;
      if (isIgnoredFile(file.name, settings.ignoreFiles ?? [])) continue;
      if (!referenced.has(file.name)) {
        orphans.push(file);
      }
    }
  }

  log.info(`Found ${orphans.length} local orphan(s)`);

  const orphanItems = orphans.map((f) => ({
    label: f.path,
    value: `(${(f.stat.size / 1024).toFixed(1)} KB)`,
    icon: iconForFile(f.name),
  }));

  if (dryRun) {
    const data: ResultData = {
      title: "Cleanup — Dry Run",
      icon: "🔍",
      subtitle: `${orphans.length} orphan file(s) found`,
      sections: [
        {
          title: "",
          rows: {
            "🗑️ Orphan files found": String(orphans.length),
            "📦 Total size": `${(orphans.reduce((s, f) => s + f.stat.size, 0) / 1024 / 1024).toFixed(2)} MB`,
          },
        },
      ],
      lists: orphanItems.length > 0
        ? [{
            title: "Orphan files",
            icon: "🔍",
            items: orphanItems,
            initiallyExpanded: orphanItems.length <= 15,
            maxInitialItems: 15,
          }]
        : undefined,
    };

    new ResultModal(app, data).open();
    return { orphans: orphans.length, moved: 0 };
  }

  // 3. Подтверждение перед реальным перемещением
  const confirmed = await askConfirmation(
    app,
    `Move ${orphans.length} orphan file(s) to trash folder "${settings.trashFolder}"?`
  );
  if (!confirmed) {
    log.info("CLEANUP local cancelled by user");
    return { orphans: orphans.length, moved: 0 };
  }

  // 4. Перемещаем orphans в trash папку
  // settings.trashFolder берётся напрямую из VaultS3Settings (не из settings.options)
  const trashFolder = settings.trashFolder;

  // Убедимся, что целевая папка существует (Obsidian .trash по умолчанию может отсутствовать,
  // особенно если ни один файл ещё не удалялся через системный UI).
  try {
    await app.vault.adapter.mkdir(trashFolder);
  } catch (err) {
    // Ignore if folder already exists.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }

  let moved = 0;

  for (const f of orphans) {
    try {
      const dest = normalizePath(`${trashFolder}/${f.name}`);
      await app.vault.rename(f, dest);
      log.info(`  Orphan → trash: ${f.name}`);
      moved++;
    } catch (err) {
      log.warn(`  Could not move ${f.name}: ${err}`);
    }
  }

  log.info(`CLEANUP local complete: ${moved} moved to trash`);

  const data: ResultData = {
    title: "Cleanup — Completed",
    icon: "🗑️",
    subtitle: `${moved} of ${orphans.length} orphan file(s) moved to trash`,
    sections: [
      {
        title: "",
        rows: {
          "🗑️ Orphan files found": String(orphans.length),
          "📦 Total size": `${(orphans.reduce((s, f) => s + f.stat.size, 0) / 1024 / 1024).toFixed(2)} MB`,
          "✅ Moved to trash": String(moved),
        },
      },
    ],
    lists: orphanItems.length > 0
      ? [{
          title: "Moved files",
          icon: "🗑️",
          items: orphanItems,
          initiallyExpanded: orphanItems.length <= 15,
          maxInitialItems: 15,
        }]
      : undefined,
  };

  new ResultModal(app, data).open();
  return { orphans: orphans.length, moved };
}
