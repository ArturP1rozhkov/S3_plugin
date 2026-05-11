export const IMAGE_EXT   = new Set([".png",".jpg",".jpeg",".gif",".webp",".svg",".bmp",".tiff",".ico"]);
export const AUDIO_EXT   = new Set([".mp3",".m4a",".ogg",".wav",".flac",".3gp"]);
export const VIDEO_EXT   = new Set([".mp4",".mov",".avi",".mkv",".webm",".m4v",".ogv"]);
export const PDF_EXT     = new Set([".pdf"]);
export const DOC_EXT     = new Set([".fb2",".epub",".djvu",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".txt"]);
export const ARCHIVE_EXT = new Set([".zip",".tar",".gz",".7z",".rar"]);

export const ATTACHMENT_EXT = new Set([
  ...IMAGE_EXT, ...AUDIO_EXT, ...VIDEO_EXT, ...PDF_EXT, ...DOC_EXT, ...ARCHIVE_EXT,
]);

export type FileType = "image" | "audio" | "video" | "pdf" | "doc" | "archive" | "other";

export function fileType(ext: string): FileType {
  const e = ext.toLowerCase();
  if (IMAGE_EXT.has(e))   return "image";
  if (AUDIO_EXT.has(e))   return "audio";
  if (VIDEO_EXT.has(e))   return "video";
  if (PDF_EXT.has(e))     return "pdf";
  if (DOC_EXT.has(e))     return "doc";
  if (ARCHIVE_EXT.has(e)) return "archive";
  return "other";
}

export const DEFAULT_FOLDER_MAP: Record<FileType, string> = {
  image: "media", audio: "media", video: "media",
  pdf: "docs", doc: "docs", archive: "files", other: "files",
};

export function s3Key(
  folderMap: Record<string, string>,
  filename: string,
  ext: string
): string {
  const type = fileType(ext);
  const folder = folderMap[type] ?? folderMap["other"] ?? "files";
  return folder ? `${folder}/${filename}` : filename;
}
