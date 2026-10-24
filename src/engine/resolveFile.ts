// src/engine/resolveFile.ts
//
// Единый поиск локального файла для ссылки из заметки. Раньше эта логика жила
// только в sync.ts и работала «по имени»; Cleanup же защищал файлы тоже по
// имени — из-за чего скачанная копия `doc.pdf` в папке вложений считалась
// используемой, если в заметке была ссылка на dummy `doc.pdf`.
//
// Теперь обе команды резолвят ссылку в конкретный файл и работают с его путём.

import { App, TFile, normalizePath } from "obsidian";
import { refFilename, splitRef } from "./linkParser";

export interface ResolveOptions {
  /** Папки, в которых плагин ищет вложения по имени. */
  attachmentFolders: string[];
  /**
   * Папка dummy-PDF. Проверяется ДО attachment folders: иначе полноценная копия
   * файла с тем же именем (например скачанный `doc.pdf` в папке вложений)
   * «перехватывает» ссылку у dummy, и рендер уезжает на локальный файл.
   */
  pdfDummyFolder?: string;
  /** Дополнительный фильтр: путь исключается из поиска (например, папка Restore). */
  isExcluded?: (path: string) => boolean;
}

/**
 * Ищет файл для ссылки: точный путь → папки вложений → по имени среди всех
 * файлов vault. Возвращает именно тот файл, на который ссылка указывает
 * согласно той же эвристике, что использует sync.
 */
export function resolveRefFile(
  app: App,
  ref: string,
  options: ResolveOptions
): TFile | null {
  const accept = (candidate: TFile | null | undefined): TFile | null => {
    if (!(candidate instanceof TFile)) return null;
    if (options.isExcluded?.(candidate.path)) return null;
    return candidate;
  };

  const { path: cleanPath } = splitRef(ref);
  const direct = accept(
    app.vault.getAbstractFileByPath(normalizePath(cleanPath)) as TFile | null
  );
  if (direct) return direct;

  const filename = refFilename(ref);

  // Dummy-PDF приоритетнее любой одноимённой копии: на нём держится рендер
  // PDF++ (внутри dummy лежит URL настоящего PDF в бакете).
  const dummyFolder = options.pdfDummyFolder?.trim();
  if (dummyFolder && filename.toLowerCase().endsWith(".pdf")) {
    const dummy = accept(
      app.vault.getAbstractFileByPath(normalizePath(`${dummyFolder}/${filename}`)) as TFile | null
    );
    if (dummy) return dummy;
  }

  for (const folder of options.attachmentFolders ?? []) {
    const candidate = accept(
      app.vault.getAbstractFileByPath(normalizePath(`${folder}/${filename}`)) as TFile | null
    );
    if (candidate) return candidate;
  }

  for (const file of app.vault.getFiles()) {
    if (file.name !== filename) continue;
    const candidate = accept(file);
    if (candidate) return candidate;
  }
  return null;
}
