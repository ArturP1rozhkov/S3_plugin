/** Persisted state — tracks processed files and failed external URLs */
export interface ProcessedEntry {
  hash: string;
  s3url: string;
  processedAt: string;
}

export interface FailedExternalEntry {
  url: string;
  attempts: number;
  lastAttempt: string;
}

/**
 * Локальный файл, который не удалось удалить сразу после успешной загрузки:
 * Obsidian ещё держит его (открытый плеер/просмотрщик). Удаление повторяется
 * при следующем запуске sync, когда файл уже отпущен.
 */
export interface PendingDeletion {
  path: string;
  size: number;
  mtime: number;
}

export interface SyncState {
  processed: Record<string, ProcessedEntry>;   // key = vault-relative path
  failedExternal: Record<string, FailedExternalEntry>; // key = md5(url)
  pendingDeletions?: PendingDeletion[];
}

export function emptyState(): SyncState {
  return { processed: {}, failedExternal: {}, pendingDeletions: [] };
}

/** Ставит файл в очередь на удаление (без дублей по пути). */
export function queueDeletion(
  state: SyncState,
  file: { path: string; stat: { size: number; mtime: number } }
): void {
  const queue = (state.pendingDeletions ??= []);
  if (queue.some((entry) => entry.path === file.path)) return;
  queue.push({ path: file.path, size: file.stat.size, mtime: file.stat.mtime });
}

export function isAlreadyProcessed(
  state: SyncState,
  relPath: string,
  currentHash: string
): boolean {
  const entry = state.processed[relPath];
  return !!entry && entry.hash === currentHash;
}

export function markProcessed(
  state: SyncState,
  relPath: string,
  hash: string,
  s3url: string
): void {
  state.processed[relPath] = { hash, s3url, processedAt: new Date().toISOString() };
}

export function shouldSkipExternal(
  state: SyncState,
  url: string,
  maxAttempts: number
): boolean {
  const key = simpleHash(url);
  const entry = state.failedExternal[key];
  return !!entry && entry.attempts >= maxAttempts;
}

export function recordFailed(state: SyncState, url: string): void {
  const key = simpleHash(url);
  const entry = state.failedExternal[key] ?? { url, attempts: 0, lastAttempt: "" };
  entry.attempts += 1;
  entry.lastAttempt = new Date().toISOString();
  state.failedExternal[key] = entry;
}

export function simpleHash(input: string): string {
  // FNV-1a 32-bit — lightweight, no crypto needed for URL keying
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
