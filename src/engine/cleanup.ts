import { App, Notice } from "obsidian";
import type { VaultS3Settings } from "../settings";

export async function cmdCleanup(app: App, settings: VaultS3Settings): Promise<void> {
  new Notice("cmdCleanup: implementation coming in Step 6");
}
