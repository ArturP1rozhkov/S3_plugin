import { App, TFile, normalizePath } from "obsidian";
import type { VaultS3Settings } from "../settings";

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

  const existing = app.vault.getAbstractFileByPath(dummyPath);
  if (existing instanceof TFile) {
    // Файл уже есть (например повторный sync) — обновляем содержимое
    const content = await app.vault.read(existing);
    if (content.trim() === s3url) return; // уже актуален
    await app.vault.modify(existing, s3url);
  } else {
    await app.vault.create(dummyPath, s3url);
  }
}

export function isDummyPdf(content: string, size: number): boolean {
  return size < 4096 && content.trim().startsWith("https") && content.includes(".pdf");
}
