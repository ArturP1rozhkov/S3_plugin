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
    let content = "";
    try {
      content = await app.vault.cachedRead(md);
    } catch (err) {
      console.warn(`[Cleanup] skip unreadable note ${md.path}: ${err}`);
      continue;
    }
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

// ── Перемещение в trash ───────────────────────────────────────────────────────

/** Существует ли путь: спрашиваем диск, а если adapter.exists недоступен — индекс vault. */
async function pathExists(app: App, path: string): Promise<boolean> {
  try {
    if (typeof app.vault.adapter.exists === "function") {
      return await app.vault.adapter.exists(path);
    }
  } catch { /* ignore — падаем в индекс */ }
  return app.vault.getAbstractFileByPath(path) !== null;
}

/**
 * Гарантирует, что папка назначения есть. Никогда не бросает исключение:
 * Obsidian кидает "Folder already exists." БЕЗ code === EEXIST, и раньше это
 * исключение пролетало наружу — команда cleanup падала целиком, до цикла
 * перемещения, поэтому файлы оставались на месте, а модалка не появлялась.
 */
async function ensureFolderExists(app: App, folder: string): Promise<void> {
  try {
    if (await pathExists(app, folder)) return;
  } catch { /* ignore */ }
  try {
    await app.vault.adapter.mkdir(folder);
  } catch (err) {
    console.warn(`[Cleanup] mkdir "${folder}" failed, continuing: ${err}`);
  }
}

/** Путь в trash с уникальным именем — то, что уже лежит в trash, не перезаписываем. */
async function uniqueTrashPath(app: App, trashFolder: string, name: string): Promise<string> {
  const dot  = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext  = dot > 0 ? name.slice(dot) : "";

  let candidate = normalizePath(`${trashFolder}/${name}`);
  let counter = 2;
  while (await pathExists(app, candidate)) {
    candidate = normalizePath(`${trashFolder}/${base} ${counter}${ext}`);
    counter++;
  }
  return candidate;
}

/**
 * Убирает файл из vault в trash-папку, проверяя результат.
 *   1) vault.rename     — штатный путь Obsidian (обновляет ссылки);
 *   2) adapter.rename   — работает и для папок вне индекса (например .trash);
 *   3) read+write+delete — последний резерв.
 * Возвращает ok:false с причиной, если файл реально остался на месте.
 */
async function moveToTrash(
  app: App,
  file: TFile,
  trashFolder: string
): Promise<{ ok: boolean; reason?: string }> {
  const dest = await uniqueTrashPath(app, trashFolder, file.name);
  const errors: string[] = [];

  const gone = async (): Promise<boolean> => !(await pathExists(app, file.path));

  try {
    await app.vault.rename(file, dest);
    if (await gone()) return { ok: true };
    errors.push("vault.rename: файл остался на месте");
  } catch (err) {
    errors.push(`vault.rename: ${err}`);
  }

  try {
    await app.vault.adapter.rename(file.path, dest);
    if (await gone()) return { ok: true };
    errors.push("adapter.rename: файл остался на месте");
  } catch (err) {
    errors.push(`adapter.rename: ${err}`);
  }

  try {
    const data = await app.vault.adapter.readBinary(file.path);
    await app.vault.adapter.writeBinary(dest, data);
    await app.vault.delete(file);
    if (await gone()) return { ok: true };
    errors.push("copy+delete: файл остался на месте");
  } catch (err) {
    errors.push(`copy+delete: ${err}`);
  }

  return { ok: false, reason: errors.join("; ") };
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

  // Сирот нет — подтверждение не нужно, просто сообщаем результат.
  // Раньше в этом случае всё равно спрашивали «Move 0 file(s)?».
  if (orphans.length === 0) {
    const data: ResultData = {
      title: "Cleanup — Nothing to Do",
      icon: "✅",
      subtitle: "No local orphan files found",
      sections: [
        {
          title: "",
          rows: {
            "🔍 Folders scanned": [...foldersToScan].join(", "),
            "📎 Attachments referenced by notes": String(referenced.size),
          },
        },
      ],
    };
    new ResultModal(app, data).open();
    return { orphans: 0, moved: 0 };
  }

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

  // 3. Одна модалка на весь сценарий: статистика + список + кнопки.
  //    «Move … to trash» выполняет перемещение и показывает итог в этой же
  //    модалке; отдельного диалога подтверждения и второй плашки больше нет.
  const trashFolder = settings.trashFolder;
  const sizeText = `${(orphans.reduce((s, f) => s + f.stat.size, 0) / 1024 / 1024).toFixed(2)} MB`;
  let moved = 0;
  const failed: { path: string; reason: string }[] = [];

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const modal = new ResultModal(
      app,
      {
        title: "Cleanup — Found Orphans",
        icon: "🔍",
        subtitle: `${orphans.length} orphan file(s) found`,
        sections: [
          {
            title: "",
            rows: {
              "🗑️ Orphan files found": String(orphans.length),
              "📦 Total size": sizeText,
            },
          },
        ],
        lists: [
          {
            title: "Orphan files",
            icon: "🔍",
            items: orphanItems,
            initiallyExpanded: true,
            maxInitialItems: 15,
          },
        ],
      },
      [
        {
          label: `Move ${orphans.length} file(s) to trash`,
          cta: true,
          run: async (m) => {
            try {
              // Папка назначения: если она уже есть, mkdir может бросить исключение,
              // поэтому ensureFolderExists глотает ошибку и cleanup продолжается.
              await ensureFolderExists(app, trashFolder);

              for (const f of orphans) {
                const res = await moveToTrash(app, f, trashFolder);
                if (res.ok) {
                  log.info(`  Orphan → trash: ${f.name}`);
                  moved++;
                } else {
                  const reason = res.reason ?? "unknown error";
                  log.warn(`  Could not move ${f.name}: ${reason}`);
                  failed.push({ path: f.path, reason });
                }
              }

              log.info(`CLEANUP local complete: ${moved} moved to trash, ${failed.length} failed`);
              // Одной плашки достаточно: закрываем её и показываем короткий итог.
              m.close();
              new Notice(
                failed.length > 0
                  ? `Cleanup: moved ${moved} of ${orphans.length} file(s) to trash, ${failed.length} failed (see console)`
                  : `Cleanup: moved ${moved} of ${orphans.length} file(s) to trash`
              );
            } finally {
              finish();
            }
          },
        },
        {
          label: "Close",
          run: async (m) => { m.close(); },
        },
      ],
      finish
    );

    modal.open();
  });

  return { orphans: orphans.length, moved };
}
