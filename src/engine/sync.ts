import { App, Notice } from "obsidian";
import type { VaultS3Settings } from "../settings";
import type { SyncState } from "../state";

// Full implementation — Шаг 5
export async function cmdSync(
  app: App,
  settings: VaultS3Settings,
  state: SyncState
): Promise<void> {
  new Notice("cmdSync: implementation coming in Step 5");
}
