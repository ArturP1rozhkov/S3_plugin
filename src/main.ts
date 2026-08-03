import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, VaultS3Settings, VaultS3SettingTab } from "./settings";
import { emptyState, SyncState } from "./state";
import { cmdSync } from "./engine/sync";
import { cmdCleanup } from "./engine/cleanup";
import { cmdCleanupS3 } from "./engine/cleanupS3";
import { cmdStatus } from "./engine/status";

export function migrateSettings(data: unknown): VaultS3Settings {
  const incoming = (data ?? {}) as Partial<VaultS3Settings>;
  const settings = Object.assign({}, DEFAULT_SETTINGS, incoming);
  settings.s3 = Object.assign({}, DEFAULT_SETTINGS.s3, settings.s3);
  if (incoming.s3 && !incoming.s3.publicUrlStyle) {
    // Older versions behaved like virtual-host style (bucket was omitted from public URL).
    settings.s3.publicUrlStyle = "virtual-host";
  }
  return settings;
}

export default class VaultS3Plugin extends Plugin {
  settings!: VaultS3Settings;
  syncState!: SyncState;

  async onload() {
    await this.loadSettings();
    const saved = await this.loadData();
    this.syncState = saved?.syncState ?? emptyState();

    this.addSettingTab(new VaultS3SettingTab(this.app, this));

    this.addRibbonIcon("cloud-upload", "Vault S3 Sync", () => {
      new Notice("Vault S3 Sync: use Ctrl+P → 'S3' to run commands.");
    });

    this.addCommand({
      id: "s3-sync",
      name: "Sync: upload attachments to S3",
      callback: async () => {
        await cmdSync(this.app, this.settings, this.syncState);
        await this.saveData({ ...this.settings, syncState: this.syncState });
      },
    });

    this.addCommand({
      id: "s3-sync-active-note",
      name: "Sync current active note",
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension.toLowerCase() !== "md") {
          new Notice("Vault S3 Sync: open a Markdown note first.");
          return;
        }
        if (activeFile.path.split("/").some((p) => this.settings.ignoreFolders.includes(p))) {
          new Notice("Vault S3 Sync: active note is in an ignored folder.");
          return;
        }
        try {
          await cmdSync(this.app, this.settings, this.syncState, undefined, [activeFile]);
          await this.saveData({ ...this.settings, syncState: this.syncState });
        } catch (err) {
          console.error("[S3 Sync] Sync current active note failed:", err);
          new Notice("Vault S3 Sync: failed to sync active note. See console.", 6000);
        }
      },
    });

    this.addCommand({
      id: "s3-cleanup",
      name: "Cleanup: move local orphan files to trash",
      callback: async () => {
        await cmdCleanup(this.app, this.settings, this.syncState);
      },
    });

    this.addCommand({
      id: "s3-cleanup-dry-run",
      name: "Cleanup (dry run): preview orphan files without moving",
      callback: async () => {
        await cmdCleanup(this.app, this.settings, this.syncState, true);
      },
    });

    this.addCommand({
      id: "s3-cleanup-s3",
      name: "Cleanup S3: move orphan objects to quarantine",
      callback: async () => {
        await cmdCleanupS3(this.app, this.settings);
      },
    });

    this.addCommand({
      id: "s3-cleanup-s3-dry-run",
      name: "Cleanup S3 (dry run): preview orphan objects without moving",
      callback: async () => {
        await cmdCleanupS3(this.app, this.settings, true);
      },
    });

    this.addCommand({
      id: "s3-status",
      name: "Status: show vault & bucket statistics",
      callback: async () => {
        await cmdStatus(this.app, this.settings);
      },
    });

    console.log("Vault S3 Sync plugin loaded ✓");
  }

  onunload() {
    console.log("Vault S3 Sync plugin unloaded");
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = migrateSettings(data);
  }

  async saveSettings() {
    await this.saveData({ ...this.settings, syncState: this.syncState });
  }
}
