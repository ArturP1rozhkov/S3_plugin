import { App, Modal, Notice } from "obsidian";
import type { VaultS3Settings } from "../settings";

export async function cmdStatus(app: App, settings: VaultS3Settings): Promise<void> {
  new Notice("cmdStatus: implementation coming in Step 6");
}
