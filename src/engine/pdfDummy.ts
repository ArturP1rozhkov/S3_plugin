import { App, TFile, normalizePath } from "obsidian";
import type { VaultS3Settings } from "../settings";

const PDF_URL_RE = /^https?:\/\/[^\s\r\n]+\.pdf(?:[?#][^\s\r\n]*)?$/i;
const DUMMY_HASH_RE = /^#\s*vault-s3-sync:md5=([a-f0-9]{32})\s*$/im;

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

function extractHash(content: string): string | null {
  const m = DUMMY_HASH_RE.exec(content);
  return m ? m[1].toLowerCase() : null;
}

function makeDummyContent(s3url: string, md5: string): string {
  return `${s3url}\n# vault-s3-sync:md5=${md5}\n`;
}

/** Returns a unique dummy filename that does not collide with an existing
 *  non-matching file in the dummy folder. If the exact name is occupied by
 *  a file with a different hash (or a real PDF without a hash comment),
 *  appends -2, -3, etc.
 */
async function allocateDummyPath(
  app: App,
  dummyFolder: string,
  filename: string,
  fileHash: string,
  canonicalContent: string
): Promise<string> {
  let candidatePath = normalizePath(`${dummyFolder}/${filename}`);
  const baseName = filename.replace(/\.pdf$/i, "");
  let counter = 2;

  while (true) {
    const existing = app.vault.getAbstractFileByPath(candidatePath);
    if (!existing) {
      await app.vault.create(candidatePath, canonicalContent);
      return candidatePath;
    }

    if (existing instanceof TFile) {
      const content = await app.vault.read(existing);
      // Same hash: this is our dummy (defensive, should have been found earlier).
      if (extractHash(content) === fileHash) {
        if (content !== canonicalContent) {
          await app.vault.modify(existing, canonicalContent);
        }
        return candidatePath;
      }
    }

    // Name collision with a different file/dummy — try a disambiguated name.
    candidatePath = normalizePath(`${dummyFolder}/${baseName}-${counter}.pdf`);
    counter++;
  }
}

/** Create a dummy .pdf file containing the S3 URL (for PDF++ plugin).
 *  При коллизии по MD5-хешу использует один общий dummy-файл,
 *  чтобы избежать дублей для разных исходных имён с идентичным содержимым.
 *  Возвращает имя dummy-файла, которое должно быть использовано в заметке.
 *
 *  Поиск существующего dummy выполняется ИСКЛЮЧИТЕЛЬНО по md5-строке внутри
 *  файла (или точному legacy URL). Никогда не полагаемся на совпадение имени.
 *  Если target-имя занято файлом с другим хешем/содержимым — используем
 *  дизамбигуацию через суффикс (-2, -3...), не перезаписывая чужой файл.
 */
export async function ensurePdfDummy(
  app: App,
  settings: VaultS3Settings,
  filename: string,
  fileHash: string,
  s3url: string
): Promise<string> {
  // После vault.delete() файл может ещё числиться в индексе Obsidian.
  // Ждём один tick чтобы индекс обновился.
  await new Promise(resolve => setTimeout(resolve, 50));

  const dummyFolder = normalizePath(settings.pdfDummyFolder);
  const canonicalContent = makeDummyContent(s3url, fileHash);

  const allFiles = app.vault.getFiles();
  const candidates = allFiles.filter((f) => {
    if (!f.path.startsWith(`${dummyFolder}/`)) return false;
    if (!f.name.toLowerCase().endsWith(".pdf")) return false;
    if (f.stat.size >= 4096) return false;
    return true;
  });

  // 1. Ищем уже существующий dummy с тем же MD5-хешом (новый формат с хешем в теле).
  //    Это единственный надёжный признак "этот dummy для нашего содержимого".
  for (const candidate of candidates) {
    const content = await app.vault.read(candidate);
    if (extractHash(content) === fileHash) {
      // Нашли dummy для того же содержимого — переиспользуем.
      // Если URL изменился (например, сменился endpoint/bucket), обновляем содержимое.
      if (content !== canonicalContent) {
        await app.vault.modify(candidate, canonicalContent);
      }
      return candidate.name;
    }
  }

  // 2. Fallback для legacy-dummy: ТОЛЬКО точное совпадение содержимого.
  //    Никогда не используем extractPdfUrl на бинарных PDF, чтобы не спутать
  //    случайный URL внутри настоящего PDF с dummy-placeholder.
  const legacyContent = `${s3url}\n`;
  for (const candidate of candidates) {
    const content = await app.vault.read(candidate);
    if (content === legacyContent) {
      await app.vault.modify(candidate, canonicalContent);
      return candidate.name;
    }
  }

  // 3. Dummy для этого хеша ещё не существует — создаём по исходному имени файла.
  //    Если имя занято файлом с другим содержимым — дизамбигуируем, не затираем.
  const dummyPath = await allocateDummyPath(app, dummyFolder, filename, fileHash, canonicalContent);
  return dummyPath.split("/").pop() ?? filename;
}

export function isDummyPdf(content: string, size: number): boolean {
  if (size >= 4096) return false;

  const trimmed = content.trimStart();

  // Real PDF binary header
  if (trimmed.startsWith("%PDF-")) return false;

  // Новый формат: наличие md5-строки — надёжный признак dummy.
  if (extractHash(content) !== null) return true;

  // Legacy dummy: первая непустая строка (или markdown-ссылка) — URL на .pdf.
  return extractPdfUrl(content) !== null;
}

/** Exported helper for cleanupS3 key extraction */
export { extractPdfUrl };
