import { App, Notice } from "obsidian";
import type { VaultS3Settings } from "../settings";

export async function cmdCleanupS3(app: App, settings: VaultS3Settings): Promise<void> {
  new Notice("cmdCleanupS3: implementation coming in Step 6");
}
