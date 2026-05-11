import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, VaultS3Settings, VaultS3SettingTab } from "./settings";
import { emptyState, SyncState } from "./state";

export default class VaultS3Plugin extends Plugin {
  settings!: VaultS3Settings;
  syncState!: SyncState;

  async onload() {
    await this.loadSettings();
    this.syncState = emptyState();

    // ── Settings tab ───────────────────────────────────────────────────────
    this.addSettingTab(new VaultS3SettingTab(this.app, this));

    // ── Ribbon icon ────────────────────────────────────────────────────────
    this.addRibbonIcon("cloud-upload", "Vault S3 Sync", () => {
      new Notice("Vault S3 Sync: use Commands (Ctrl+P) to run sync, cleanup or status.");
    });

    // ── Commands ───────────────────────────────────────────────────────────
    this.addCommand({
      id: "s3-sync",
      name: "Sync: upload attachments to S3",
      callback: async () => {
        new Notice("S3 Sync started…");
        const { cmdSync } = await import("./engine/sync");
        await cmdSync(this.app, this.settings, this.syncState);
      },
    });

    this.addCommand({
      id: "s3-cleanup",
      name: "Cleanup: move local orphan files to trash",
      callback: async () => {
        new Notice("S3 Cleanup (local) started…");
        const { cmdCleanup } = await import("./engine/cleanup");
        await cmdCleanup(this.app, this.settings);
      },
    });

    this.addCommand({
      id: "s3-cleanup-s3",
      name: "Cleanup S3: move orphan objects to quarantine",
      callback: async () => {
        new Notice("S3 Cleanup (remote) started…");
        const { cmdCleanupS3 } = await import("./engine/cleanupS3");
        await cmdCleanupS3(this.app, this.settings);
      },
    });

    this.addCommand({
      id: "s3-status",
      name: "Status: show vault & bucket statistics",
      callback: async () => {
        const { cmdStatus } = await import("./engine/status");
        await cmdStatus(this.app, this.settings);
      },
    });

    console.log("Vault S3 Sync plugin loaded");
  }

  onunload() {
    console.log("Vault S3 Sync plugin unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
