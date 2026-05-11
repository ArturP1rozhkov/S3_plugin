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

export interface SyncState {
  processed: Record<string, ProcessedEntry>;   // key = vault-relative path
  failedExternal: Record<string, FailedExternalEntry>; // key = md5(url)
}

export function emptyState(): SyncState {
  return { processed: {}, failedExternal: {} };
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
