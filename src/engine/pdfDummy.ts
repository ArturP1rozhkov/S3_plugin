import { App, TFile, normalizePath } from "obsidian";
import type { VaultS3Settings } from "../settings";

const PDF_URL_RE = /^https?:\/\/[^\s\r\n]+\.pdf(?:[?#][^\s\r\n]*)?$/i;

/**
 * Извлекает URL на .pdf из текста dummy-файла.
 * Поддерживает:
 *   - канонический формат: bare URL + newline
 *   - legacy bare URL
 *   - legacy Markdown-ссылку: [url](url)
 */
function extractPdfUrl(content: string): string | null {
  const trimmed = content.trimStart();

  // Legacy Markdown-link: [url](url)
  const mdMatch = /^\[([^\]]*)\]\(([^\)]*)\)/.exec(trimmed);
  if (mdMatch) {
    const text = mdMatch[1];
    const href = mdMatch[2];
    // Accept if either the link text or the href is a PDF URL.
    // For the current vault format text === href === the URL.
    if (PDF_URL_RE.test(text)) return text;
    if (PDF_URL_RE.test(href)) return href;
    return null;
  }

  // Bare URL (first non-empty line)
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (PDF_URL_RE.test(firstLine)) return firstLine;

  return null;
}

/** Create a dummy .pdf file containing the S3 URL (for PDF++ plugin) */
export async function ensurePdfDummy(
  app: App,
  settings: VaultS3Settings,
  filename: string,
  s3url: string
): Promise<void> {
  const dummyPath = normalizePath(`${settings.pdfDummyFolder}/${filename}`);

  // После vault.delete() файл может ещё числиться в индексе Obsidian.
  // Ждём один tick чтобы индекс обновился.
  await new Promise(resolve => setTimeout(resolve, 50));

  const canonicalContent = `${s3url}\n`;

  const existing = app.vault.getAbstractFileByPath(dummyPath);
  if (existing instanceof TFile) {
    // Файл уже есть (например повторный sync) — обновляем содержимое
    const content = await app.vault.read(existing);
    if (content === canonicalContent) return; // уже актуален
    await app.vault.modify(existing, canonicalContent);
  } else {
    await app.vault.create(dummyPath, canonicalContent);
  }
}

export function isDummyPdf(content: string, size: number): boolean {
  if (size >= 4096) return false;

  const trimmed = content.trimStart();

  // Real PDF binary header
  if (trimmed.startsWith("%PDF-")) return false;

  return extractPdfUrl(content) !== null;
}

/** Exported helper for cleanupS3 key extraction */
export { extractPdfUrl };
