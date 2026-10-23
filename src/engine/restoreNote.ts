// src/engine/restoreNote.ts
//
// Скачивание объектов ТЕКУЩЕЙ заметки в пользовательскую папку.
//
// Это обратная операция к sync, но она НЕ меняет vault-логику: заметка и её
// ссылки остаются как были, dummy-PDF не трогается, из бакета ничего не
// удаляется. Плагин только читает и складывает байты в отдельную папку, которую
// пользователь выбирает сам (по умолчанию — папка Restore).
//
// Зачем: sync удаляет локальные копии после загрузки, поэтому «достать файлы
// обратно» нужно отдельной командой — например, чтобы приложить их к письму.

import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { S3Config, VaultS3Settings } from "../settings";
import type { SyncState } from "../state";
import { createS3Client, downloadObject, headObject } from "../s3Client";
import { md5Buffer } from "./md5";
import { parseAllRefs, refExt, refFilename, splitRef, isExternalRef } from "./linkParser";
import { ATTACHMENT_EXT } from "./fileClassifier";
import { extractPdfUrl, isDummyPdf } from "./pdfDummy";

// ── Публичный URL → ключ объекта ─────────────────────────────────────────────

/**
 * Префикс ссылок в том же виде, в каком его строит publicUrl:
 *   path         → publicEndpoint/bucket/
 *   virtual-host → publicEndpoint/
 * Пустой publicEndpoint трактуем как endpoint.
 */
export function s3UrlPrefix(cfg: S3Config): string {
  const base = (cfg.publicEndpoint?.trim() || cfg.endpoint?.trim() || "").replace(/\/+$/, "");
  if (!base) return "";
  if (cfg.publicUrlStyle === "virtual-host") return `${base}/`;
  return `${base}/${cfg.bucket}/`;
}

function decodeKey(raw: string): string {
  const clean = raw.split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(clean);
  } catch {
    // «%» в имени файла — не URL-escape, оставляем как есть.
    return clean;
  }
}

/**
 * Достаёт ключ объекта из публичного URL; null — ссылка не наше хранилище.
 * Дополнительно понимает форму endpoint/bucket/… : такие ссылки появлялись,
 * когда publicEndpoint не был задан.
 */
export function keyFromS3Url(url: string, cfg: S3Config): string | null {
  const trimmed = url.trim();
  if (!/^https?:/i.test(trimmed)) return null;

  const prefixes: string[] = [];
  const publicPrefix = s3UrlPrefix(cfg);
  if (publicPrefix) prefixes.push(publicPrefix);

  const endpoint = (cfg.endpoint?.trim() || "").replace(/\/+$/, "");
  if (endpoint && cfg.bucket) prefixes.push(`${endpoint}/${cfg.bucket}/`);

  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix)) {
      const key = decodeKey(trimmed.slice(prefix.length));
      return key || null;
    }
  }
  return null;
}

// ── Имена файлов ─────────────────────────────────────────────────────────────

/**
 * Имя файла, безопасное для Windows/macOS/Linux.
 * Используется для `original-name` из метаданных объекта: там может быть что
 * угодно, включая символы, запрещённые в NTFS.
 */
export function sanitizeFilename(name: string, fallback = "file"): string {
  let base = (name ?? "").split("/").pop() ?? "";
  base = base.replace(/[\\/:*?"<>|]/g, "-").replace(/[\u0000-\u001f]/g, "");
  base = base.replace(/\s+/g, " ").trim();
  // Windows не любит имена, заканчивающиеся точкой или пробелом.
  base = base.replace(/[. ]+$/g, "");
  if (!base || base === "." || base === "..") base = fallback;

  const LIMIT = 150;
  if (base.length > LIMIT) {
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot) : "";
    base = base.slice(0, LIMIT - ext.length) + ext;
  }
  return base;
}

/** Имя из метаданных объекта (`x-amz-meta-original-name`), если оно есть. */
export function originalNameFromMetadata(
  metadata: Record<string, string> | undefined,
  fallback: string
): string {
  const raw = metadata?.["original-name"];
  if (!raw) return sanitizeFilename(fallback);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Значение могло быть записано без URL-кодирования — берём как есть.
  }
  return sanitizeFilename(decoded, sanitizeFilename(fallback));
}

/** Свободный путь в папке: `имя.ext`, затем `имя 2.ext`, `имя 3.ext`… */
export function allocateTarget(
  folder: string,
  name: string,
  size: number,
  exists: (path: string) => { size: number } | null
): { path: string; skip: boolean } {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";

  for (let counter = 1; counter < 1000; counter++) {
    const candidateName = counter === 1 ? name : `${base} ${counter}${ext}`;
    const candidate = normalizePath(`${folder}/${candidateName}`);
    const existing = exists(candidate);
    if (!existing) return { path: candidate, skip: false };
    // Тот же размер — считаем, что это уже скачанная копия.
    if (existing.size === size) return { path: candidate, skip: true };
  }
  return { path: normalizePath(`${folder}/${name}`), skip: false };
}

// ── Локальный dummy-PDF для ссылки ![[doc.pdf]] ──────────────────────────────

/** Для ссылки вида `![[doc.pdf]]` находит локальный dummy и URL из него. */
async function readDummyUrl(
  app: App,
  ref: string,
  settings: VaultS3Settings
): Promise<string | null> {
  if (refExt(ref) !== ".pdf") return null;

  const { path: cleanPath } = splitRef(ref);
  const name = refFilename(ref);
  const candidates: Array<TFile | null> = [
    app.vault.getAbstractFileByPath(normalizePath(cleanPath)) as TFile | null,
    app.vault.getAbstractFileByPath(
      normalizePath(`${settings.pdfDummyFolder}/${name}`)
    ) as TFile | null,
    app.vault.getFiles().find((f) => f.name === name) ?? null,
  ];

  for (const candidate of candidates) {
    if (!(candidate instanceof TFile)) continue;
    let content: string;
    try {
      content = await app.vault.read(candidate);
    } catch {
      continue;
    }
    if (!isDummyPdf(content, candidate.stat.size)) continue;
    const url = extractPdfUrl(content);
    if (url) return url;
  }
  return null;
}

// ── Папка назначения ─────────────────────────────────────────────────────────

/** Создаёт папку и родителей. Не бросает: Obsidian кидает "already exists". */
async function ensureFolder(app: App, folder: string): Promise<void> {
  if (!folder || folder === "/") return;
  if (app.vault.getAbstractFileByPath(normalizePath(folder)) instanceof TFolder) return;

  const missing: string[] = [];
  let acc = "";
  for (const part of folder.split("/")) {
    acc = acc ? `${acc}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(normalizePath(acc))) missing.push(acc);
  }
  for (const path of missing) {
    try {
      await app.vault.createFolder(path);
    } catch (err) {
      console.warn(`[S3 Restore] createFolder "${path}": ${err}`);
    }
  }
}

// ── Команда ──────────────────────────────────────────────────────────────────

export interface RestoredFile {
  name: string;
  key: string;
  size: number;
}

export interface RestoreResult {
  folder: string;
  note: string;
  /** Что реально скачали в этой папке. */
  downloaded: RestoredFile[];
  /** Уже было скачано ранее (совпало имя и размер). */
  skipped: string[];
  /** Ссылка наша, а объекта в бакете нет. */
  missing: string[];
  /** Ссылки, которые не относятся к нашему бакету (внешние, локальные). */
  foreign: number;
  /** Те же файлы (имя + размер), уже лежащие в других папках vault. */
  alsoPresent: string[];
  errors: string[];
}

export interface RestoreLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function consoleLogger(): RestoreLogger {  return {
    info: (m) => console.log(`[S3 Restore] ${m}`),
    warn: (m) => console.warn(`[S3 Restore] ${m}`),
    error: (m) => console.error(`[S3 Restore] ${m}`),
  };
}

/**
 * Имя объекта по состоянию плагина: `syncState.processed[путь].s3url` знает,
 * какой файл vault дал этот ключ. Нужно как резерв, когда метаданные объекта
 * недоступны — например, если CORS бакета не отдаёт `x-amz-meta-*` в рендерер.
 */
export function nameFromState(
  state: SyncState | undefined,
  cfg: S3Config
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [vaultPath, entry] of Object.entries(state?.processed ?? {})) {
    const url = entry?.s3url;
    if (!url) continue;
    const key = keyFromS3Url(url, cfg);
    if (!key || map.has(key)) continue;
    const base = vaultPath.split("/").pop();
    if (base) map.set(key, base);
  }
  return map;
}

/**
 * Повтор сетевой операции: обрывы на транспорте — обычное дело, и Chromium
 * показывает их как «blocked by CORS policy». Задержка растёт: 600, 1000, 1400 мс.
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

/**
 * Скачивает объекты, на которые ссылается заметка, в папку `folder`.
 *
 * Восстанавливается:
 *   • любая ссылка на наш бакет;
 *   • ссылка на dummy-PDF — читаем URL из dummy и качаем настоящий PDF.
 *
 * Ничего не меняет: ни текст заметки, ни dummy, ни бакет, ни `syncState`.
 */
export async function downloadNoteObjects(
  app: App,
  settings: VaultS3Settings,
  state: SyncState | undefined,
  mdFile: TFile,
  folder: string,
  logger?: RestoreLogger
): Promise<RestoreResult> {
  const log = logger ?? consoleLogger();
  const target = normalizePath(folder);
  const result: RestoreResult = {
    folder: target,
    note: mdFile.path,
    downloaded: [],
    skipped: [],
    missing: [],
    foreign: 0,
    alsoPresent: [],
    errors: [],
  };

  await ensureFolder(app, target);

  const content = await app.vault.read(mdFile);
  const refs = parseAllRefs(content);
  const client = createS3Client(settings.s3);
  // Имя по состоянию: метаданные объекта читаются не всегда (CORS).
  const knownNames = nameFromState(state, settings.s3);

  log.info(`Restore "${mdFile.path}": ${refs.length} ref(s) → "${target}"`);

  // Если HEAD один раз оборвался по сети, дальше по этому прогону его не
  // пробуем: экономим время на повторах, всё равно пойдём через GET.
  let headUsable = true;

  for (const { ref } of refs) {
    // 1. Ссылка уже на наш бакет?
    let key = keyFromS3Url(ref, settings.s3);

    // 2. Ссылка на локальный dummy-PDF?
    if (!key && !isExternalRef(ref)) {
      try {
        const url = await readDummyUrl(app, ref, settings);
        if (url) key = keyFromS3Url(url, settings.s3);
      } catch (err) {
        log.warn(`dummy lookup failed for "${ref}": ${err}`);
      }
    }

    if (!key) {
      result.foreign++;
      continue;
    }

    const keyName = key.split("/").pop() || refFilename(ref);
    if (!ATTACHMENT_EXT.has(refExt(keyName))) {
      result.foreign++;
      continue;
    }

    // 1. HEAD — быстрый способ узнать размер и метаданные. При сетевом сбое
    // (Chromium маскирует его под «blocked by CORS policy») не сдаёмся:
    // всё нужное есть и в ответе GET, просто запрос будет один вместо двух.
    let head: Awaited<ReturnType<typeof headObject>> | undefined;
    let headError: unknown = null;
    if (headUsable) {
      try {
        head = await withRetry(() => headObject(client, settings.s3, key));
      } catch (err) {
        headError = err;
        headUsable = false;
        log.warn(`HEAD failed, falling back to GET: ${key} — ${err}`);
      }
    } else {
      headError = new Error("HEAD skipped (failed earlier in this run)");
    }
    if (!head && headError === null) {
      result.missing.push(key);
      log.warn(`Object not found: ${key}`);
      continue;
    }

    let bytes: Uint8Array | null = null;
    let metadata: Record<string, string> | undefined = head?.Metadata;
    let size = head?.ContentLength ?? 0;
    let etag = (head?.ETag ?? "").replace(/^"|"$/g, "").toLowerCase();

    if (headError) {
      try {
        const got = await withRetry(() => downloadObject(client, settings.s3.bucket, key));
        bytes = got.bytes;
        metadata = got.metadata;
        size = bytes.byteLength;
        etag = (got.etag ?? "").replace(/^"|"$/g, "").toLowerCase();
      } catch (err: any) {
        result.errors.push(`${key}: ${err?.message ?? err}`);
        log.error(`Download failed: ${key} — ${err?.message ?? err}`);
        continue;
      }
    }

    // Имя: метаданные объекта → имя из состояния → имя из ключа (md5).
    const name = originalNameFromMetadata(metadata, knownNames.get(key) ?? keyName);
    const allocated = allocateTarget(target, name, size, (path) => {
      const file = app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? { size: file.stat.size } : null;
    });

    // Тот же файл уже есть где-то в vault? Сравниваем не имя+размер, а MD5:
    // ETag объекта — это MD5 содержимого (для одиночного PUT), его и сверяем с
    // локальной копией. Совпало — не качаем; не совпало — качаем рядом.
    const sameNamed = app.vault
      .getFiles()
      .filter((f) => f.name === name && f.stat.size === size && f.path !== allocated.path)
      .map((f) => f.path);

    let duplicatePath: string | null = null;
    if (etag) {
      for (const path of sameNamed) {
        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) continue;
        try {
          const buf = await app.vault.readBinary(file);
          if (md5Buffer(buf) === etag) {
            duplicatePath = path;
            break;
          }
        } catch {
          // Нечитаемый файл — не считаем его копией.
        }
      }
    }

    if (duplicatePath) {
      result.skipped.push(duplicatePath);
      for (const path of sameNamed) {
        if (!result.alsoPresent.includes(path)) result.alsoPresent.push(path);
      }
      log.info(`Already in vault (same md5): ${duplicatePath}`);
      continue;
    }

    if (sameNamed.length > 0) {
      for (const path of sameNamed) {
        if (!result.alsoPresent.includes(path)) result.alsoPresent.push(path);
      }
    }

    if (allocated.skip) {
      result.skipped.push(allocated.path);
      log.info(`Already present: ${allocated.path}`);
      continue;
    }

    // 2. GET: если тело уже получено на шаге fallback — используем его,
    // иначе скачиваем только когда файла в vault ещё нет.
    let data = bytes;
    if (!data) {
      try {
        data = (await withRetry(() => downloadObject(client, settings.s3.bucket, key))).bytes;
      } catch (err: any) {
        result.errors.push(`${key}: ${err?.message ?? err}`);
        log.error(`Download failed: ${key} — ${err?.message ?? err}`);
        continue;
      }
    }

    try {
      // slice(): data может быть view на больший ArrayBuffer.
      await app.vault.createBinary(allocated.path, data.slice().buffer);
    } catch (err: any) {
      result.errors.push(`${allocated.path}: ${err?.message ?? err}`);
      log.error(`Write failed: ${allocated.path} — ${err?.message ?? err}`);
      continue;
    }

    result.downloaded.push({
      name: allocated.path.split("/").pop() ?? name,
      key,
      size: data.byteLength,
    });
    log.info(`Restored ${key} → ${allocated.path}`);
  }

  return result;
}
