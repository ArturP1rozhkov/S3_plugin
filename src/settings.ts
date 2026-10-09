import { App, PluginSettingTab, Setting, TFolder } from "obsidian";
import type VaultS3Plugin from "./main";

export interface S3Config {
  endpoint: string;
  publicEndpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  quarantineFolder: string;
  quarantineRetentionDays: number;
  folderMap: Record<string, string>;
  imageWidth: number;
  imageMaxPx: number;
  hashFilenames: boolean;
  publicUrlStyle: "path" | "virtual-host";
}

export interface VaultS3Settings {
  s3: S3Config;
  attachmentFolders: string[];
  ignoreFolders: string[];
  ignoreFiles: string[];
  pdfDummyFolder: string;
  trashFolder: string;
  trashRetentionDays: number;
  downloadExternalImages: boolean;
  externalImageTimeoutSec: number;
  maxExternalAttempts: number;
}

export const DEFAULT_SETTINGS: VaultS3Settings = {
  s3: {
    endpoint: "https://s3.cloud.ru",
    publicEndpoint: "",
    bucket: "",
    accessKey: "",
    secretKey: "",
    region: "ru-central-1",
    quarantineFolder: "quarantine",
    quarantineRetentionDays: 14,
    folderMap: {
      image: "media",
      audio: "media",
      video: "media",
      pdf: "docs",
      doc: "docs",
      archive: "files",
      other: "files",
    },
    imageWidth: 550,
    imageMaxPx: 1920,
    hashFilenames: true,
    publicUrlStyle: "path",
  },
  attachmentFolders: ["Картинки", "Attachments", "Файлы"],
  ignoreFolders: [".git", ".obsidian", ".trash", ".vault_tools"],
  ignoreFiles: [".gitignore", ".gitkeep", "*.json", "*.yaml", "*.yml", "*.css", "*.js", "database*"],
  pdfDummyFolder: "Файлы",
  trashFolder: ".trash",
  trashRetentionDays: 7,
  downloadExternalImages: true,
  externalImageTimeoutSec: 10,
  maxExternalAttempts: 3,
};

export class VaultS3SettingTab extends PluginSettingTab {
  plugin: VaultS3Plugin;

  constructor(app: App, plugin: VaultS3Plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault S3 Sync — Settings" });

    // ── S3 Connection ──────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "S3 Connection" });

    new Setting(containerEl).setName("Endpoint").setDesc("S3 API endpoint, e.g. https://s3.cloud.ru")
      .addText(t => t.setPlaceholder("https://s3.cloud.ru")
        .setValue(this.plugin.settings.s3.endpoint)
        .onChange(async v => { this.plugin.settings.s3.endpoint = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Public endpoint").setDesc("Base URL for public object links, e.g. https://yourbucket.s3.cloud.ru")
      .addText(t => t.setPlaceholder("https://yourbucket.s3.cloud.ru")
        .setValue(this.plugin.settings.s3.publicEndpoint)
        .onChange(async v => { this.plugin.settings.s3.publicEndpoint = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Public URL style").setDesc(
      "Path style: publicEndpoint/bucket/key (recommended for MinIO and self-hosted S3). " +
      "Virtual-host style: publicEndpoint/key; the publicEndpoint must already include the bucket name, e.g. https://bucket.s3.provider.tld."
    )
      .addDropdown(dropdown => dropdown
        .addOption("path", "Path style: publicEndpoint/bucket/key")
        .addOption("virtual-host", "Virtual-host style: publicEndpoint/key")
        .setValue(this.plugin.settings.s3.publicUrlStyle)
        .onChange(async v => {
          this.plugin.settings.s3.publicUrlStyle = v as "path" | "virtual-host";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName("Bucket").setDesc("S3 bucket name")
      .addText(t => t.setPlaceholder("mybucket")
        .setValue(this.plugin.settings.s3.bucket)
        .onChange(async v => { this.plugin.settings.s3.bucket = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Access key").addText(t => t
        .setValue(this.plugin.settings.s3.accessKey)
        .onChange(async v => { this.plugin.settings.s3.accessKey = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Secret key").addText(t => {
      t.inputEl.type = "password";
      t.setValue(this.plugin.settings.s3.secretKey)
        .onChange(async v => { this.plugin.settings.s3.secretKey = v.trim(); await this.plugin.saveSettings(); });
    });

    new Setting(containerEl).setName("Region").addText(t => t
        .setValue(this.plugin.settings.s3.region)
        .onChange(async v => { this.plugin.settings.s3.region = v.trim(); await this.plugin.saveSettings(); }));

    // ── Vault structure ────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Vault Structure" });

    new Setting(containerEl).setName("Attachment folders").setDesc("One folder per line (relative to vault root)")
      .addTextArea(t => t.setValue(this.plugin.settings.attachmentFolders.join("\n"))
        .onChange(async v => {
          this.plugin.settings.attachmentFolders = v.split("\n").map(s => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    // Папка для dummy PDF выбирается из списка папок vault (как в системных
    // настройках Obsidian). Это отдельная настройка, потому что системная
    // «папка вложений» менять не нужно: dummy лучше держать в своей папке,
    // иначе имена настоящих PDF и dummy конфликтуют (появляются суффиксы -2).
    const currentDummyFolder = this.plugin.settings.pdfDummyFolder;
    const folderPaths = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && f.path !== "/" && f.path !== "")
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b));
    if (currentDummyFolder && !folderPaths.includes(currentDummyFolder)) {
      // Папки может ещё не быть в vault — не теряем текущее значение.
      folderPaths.unshift(currentDummyFolder);
    }

    new Setting(containerEl)
      .setName("PDF dummy folder")
      .setDesc(
        "Folder where dummy .pdf files are kept (for the PDF++ plugin). " +
        "Pick a folder that is NOT your attachment folder — create it in Obsidian first."
      )
      .addDropdown((d) => {
        for (const p of folderPaths) d.addOption(p, p);
        if (currentDummyFolder && folderPaths.includes(currentDummyFolder)) {
          d.setValue(currentDummyFolder);
        } else if (folderPaths.length > 0) {
          d.setValue(folderPaths[0]);
          this.plugin.settings.pdfDummyFolder = folderPaths[0];
        }
        d.onChange(async (v) => {
          this.plugin.settings.pdfDummyFolder = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Ignore folders").setDesc("One folder per line")
      .addTextArea(t => t.setValue(this.plugin.settings.ignoreFolders.join("\n"))
        .onChange(async v => {
          this.plugin.settings.ignoreFolders = v.split("\n").map(s => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    // ── Options ────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Options" });

    new Setting(containerEl).setName("Image width (px)").setDesc("Width attribute inserted into Markdown for images")
      .addText(t => t.setValue(String(this.plugin.settings.s3.imageWidth))
        .onChange(async v => { this.plugin.settings.s3.imageWidth = parseInt(v) || 550; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Hash filenames in S3").setDesc("Use MD5 hash as S3 key (avoids duplicates and name conflicts)")
      .addToggle(t => t.setValue(this.plugin.settings.s3.hashFilenames)
        .onChange(async v => { this.plugin.settings.s3.hashFilenames = v; await this.plugin.saveSettings(); }));

    // Политика проекта: внешние интернет-ссылки только рендерятся. Тумблер
    // оставлен видимым (чтобы не выглядело как пропавшая настройка), но
    // заблокирован — скачивание внешних ссылок вынесено в отдельную задачу.
    new Setting(containerEl).setName("Download external images")
      .setDesc("Locked: external web links are never downloaded or uploaded to S3, they are only rendered")
      .addToggle(t => t.setValue(false).setDisabled(true));

    new Setting(containerEl).setName("Trash folder").setDesc(`Local orphan files are moved here during cleanup (default: ${DEFAULT_SETTINGS.trashFolder})`)
      .addText(t => t.setValue(this.plugin.settings.trashFolder)
        .onChange(async v => { this.plugin.settings.trashFolder = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("S3 quarantine folder").setDesc("S3 orphan objects are moved to this prefix during cleanup-s3")
      .addText(t => t.setValue(this.plugin.settings.s3.quarantineFolder)
        .onChange(async v => { this.plugin.settings.s3.quarantineFolder = v.trim(); await this.plugin.saveSettings(); }));
  }
}
