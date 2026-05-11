/**
 * Regex patterns — exact port from vault_s3.py
 */
export const RE_WIKI  = /!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
export const RE_MD    = /!\[[^\]]*\]\(([^)]+)\)/g;
export const RE_HTML_IMG   = /<img[^>]+src=["']([^"']+)["']/gi;
export const RE_HTML_VIDEO = /<video[^>]+src=["']([^"']+)["']/gi;
export const RE_HTML_AUDIO = /<audio[^>]+src=["']([^"']+)["']/gi;

export interface ParsedRef {
  fullMatch: string;
  ref: string;        // raw path/url inside the match
  altText?: string;
  kind: "wiki" | "md" | "html-img" | "html-video" | "html-audio";
}

export function parseAllRefs(content: string): ParsedRef[] {
  const results: ParsedRef[] = [];

  for (const m of content.matchAll(RE_WIKI)) {
    results.push({ fullMatch: m[0], ref: m[1].trim(), kind: "wiki" });
  }
  for (const m of content.matchAll(RE_MD)) {
    const altMatch = m[0].match(/!\[([^\]]*)\]/);
    results.push({ fullMatch: m[0], ref: m[1].trim(), altText: altMatch?.[1], kind: "md" });
  }
  for (const m of content.matchAll(RE_HTML_IMG)) {
    results.push({ fullMatch: m[0], ref: m[1].trim(), kind: "html-img" });
  }
  for (const m of content.matchAll(RE_HTML_VIDEO)) {
    results.push({ fullMatch: m[0], ref: m[1].trim(), kind: "html-video" });
  }
  for (const m of content.matchAll(RE_HTML_AUDIO)) {
    results.push({ fullMatch: m[0], ref: m[1].trim(), kind: "html-audio" });
  }

  return results;
}

export function isExternalRef(ref: string): boolean {
  return ref.startsWith("http://") || ref.startsWith("https://");
}

export function isAlreadyS3Ref(ref: string, publicEndpoint: string, endpoint: string, bucket: string): boolean {
  if (publicEndpoint && ref.startsWith(publicEndpoint)) return true;
  if (endpoint && bucket && ref.startsWith(`${endpoint.replace(/\/$/, "")}/${bucket}`)) return true;
  return false;
}

export function makeReplacement(
  url: string,
  filename: string,
  ext: string,
  altText: string | undefined,
  imageWidth: number
): string {
  const e = ext.toLowerCase();
  if ([".mp4",".mov",".avi",".mkv",".webm",".m4v",".ogv"].includes(e))
    return `<video src="${url}" controls width="${imageWidth}"></video>`;
  if ([".mp3",".m4a",".ogg",".wav",".flac",".3gp"].includes(e))
    return `<audio src="${url}" controls></audio>`;
  if ([".png",".jpg",".jpeg",".gif",".webp",".svg",".bmp",".tiff",".ico"].includes(e))
    return `![|${imageWidth}](${url})`;
  if (e === ".pdf")
    return `![[${filename}]]`;
  return `[${altText ?? filename}](${url})`;
}
