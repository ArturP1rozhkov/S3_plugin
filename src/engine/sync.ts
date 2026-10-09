import { App, Notice, TFile, normalizePath } from "obsidian";
import type { VaultS3Settings } from "../settings";
import type { SyncState } from "../state";
import { createS3Client, publicUrl, uploadBuffer, headObject } from "../s3Client";
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

function resolveLocalRef(
  app: App,
  ref: string,
  attachmentFolders: string[]
): TFile | null {
  const { path: cleanPath } = splitRef(ref);

  const direct = app.vault.getAbstractFileByPath(normalizePath(cleanPath));
  if (direct instanceof TFile) return direct;

  const filename = refFilename(ref);
  for (const folder of attachmentFolders) {
    const candidate = app.vault.getAbstractFileByPath(
      normalizePath(`${folder}/${filename}`)
    );
    if (candidate instanceof TFile) return candidate;
  }

  const found = app.vault.getFiles().find((f) => f.name === filename);
  return found ?? null;
}

export type UploadResult =
  | { status: "ok"; url: string }
  | { status: "empty" }
  | { status: "error"; reason: string };

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

    // Проверяем, нет ли уже в S3 идентичного объекта (по ключу/ETag/размеру),
    // чтобы избежать повторной загрузки того же файла.
    const existing = await headObject(client, settings.s3, key);
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

    await uploadBuffer(client, settings.s3, key, new Uint8Array(buf), contentType, metadata);
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

export async function processMdFile(
  app: App,
  settings: VaultS3Settings,
  client: ReturnType<typeof createS3Client>,
  state: SyncState,
  mdFile: TFile,
  logger: SyncLogger,
  onEmpty?: (fileName: string, notePath: string) => void
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
      localFile = resolveLocalRef(app, ref, settings.attachmentFolders);
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

  // Удаляем исходники только теперь, когда заметка уже переписана.
  for (const file of deletions) {
    try {
      await app.vault.delete(file);
      logger.info(`Removed local file: ${file.name}`);
    } catch (err) {
      logger.warn(`Could not delete local file: ${file.name}`);
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

  for (let i = 0; i < mdFiles.length; i++) {
    totalReplacements += await processMdFile(app, settings, client, state, mdFiles[i], failedLog, onEmpty);
    if ((i + 1) % 50 === 0) new Notice(`S3 Sync: ${i + 1}/${mdFiles.length} notes processed…`);
  }

  const hasWarnings = errors.length > 0 || emptyFiles.length > 0;
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
