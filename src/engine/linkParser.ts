// src/engine/linkParser.ts

export type RefKind =
  | "wiki-embed"
  | "wiki-link"
  | "md-embed"
  | "md-link"
  | "html-img"
  | "html-video"
  | "html-audio"
  | "html-source";

export interface ParsedRef {
  fullMatch: string;
  ref: string;      // raw ref как в тексте (может содержать #anchor и ?query)
  altText: string;
  kind: RefKind;
}

// ── Регулярки ────────────────────────────────────────────────────────────────

// (?<!\^) — исключает Obsidian inline footnote ^[[...]]
const RE_WIKI = /(?<!\^)(!?\[\[)(.*?)\]\]/g;

// Markdown image/link: ![alt](url "title") / [text](url).
// Title в кавычках после URL стрипаем отдельно.
const RE_MD = /(!?\[([^\]]*)\])\(([^\s")]+)(?:\s+"[^"]*")?\)/g;

const RE_HTML_IMG    = /<img[^>]*\bsrc="([^"]+)"[^>]*>/gi;
const RE_HTML_VIDEO  = /<video\b[^>]*\bsrc="([^"]+)"[^>]*>(?:<\/video>)?/gi;
const RE_HTML_AUDIO  = /<audio\b[^>]*\bsrc="([^"]+)"[^>]*>(?:<\/audio>)?/gi;
const RE_HTML_SOURCE = /<source\b[^>]*\bsrc="([^"]+)"[^>]*>(?:<\/source>)?/gi;

// ── Утилиты ──────────────────────────────────────────────────────────────────

/** Checks whether a parsed reference is a file attachment embed candidate. */
export function isAttachmentCandidate(
  parsed: ParsedRef,
  allowedExts: Set<string> | ReadonlySet<string>
): boolean {
  const { kind, ref } = parsed;

  // Only explicit embeds / media tags can be attachment candidates.
  if (
    kind !== "wiki-embed" &&
    kind !== "md-embed" &&
    kind !== "html-img" &&
    kind !== "html-video" &&
    kind !== "html-audio" &&
    kind !== "html-source"
  ) {
    return false;
  }

  const { path, anchor } = splitRef(ref);
  const ext = refExt(ref);

  // Fragment-only or note transclusion references are never file attachments.
  if (!path) return false;
  if (path.toLowerCase().endsWith(".md")) return false;

  // Obsidian heading or block references point into a note, not a raw file.
  if (anchor.startsWith("^") || anchor.includes("#")) return false;

  // HTML media tags are allowed only when their src points to a known attachment.
  if (kind.startsWith("html-")) {
    return allowedExts.has(ext);
  }

  // Wiki embeds must target a real attachment file, not a note transclusion.
  if (kind === "wiki-embed") {
    return allowedExts.has(ext);
  }

  // Markdown embeds must target a known attachment.
  if (kind === "md-embed") {
    return allowedExts.has(ext);
  }

  return false;
}

/** Parse only attachment-embed candidates that should enter the sync pipeline. */
export function parseAllAttachmentRefs(
  content: string,
  allowedExts: Set<string> | ReadonlySet<string>
): ParsedRef[] {
  return parseAllRefs(content).filter((r) => isAttachmentCandidate(r, allowedExts));
}

/**
 * Разбирает сырой ref на составляющие.
 *
 * Примеры:
 *   "file.pdf#page=3"      → { path: "file.pdf",       query: "",      anchor: "page=3" }
 *   "img.jpg?ver=2"        → { path: "img.jpg",        query: "ver=2", anchor: "" }
 *   "Folder/img.jpg"       → { path: "Folder/img.jpg", query: "",      anchor: "" }
 *   "#fnref-1"             → { path: "",               query: "",      anchor: "fnref-1" }
 *   "https://s3.../a.jpg"  → { path: "https://...",    query: "",      anchor: "" }
 */
export function splitRef(raw: string): { path: string; query: string; anchor: string } {
  raw = raw.trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return { path: raw, query: "", anchor: "" };
  }
  const hashIdx = raw.indexOf("#");
  const anchor  = hashIdx >= 0 ? raw.slice(hashIdx + 1) : "";
  const before  = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const qIdx    = before.indexOf("?");
  const query   = qIdx >= 0 ? before.slice(qIdx + 1) : "";
  const path    = qIdx >= 0 ? before.slice(0, qIdx)  : before;
  return { path: path.trim(), query, anchor };
}

/**
 * Возвращает расширение (.pdf, .jpg …) или "".
 * Корректно стрипает #anchor и ?query перед определением расширения.
 */
export function refExt(raw: string): string {
  const { path } = splitRef(raw);
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i).toLowerCase() : "";
}

/**
 * Возвращает имя файла из пути (без папок, без anchor/query).
 * "Folder/img.jpg#p=1" → "img.jpg"
 */
export function refFilename(raw: string): string {
  const { path } = splitRef(raw);
  return path.split("/").pop() ?? path;
}

export function isExternalRef(ref: string): boolean {
  return ref.startsWith("http://") || ref.startsWith("https://");
}

export function isAlreadyS3Ref(
  ref: string,
  publicEndpoint: string,
  endpoint: string,
  bucket: string
): boolean {
  const pe = publicEndpoint?.replace(/\/$/, "");
  if (pe && ref.startsWith(pe)) return true;
  if (endpoint && bucket && ref.startsWith(`${endpoint.replace(/\/$/, "")}/${bucket}`)) return true;
  return false;
}

// ── Парсер ───────────────────────────────────────────────────────────────────

export function parseAllRefs(content: string): ParsedRef[] {
  const results: ParsedRef[] = [];

  // Wiki-ссылки: [[file]] и ![[file]]
  // ^[[...]] (Obsidian inline footnote) исключены через (?<!\^) в RE_WIKI
  for (const m of content.matchAll(RE_WIKI)) {
    const embed = m[0].startsWith("!");
    const inner = m[2].trim();
    const [refPart, ...aliasParts] = inner.split("|");
    results.push({
      fullMatch: m[0],
      ref:       refPart.trim(),
      altText:   aliasParts.join("|").trim(),
      kind:      embed ? "wiki-embed" : "wiki-link",
    });
  }

  // Markdown-ссылки: ![alt](ref) и [text](ref)
  for (const m of content.matchAll(RE_MD)) {
    results.push({
      fullMatch: m[0],
      ref:       m[3].trim(),
      altText:   m[2],
      kind:      m[0].startsWith("!") ? "md-embed" : "md-link",
    });
  }

  // HTML-теги
  for (const m of content.matchAll(RE_HTML_IMG)) {
    results.push({ fullMatch: m[0], ref: m[1], altText: "", kind: "html-img" });
  }
  for (const m of content.matchAll(RE_HTML_VIDEO)) {
    results.push({ fullMatch: m[0], ref: m[1], altText: "", kind: "html-video" });
  }
  for (const m of content.matchAll(RE_HTML_AUDIO)) {
    results.push({ fullMatch: m[0], ref: m[1], altText: "", kind: "html-audio" });
  }
  for (const m of content.matchAll(RE_HTML_SOURCE)) {
    results.push({ fullMatch: m[0], ref: m[1], altText: "", kind: "html-source" });
  }

  return results;
}

// ── makeReplacement ──────────────────────────────────────────────────────────

const IMAGE_EXT = new Set([".png",".jpg",".jpeg",".gif",".webp",".svg",".bmp",".tiff",".ico"]);
const VIDEO_EXT = new Set([".mp4",".mov",".avi",".mkv",".webm",".m4v",".ogv"]);
const AUDIO_EXT = new Set([".mp3",".m4a",".ogg",".wav",".flac",".3gp"]);

export function makeReplacement(
  url: string,
  filename: string,
  fileExt: string,
  altText: string,
  imageWidth?: number,
  kind?: RefKind
): string {
  const w = imageWidth ?? 550;

  if (IMAGE_EXT.has(fileExt)) return `![|${w}](${url})`;
  if (VIDEO_EXT.has(fileExt)) return `<video src="${url}" controls></video>`;
  if (AUDIO_EXT.has(fileExt)) return `<audio src="${url}" controls></audio>`;

  // PDF всегда остаётся как wiki-ссылка на dummy файл в vault (для PDF++ plugin)
  if (fileExt === ".pdf") return `![[${filename}]]`;

  // doc/archive/other — обычная markdown-ссылка
  const label = altText || filename.replace(/\.[^.]+$/, "");
  return `[${label}](${url})`;
}
