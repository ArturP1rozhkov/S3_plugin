import { App, Notice, TFile, normalizePath } from "obsidian";
import {
  effectiveRestoreFolder,
  isRestoreFolderIsolated,
  normalizeFolderPath,
  type VaultS3Settings,
} from "../settings";
import type { SyncState } from "../state";
import { createS3Client, publicUrl, uploadBuffer, headObject } from "../s3Client";
import { resolveRefFile } from "./resolveFile";
import {
  parseAllAttachmentRefs,
  parseAllRefs,
  canonicalMediaTag,
  isExternalRef,
  isAlreadyS3Ref,
  makeReplacement,
  parseWikilinkSize,
  splitRef,
  refExt,
  refFilename,
} from "./linkParser";
import { ResultModal, type ResultData } from "./status";
import {
  ATTACHMENT_EXT,
  canonicalExt,
  fileType,
  s3Key,
  DEFAULT_FOLDER_MAP,
} from "./fileClassifier";
import { md5Buffer } from "./md5";
import { ensurePdfDummy, isDummyPdf } from "./pdfDummy";
import {
  markProcessed,
  queueDeletion,
  type PendingDeletion,
} from "../state";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ext(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i).toLowerCase() : "";
}

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

/**
 * Ищет локальный файл для ссылки: точный путь → папки вложений → по имени.
 *
 * Важно: если папка для скачивания объектов (Restore) не пересекается с
 * папками плагина, её файлы здесь не рассматриваются вообще. Иначе скачанная
 * копия могла бы «перехватить» ссылку у dummy-PDF (имена совпадают) и была бы
 * удалена как обработанное локальное вложение.
 */
function resolveLocalRef(
  app: App,
  ref: string,
  settings: VaultS3Settings
): TFile | null {
  const restorePrefix = isolatedRestorePrefix(settings);
  return resolveRefFile(app, ref, {
    attachmentFolders: settings.attachmentFolders ?? [],
    pdfDummyFolder: settings.pdfDummyFolder,
    isExcluded: restorePrefix ? (path) => isInsideFolder(path, restorePrefix) : undefined,
  });
}

/** Префикс изолированной папки Restore или "" если изоляции нет. */
function isolatedRestorePrefix(settings: VaultS3Settings): string {
  if (!isRestoreFolderIsolated(settings)) return "";
  const folder = normalizeFolderPath(effectiveRestoreFolder(settings));
  return folder ? `${folder}/` : "";
}

/** Лежит ли путь внутри папки с префиксом `folder/`. */
function isInsideFolder(path: string, folderPrefix: string): boolean {
  const normalized = normalizeFolderPath(path);
  return normalized === folderPrefix.replace(/\/$/, "") || normalized.startsWith(folderPrefix);
}

export type UploadResult =
  | { status: "ok"; url: string }
  | { status: "empty" }
  | { status: "error"; reason: string };

/**
 * Повторяет сетевую операцию при временном сбое (S3 иногда отдаёт
 * «Failed to fetch» — обрыв на транспорте; Chromium при этом ещё и пишет
 * «blocked by CORS policy», хотя CORS ни при чём). Тело запроса уже в памяти,
 * поэтому повтор дешёвый. Задержка растёт: 400 мс, 1000 мс, 2000 мс…
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt + 200));
      }
    }
  }
  throw lastErr;
}

async function uploadFile(
  app: App,
  settings: VaultS3Settings,
  client: ReturnType<typeof createS3Client>,
  file: TFile,
  noteRelPath: string
): Promise<UploadResult> {
  try {
    const buf = await app.vault.readBinary(file);
    if (buf.byteLength === 0) {
      console.warn(`[S3 Sync] Skipping empty file: ${file.name}`);
      return { status: "empty" };
    }

    const e = ext(file.name);
    const hash = md5Buffer(buf);
    // Ключ от содержимого строим по КАНОНИЧЕСКОМУ расширению: иначе
    // a.jpg и b.jpeg с одинаковыми байтами дают два объекта в бакете.
    const keyExt = canonicalExt(e);
    const filename = settings.s3.hashFilenames ? `${hash}${keyExt}` : file.name;
    const folderMap = settings.s3.folderMap ?? DEFAULT_FOLDER_MAP;
    const key = s3Key(folderMap, filename, keyExt);

    // Проверяем, нет ли уже в S3 идентичного объекта (по ключу/ETag/размеру).
    //
    // HEAD — это только оптимизация: если он не прошёл из-за обрыва сети (а
    // Chromium в таком случае показывает ещё и «blocked by CORS policy», хотя
    // дело не в CORS), загрузку всё равно пробуем. Иначе один сетевой сбой
    // делает файл «незагружаемым» навсегда и обрывает создание dummy для PDF.
    let existing: Awaited<ReturnType<typeof headObject>> = null;
    try {
      existing = await withRetry(() => headObject(client, settings.s3, key), 3);
    } catch (err) {
      console.warn(`[S3 Sync] HEAD failed for ${key}, uploading anyway: ${err}`);
    }
    if (
      existing &&
      existing.ContentLength === buf.byteLength &&
      (existing.ETag ?? "").replace(/^"|"$/g, "") === hash
    ) {
      return { status: "ok", url: publicUrl(settings.s3, key) };
    }

    const contentTypeMap: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
      ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
      ".wav": "audio/wav", ".pdf": "application/pdf",
    };
    const contentType = contentTypeMap[e] ?? "application/octet-stream";

    const metadata: Record<string, string> = {
      "source-vault":  app.vault.getName(),
      "uploaded-by":   "vault-s3-sync",
      "original-name": encodeURIComponent(file.name),
      "file-type":     fileType(e),
      "uploaded-at":   new Date().toISOString(),
      "source-note":   encodeURIComponent(noteRelPath),
    };

    await withRetry(() =>
      uploadBuffer(client, settings.s3, key, new Uint8Array(buf), contentType, metadata)
    );
    return { status: "ok", url: publicUrl(settings.s3, key) };
  } catch (err) {
    console.error(`[S3 Sync] Upload failed: ${file.name}`, err);
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Скачивание внешних ссылок.
 * Сейчас НЕ вызывается: по политике проекта внешние интернет-ссылки только
 * рендерятся и никогда не скачиваются и не попадают в бакет. Функция оставлена
 * как заготовка для отдельного инструмента импорта внешних ссылок.
 */
async function downloadExternal(
  url: string,
  timeoutMs: number
): Promise<{ buf: ArrayBuffer; ext: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const ct = resp.headers.get("content-type") ?? "";
    const extMap: Record<string, string> = {
      "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
      "image/webp": ".webp", "image/svg+xml": ".svg",
    };
    const fileExt = extMap[ct.split(";")[0].trim()] ?? ".jpg";
    return { buf: await resp.arrayBuffer(), ext: fileExt };
  } catch {
    return null;
  }
}

// ── Logger ────────────────────────────────────────────────────────────────────

export interface SyncLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function consoleLogger(): SyncLogger {
  return {
    info:  (m) => console.log(`[S3 Sync] ${m}`),
    warn:  (m) => console.warn(`[S3 Sync] ${m}`),
    error: (m) => console.error(`[S3 Sync] ${m}`),
  };
}

// ── Process a single .md file ─────────────────────────────────────────────────

/**
 * Удаляет локальный исходник и ПРОВЕРЯЕТ, что он действительно исчез.
 * Obsidian может не отдать файл с первого раза (медиа ещё держит handle,
 * редактор успевает пересоздать файл), поэтому пробуем adapter.remove и
 * повторяем попытку. Возвращает false, если файл остался на диске.
 */
async function removeLocalFile(app: App, file: TFile, logger: SyncLogger): Promise<boolean> {
  const gone = async (): Promise<boolean> => {
    try {
      if (typeof app.vault.adapter.exists === "function") {
        return !(await app.vault.adapter.exists(file.path));
      }
    } catch { /* ignore — падаем в индекс */ }
    return app.vault.getAbstractFileByPath(file.path) === null;
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await app.vault.delete(file);
    } catch (err) {
      logger.warn(`vault.delete failed for ${file.name} (attempt ${attempt}): ${err}`);
    }
    if (await gone()) return true;

    if (typeof app.vault.adapter?.remove === "function") {
      try {
        await app.vault.adapter.remove(file.path);
      } catch (err) {
        logger.warn(`adapter.remove failed for ${file.name} (attempt ${attempt}): ${err}`);
      }
      if (await gone()) return true;
    }

    // Даём Obsidian отпустить файл перед повторной попыткой.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/**
 * Добивает удаления, которые не прошли в прошлые прогоны (файл был занят
 * Obsidian'ом). Файл удаляем только если он не изменился — иначе это уже
 * другой файл пользователя.
 */
async function flushPendingDeletions(
  app: App,
  state: SyncState,
  logger: SyncLogger,
  settings: VaultS3Settings
): Promise<{ done: number; pending: number }> {
  const queue = state.pendingDeletions ?? [];
  if (queue.length === 0) return { done: 0, pending: 0 };

  const still: PendingDeletion[] = [];
  const restorePrefix = isolatedRestorePrefix(settings);
  let done = 0;

  for (const entry of queue) {
    // Файл оказался в изолированной папке Restore — плагин её не трогает.
    if (restorePrefix && isInsideFolder(entry.path, restorePrefix)) {
      done++;                       // запись из очереди убираем, файл не удаляем
      continue;
    }
    const file = app.vault.getAbstractFileByPath(entry.path);
    if (!(file instanceof TFile)) {
      done++;                       // файла уже нет — запись не нужна
      continue;
    }
    if (file.stat.size !== entry.size || file.stat.mtime !== entry.mtime) {
      continue;                     // файл пересоздан/изменён — не трогаем
    }
    if (await removeLocalFile(app, file, logger)) {
      logger.info(`Removed deferred local file: ${file.name}`);
      done++;
    } else {
      still.push(entry);
    }
  }

  state.pendingDeletions = still;
  return { done, pending: still.length };
}

export async function processMdFile(
  app: App,
  settings: VaultS3Settings,
  client: ReturnType<typeof createS3Client>,
  state: SyncState,
  mdFile: TFile,
  logger: SyncLogger,
  onEmpty?: (fileName: string, notePath: string) => void,
  onLeftover?: (file: TFile, notePath: string) => void
): Promise<number> {
  let content = await app.vault.read(mdFile);
  const noteRelPath = mdFile.path;
  let changes = 0;

  // Локальные вложения удаляем ТОЛЬКО после того, как заметка записана.
  // Иначе любая ошибка/исключение после удаления оставляли заметку со
  // ссылками на уже исчезнувшие файлы.
  const deletions: TFile[] = [];

  // ── Нормализация формы ссылок, уже указывающих на наш S3 ────────────────────
  // Такие ссылки парсер отдаёт как внешние (и правильно: повторно загружать
  // нечего), но если форма испорчена — например видео вставлено картинкой
  // `![name](…mp4)` — Obsidian рисует битую картинку с исходным именем в alt.
  // Починить это может только sync, поэтому правим форму до основного прохода.
  for (const parsed of parseAllRefs(content)) {
    const { fullMatch, ref, kind } = parsed;
    if (!isAlreadyS3Ref(ref, settings.s3.publicEndpoint, settings.s3.endpoint, settings.s3.bucket)) continue;

    const fixed = canonicalMediaTag(kind, ref);
    if (!fixed || fixed === fullMatch) continue;

    content = content.replace(fullMatch, () => fixed);
    changes++;
    logger.info(`Normalized S3 media form (${kind}) in ${noteRelPath}`);
  }

  for (const parsed of parseAllAttachmentRefs(content, ATTACHMENT_EXT)) {
    const { fullMatch, ref, altText, kind } = parsed;

    const fileExt = refExt(ref);

    if (isAlreadyS3Ref(ref, settings.s3.publicEndpoint, settings.s3.endpoint, settings.s3.bucket)) continue;

    // ── Внешние интернет-ссылки ───────────────────────────────────────────────
    // Политика: внешние ссылки только рендерятся. Они не скачиваются, не
    // загружаются в бакет и не переписываются. Основной отсев — в linkParser
    // (isAttachmentCandidate), здесь защита от регрессий на уровне пайплайна.
    if (isExternalRef(ref)) continue;

    let url: string | null = null;
    let localFile: TFile | null = null;
    let uploadedExt  = fileExt;
    let uploadedName = refFilename(ref);
    let fileHash: string | null = null;

    // ── Local file ───────────────────────────────────────────────────────────
    {
      localFile = resolveLocalRef(app, ref, settings);
      if (!localFile) {
        // Ссылка в заметке есть, но файла нет ни по указанному пути, ни в
        // attachment-папках, ни в индексе vault. Раньше это пропускалось молча:
        // sync сообщал «0 replacements, 0 errors», хотя ссылка битая.
        logger.warn(`Attachment not found in vault: "${ref}" in ${noteRelPath}`);
        continue;
      }

      if (uploadedExt === ".pdf") {
        if (isDummyPdf(await app.vault.read(localFile), localFile.stat.size)) {
          logger.info(`Skipping dummy PDF: ${localFile.name}`);
          continue;
        }
      }

      const fileBuf  = await app.vault.readBinary(localFile);
      fileHash = md5Buffer(fileBuf);

      // ВАЖНО: здесь НЕЛЬЗЯ выходить по записи в state.
      // State (path+hash) означает только «файл уже загружали», но не «ссылка в
      // заметке уже переписана». Старый skip по state оставлял заметку со
      // ссылкой ![[real.pdf]] на настоящий PDF, лежащий в pdfDummyFolder —
      // снаружи это выглядело как «в dummy записан сырой бинарный PDF», и
      // состояние больше никогда не исправлялось (файл защищён от cleanup,
      // т.к. на него есть ссылка). Дедупликация загрузки выполняется в
      // uploadFile через HeadObject/ETag, поэтому повторный вызов безопасен.
      const uploadResult = await uploadFile(app, settings, client, localFile, noteRelPath);

      if (uploadResult.status === "empty") {
        logger.warn(`Skipped empty file: ${localFile.name} in ${noteRelPath}`);
        onEmpty?.(localFile.name, noteRelPath);
        // Не заменяем ссылку и не удаляем локальный файл, чтобы пользователь мог исправить ситуацию вручную.
        continue;
      }

      if (uploadResult.status !== "ok") {
        logger.error(`Upload failed: ${localFile.name} — ${uploadResult.reason}`);
        continue;
      }

      url = uploadResult.url;
      markProcessed(state, localFile.path, fileHash, url);
      uploadedExt  = ext(localFile.name);
      uploadedName = localFile.name;
    }

    if (!url) continue;

    // ── Replace in content ────────────────────────────────────────────────────
    let newText: string;

    if (kind === "html-img" || kind === "html-video" || kind === "html-audio" || kind === "html-source") {
      // HTML-теги: заменяем только src="..." внутри тега
      newText = fullMatch.replace(ref, url);

    } else if (
      uploadedExt === ".pdf" &&
      (kind === "wiki-embed" || kind === "wiki-link" || kind === "md-embed" || kind === "md-link") &&
      fileHash
    ) {
      // PDF: любая форма ссылки (wiki/markdown, embed/link) → wiki-embed на
      // локальный dummy. Иначе markdown-режим дал бы ссылку на удалённый
      // локальный файл вместо dummy.
      try {
        const dummyName = await ensurePdfDummy(app, settings, uploadedName, fileHash, url);
        newText = `![[${dummyName}]]`;
        logger.info(`PDF dummy ensured: ${dummyName}`);
      } catch (err) {
        logger.error(`Failed to ensure PDF dummy '${uploadedName}': ${err}`);
        continue;
      }

    } else {
      // wiki-embed, md-embed
      // Для wiki-ссылок после pipe может идти ширина / размеры: [[file|750]] / [[file|300x200]]
      let replacementWidth = settings.s3.imageWidth;
      if (kind === "wiki-embed" || kind === "wiki-link") {
        const parsed = parseWikilinkSize(altText);
        if (parsed) replacementWidth = parsed;
      }
      newText = makeReplacement(url, uploadedName, uploadedExt, altText, replacementWidth, kind);
    }

    // Используем callback, чтобы $ в newText не интерпретировался как шаблон замены.
    content = content.replace(fullMatch, () => newText);
    changes++;

    // Локальный файл удаляем после записи заметки (см. deletions выше).
    if (localFile) {
      deletions.push(localFile);
      logger.info(`Uploaded: ${localFile.name} → ${url}`);
    }
  }

  if (changes > 0) {
    await app.vault.modify(mdFile, content);
    logger.info(`Updated note: ${mdFile.name} (${changes} replacements)`);
  }

  // Удаляем исходники только теперь, когда заметка уже переписана, и проверяем
  // результат. Молчаливая неудача оставляла в папке вложений «невидимые» для
  // последующих прогонов копии: заметка уже ссылается на бакет, поэтому sync
  // такой файл больше не увидит.
  for (const file of deletions) {
    if (await removeLocalFile(app, file, logger)) {
      logger.info(`Removed local file: ${file.name}`);
    } else {
      logger.warn(`Local file was NOT removed: ${file.path}`);
      // Повторим при следующем запуске: Obsidian обычно отпускает файл к тому
      // моменту, а до тех пор файл не потеряется.
      queueDeletion(state, file);
      onLeftover?.(file, noteRelPath);
    }
  }

  return changes;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function cmdSync(
  app: App,
  settings: VaultS3Settings,
  state: SyncState,
  logger?: SyncLogger,
  targetFiles?: TFile[]
): Promise<{ totalFiles: number; totalReplacements: number }> {
  const log    = logger ?? consoleLogger();
  const client = createS3Client(settings.s3);

  if (!settings.s3.bucket || !settings.s3.accessKey || !settings.s3.secretKey) {
    new Notice("⚠️ Vault S3 Sync: S3 credentials not configured. Open Settings.", 6000);
    return { totalFiles: 0, totalReplacements: 0 };
  }

  const sourceFiles = targetFiles ?? app.vault.getMarkdownFiles();
  const mdFiles = sourceFiles.filter(
    (f) => !isIgnored(f.path, settings.ignoreFolders)
  );

  log.info(`Found ${mdFiles.length} markdown files`);
  new Notice(`S3 Sync: scanning ${mdFiles.length} notes…`);

  let totalReplacements = 0;
  const emptyFiles: { fileName: string; notePath: string }[] = [];
  const leftovers: { file: TFile; notePath: string }[] = [];
  const errors: string[] = [];
  const failedLog = {
    ...log,
    error: (m: string) => {
      log.error(m);
      errors.push(m);
    },
  };

  const onEmpty = (fileName: string, notePath: string) => {
    emptyFiles.push({ fileName, notePath });
  };

  const onLeftover = (file: TFile, notePath: string) => {
    leftovers.push({ file, notePath });
  };

  // Добиваем удаления, не прошедшие в прошлые прогоны: к этому моменту
  // Obsidian обычно уже отпустил файлы, которые держал плеер.
  const flushed = await flushPendingDeletions(app, state, failedLog, settings);
  if (flushed.done > 0 || flushed.pending > 0) {
    log.info(`Deferred deletions: ${flushed.done} removed, ${flushed.pending} still locked`);
  }

  for (let i = 0; i < mdFiles.length; i++) {
    totalReplacements += await processMdFile(
      app, settings, client, state, mdFiles[i], failedLog, onEmpty, onLeftover
    );
    if ((i + 1) % 50 === 0) new Notice(`S3 Sync: ${i + 1}/${mdFiles.length} notes processed…`);
  }

  // Часть файлов Obsidian не отдаёт, пока медиа открыто в заметке. К концу
  // прогона заметки уже переписаны на S3, хендлы обычно отпущены — поэтому
  // отложенные удаления пробуем ещё раз и только потом жалуемся в отчёте.
  const kept: { file: TFile; notePath: string }[] = [];
  if (leftovers.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const l of leftovers) {
      const fresh = app.vault.getAbstractFileByPath(l.file.path);
      const target = fresh instanceof TFile ? fresh : l.file;
      if (await removeLocalFile(app, target, failedLog)) {
        log.info(`Removed local file (deferred): ${target.name}`);
      } else {
        kept.push(l);
      }
    }
  }

  const hasWarnings = errors.length > 0 || emptyFiles.length > 0 || kept.length > 0;
  const success = !hasWarnings && totalReplacements >= 0;
  const icon = success ? "✅" : totalReplacements > 0 ? "⚠️" : "❌";
  const subtitle = targetFiles && targetFiles.length === 1
    ? `Note: ${targetFiles[0].name}`
    : `${mdFiles.length} notes scanned`;

  const data: ResultData = {
    title: "S3 Sync",
    icon,
    subtitle,
    sections: [
      {
        title: "",
        rows: {
          "📝 Notes processed": String(mdFiles.length),
          "🔗 Embeds replaced": String(totalReplacements),
          "⚠️ Skipped (0-byte files)": String(emptyFiles.length),
          "⚠️ Local files kept": kept.length > 0 ? String(kept.length) : "none",
          ...(flushed.done > 0 || flushed.pending > 0
            ? { "🧹 Deferred deletions": `${flushed.done} removed, ${flushed.pending} still locked` }
            : {}),
          "⚠️ Errors": errors.length > 0 ? String(errors.length) : "none",
        },
        error: hasWarnings,
      },
    ],
  };

  const lists: ResultData["lists"] = [];

  if (emptyFiles.length > 0) {
    lists.push({
      title: "Skipped empty files",
      icon: "⚠️",
      items: emptyFiles.slice(0, 50).map((e) => ({
        label: e.fileName,
        value: e.notePath,
      })),
      initiallyExpanded: true,
    });
  }

  if (errors.length > 0) {
    lists.push({
      title: "Errors",
      icon: "❌",
      items: errors.slice(0, 50).map((e) => ({ label: e })),
      initiallyExpanded: true,
    });
  }

  if (kept.length > 0) {
    lists.push({
      title: "Uploaded, but local copy was not removed",
      icon: "⚠️",
      items: kept.slice(0, 50).map((e) => ({ label: e.file.name, value: e.notePath })),
      initiallyExpanded: true,
    });
    data.sections.push({
      title: "",
      rows: {
        "🛠️ Recommended action":
          "These files are already in the bucket, but Obsidian kept the local copy " +
          "(usually the file was still open). Run Cleanup to move them to trash.",
      },
    });
  }

  if (lists.length > 0) {
    data.lists = lists;
  }

  // Предупреждение об исходных 0-байтовых файлах, если такие были найдены.
  if (emptyFiles.length > 0) {
    const uniqueEmpty = [...new Map(emptyFiles.map((e) => [e.fileName, e])).values()];
    data.sections.push({
      title: "",
      rows: {
        "ℹ️ 0-byte files skipped": uniqueEmpty.length > 1
          ? `${uniqueEmpty.length} files were not uploaded because they contain 0 bytes`
          : `"${uniqueEmpty[0].fileName}" was not uploaded because it contains 0 bytes`,
      },
    });
    data.sections.push({
      title: "",
      rows: {
        "🛠️ Recommended action":
          "These files contain 0 bytes and were not uploaded. " +
          "Links to them in your notes were left unchanged — find the original file or remove the link manually.",
      },
    });
  }

  new ResultModal(app, data).open();

  const msg = `${icon} S3 Sync complete: ${totalReplacements} replacements in ${mdFiles.length} notes`;
  log.info(msg);

  return { totalFiles: mdFiles.length, totalReplacements };
}
