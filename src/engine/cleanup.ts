// src/engine/cleanup.ts

import { App, Notice, TFile, normalizePath } from "obsidian";
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
         kind === "md-embed" || kind === "md-link") &&
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

  // 2. Обходим attachment folders и ищем orphans
  const orphans: TFile[] = [];

  for (const folderName of settings.attachmentFolders) {
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

  if (dryRun) {
    for (const f of orphans) {
      log.info(`  DRY orphan: ${f.path} (${(f.stat.size / 1024).toFixed(1)} KB)`);
    }

    const preview = orphans.slice(0, 10).map((f) => f.path);
    const remaining = orphans.length - preview.length;
    const extra = remaining > 0 ? ` (+${remaining} more)` : "";
    new Notice(
      `Cleanup dry-run: ${orphans.length} orphan file(s)\n${preview.join("\n")}${extra}`,
      12000
    );

    return { orphans: orphans.length, moved: 0 };
  }

  // 3. Перемещаем orphans в trash папку
  // settings.trashFolder берётся напрямую из VaultS3Settings (не из settings.options)
  const trashFolder = settings.trashFolder;
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
  return { orphans: orphans.length, moved };
}
