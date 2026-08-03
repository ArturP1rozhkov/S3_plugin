import { App, Notice, TFile, normalizePath } from "obsidian";
import type { VaultS3Settings } from "../settings";
import type { SyncState } from "../state";
import { createS3Client, publicUrl, uploadBuffer } from "../s3Client";
import {
  parseAllAttachmentRefs,
  isExternalRef,
  isAlreadyS3Ref,
  makeReplacement,
  splitRef,
  refExt,
  refFilename,
} from "./linkParser";
import {
  ATTACHMENT_EXT,
  fileType,
  s3Key,
  DEFAULT_FOLDER_MAP,
} from "./fileClassifier";
import { ensurePdfDummy, isDummyPdf } from "./pdfDummy";
import {
  isAlreadyProcessed,
  markProcessed,
  shouldSkipExternal,
  recordFailed,
  simpleHash,
} from "../state";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ext(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i).toLowerCase() : "";
}

async function md5Buffer(buf: ArrayBuffer): Promise<string> {
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const arr = Array.from(new Uint8Array(hashBuf));
  return arr.map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
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

async function uploadFile(
  app: App,
  settings: VaultS3Settings,
  client: ReturnType<typeof createS3Client>,
  file: TFile,
  noteRelPath: string
): Promise<string | null> {
  try {
    const buf = await app.vault.readBinary(file);
    if (buf.byteLength === 0) {
      console.warn(`[S3 Sync] Skipping empty file: ${file.name}`);
      return null;
    }

    const e = ext(file.name);
    const hash = await md5Buffer(buf);
    const filename = settings.s3.hashFilenames ? `${hash}${e}` : file.name;
    const folderMap = settings.s3.folderMap ?? DEFAULT_FOLDER_MAP;
    const key = s3Key(folderMap, filename, e);

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
    return publicUrl(settings.s3, key);
  } catch (err) {
    console.error(`[S3 Sync] Upload failed: ${file.name}`, err);
    return null;
  }
}

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

async function processMdFile(
  app: App,
  settings: VaultS3Settings,
  client: ReturnType<typeof createS3Client>,
  state: SyncState,
  mdFile: TFile,
  logger: SyncLogger
): Promise<number> {
  let content = await app.vault.read(mdFile);
  const noteRelPath = mdFile.path;
  let changes = 0;

  for (const parsed of parseAllAttachmentRefs(content, ATTACHMENT_EXT)) {
    const { fullMatch, ref, altText, kind } = parsed;

    const fileExt = refExt(ref);

    if (isAlreadyS3Ref(ref, settings.s3.publicEndpoint, settings.s3.endpoint, settings.s3.bucket)) continue;

    let url: string | null = null;
    let localFile: TFile | null = null;
    let uploadedExt  = fileExt;
    let uploadedName = refFilename(ref);

    // ── External URL ─────────────────────────────────────────────────────────
    if (isExternalRef(ref)) {
      if (!settings.downloadExternalImages) continue;
      if (shouldSkipExternal(state, ref, settings.maxExternalAttempts)) continue;

      const downloaded = await downloadExternal(ref, (settings.externalImageTimeoutSec ?? 10) * 1000);
      if (!downloaded) { recordFailed(state, ref); logger.warn(`External download failed: ${ref}`); continue; }

      const hash = await md5Buffer(downloaded.buf);
      uploadedExt  = downloaded.ext;
      uploadedName = `${hash}${uploadedExt}`;
      const key    = s3Key(settings.s3.folderMap ?? DEFAULT_FOLDER_MAP, uploadedName, uploadedExt);

      try {
        await uploadBuffer(client, settings.s3, key, new Uint8Array(downloaded.buf), "image/jpeg", {
          "source-vault": app.vault.getName(),
          "uploaded-by":  "vault-s3-sync",
          "original-url": encodeURIComponent(ref),
        });
        url = publicUrl(settings.s3, key);
        state.processed[`ext:${simpleHash(ref)}`] = { hash, s3url: url, processedAt: new Date().toISOString() };
      } catch (err) {
        recordFailed(state, ref); logger.error(`External upload failed: ${ref}`); continue;
      }

    // ── Local file ───────────────────────────────────────────────────────────
    } else {
      localFile = resolveLocalRef(app, ref, settings.attachmentFolders);
      if (!localFile) continue;

      if (uploadedExt === ".pdf") {
        if (isDummyPdf(await app.vault.read(localFile), localFile.stat.size)) {
          logger.info(`Skipping dummy PDF: ${localFile.name}`);
          continue;
        }
      }

      const fileBuf  = await app.vault.readBinary(localFile);
      const fileHash = await md5Buffer(fileBuf);
      if (isAlreadyProcessed(state, localFile.path, fileHash)) continue;

      url = await uploadFile(app, settings, client, localFile, noteRelPath);
      if (!url) continue;

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

    } else {
      // wiki-embed, md-embed
      newText = makeReplacement(url, uploadedName, uploadedExt, altText, settings.s3.imageWidth, kind);
    }

    content = content.replace(fullMatch, newText);
    changes++;

    // Удаляем локальный файл после успешной загрузки
    if (localFile) {
      try {
        await app.vault.delete(localFile);
        logger.info(`Uploaded & removed: ${localFile.name} → ${url}`);
      } catch (err) {
        logger.warn(`Could not delete local file: ${localFile.name}`);
      }
    }

    // PDF dummy — создаём ПОСЛЕ удаления оригинала.
    if (uploadedExt === ".pdf") {
      try {
        await ensurePdfDummy(app, settings, uploadedName, url);
        logger.info(`PDF dummy created: ${uploadedName}`);
      } catch (err) {
        logger.error(`Failed to create PDF dummy '${uploadedName}': ${err}`);
      }
    }
  }

  if (changes > 0) {
    await app.vault.modify(mdFile, content);
    logger.info(`Updated note: ${mdFile.name} (${changes} replacements)`);
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

  for (let i = 0; i < mdFiles.length; i++) {
    totalReplacements += await processMdFile(app, settings, client, state, mdFiles[i], log);
    if ((i + 1) % 50 === 0) new Notice(`S3 Sync: ${i + 1}/${mdFiles.length} notes processed…`);
  }

  const msg = `✅ S3 Sync complete: ${totalReplacements} replacements in ${mdFiles.length} notes`;
  new Notice(msg, 8000);
  log.info(msg);

  return { totalFiles: mdFiles.length, totalReplacements };
}
