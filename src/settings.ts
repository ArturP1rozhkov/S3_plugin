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
  /** Куда команда «Restore current note» складывает скачанные объекты. */
  restoreFolder: string;
  /** Папки, которые не предлагаются в пикере Restore (например, «Шаблоны»). */
  restoreFolderExclude: string[];
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
  // Дефолты нейтральные: ничего из личных папок автора. Пользователь задаёт
  // свои пути, а плагин до этого ищет по точному пути и по имени.
  attachmentFolders: ["Attachments"],
  ignoreFolders: [".git", ".obsidian", ".trash", ".vault_tools"],
  ignoreFiles: [".gitignore", ".gitkeep", "*.json", "*.yaml", "*.yml", "*.css", "*.js", "database*"],
  pdfDummyFolder: "PDF",
  restoreFolder: "download",
  restoreFolderExclude: [],
  trashFolder: ".trash",
  trashRetentionDays: 7,
  downloadExternalImages: true,
  externalImageTimeoutSec: 10,
  maxExternalAttempts: 3,
};

// ── Папка скачивания объектов (Restore) ──────────────────────────────────────
//
// Правила (согласованы с ТЗ):
//   • папка живёт внутри vault и выбирается пользователем;
//   • её нельзя выбрать внутри папки dummy-PDF и в системных папках — там
//     скачанные файлы конфликтуют по имени с dummy и ломают рендер;
//   • внутри папок, которые проходит плагин, скачивать можно, но плагин
//     предупреждает: при следующем проходе такие файлы будут удалены
//     (дедупликация/сироты);
//   • если папка не пересекается с папками плагина, она считается
//     изолированной: sync её не видит и не удаляет из неё файлы.

/** Имя папки по умолчанию: предлагается в пикере и создаётся при необходимости. */
export const RESTORE_FOLDER_DEFAULT = "download";

/** Папки, куда скачивать нельзя: системные. */
export const RESTORE_BLOCKED_FOLDERS = [
  ".obsidian",
  ".git",
  ".trash",
  ".trash_attachments",
  ".vault_tools",
];

export type RestoreFolderState =
  | "empty" // ещё не задана — будет использована папка по умолчанию
  | "root" // корень vault
  | "blocked" // системная папка или папка dummy-PDF
  | "inside-plugin" // внутри папки, которую проходит плагин
  | "contains-plugin" // содержит внутри себя папку плагина
  | "ok";

/** Путь папки: прямые слэши, без ведущих и хвостовых слэшей. */
export function normalizeFolderPath(raw: string): string {
  return (raw ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** a == b, a внутри b или b внутри a. */
export function foldersOverlap(a: string, b: string): boolean {
  const x = normalizeFolderPath(a);
  const y = normalizeFolderPath(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Папка, которая реально будет использована (с учётом дефолта). */
export function effectiveRestoreFolder(settings: VaultS3Settings): string {
  return normalizeFolderPath(settings.restoreFolder ?? "") || RESTORE_FOLDER_DEFAULT;
}

export function restoreFolderState(path: string, settings: VaultS3Settings): RestoreFolderState {
  const folder = normalizeFolderPath(path);
  if (!folder) return "root";

  if (RESTORE_BLOCKED_FOLDERS.some((blocked) => foldersOverlap(folder, blocked))) return "blocked";
  // Папка dummy-PDF: скачанный PDF получил бы то же имя, что и dummy.
  if (foldersOverlap(folder, settings.pdfDummyFolder)) return "blocked";

  let containsPlugin = false;
  for (const name of settings.attachmentFolders ?? []) {
    const pluginFolder = normalizeFolderPath(name);
    if (!pluginFolder) continue;
    if (folder === pluginFolder || folder.startsWith(`${pluginFolder}/`)) return "inside-plugin";
    if (pluginFolder.startsWith(`${folder}/`)) containsPlugin = true;
  }
  return containsPlugin ? "contains-plugin" : "ok";
}

/** Состояние папки из настроек: пустая настройка — это "empty", а не "root". */
export function restoreFolderStateOfSettings(settings: VaultS3Settings): RestoreFolderState {
  const raw = normalizeFolderPath(settings.restoreFolder ?? "");
  if (!raw) return "empty";
  return restoreFolderState(raw, settings);
}

/** Изолированная папка: плагин её не видит и не удаляет из неё файлы. */
export function isRestoreFolderIsolated(settings: VaultS3Settings): boolean {
  return restoreFolderState(effectiveRestoreFolder(settings), settings) === "ok";
}

/** Предупреждение/запрет для UI. Пустая строка — всё в порядке. */
export function restoreFolderMessage(state: RestoreFolderState): string {
  switch (state) {
    case "root":
      return "Pick a folder inside the vault: the vault root itself cannot be used.";
    case "blocked":
      return "This folder is not allowed: it is a system folder or the PDF dummy folder. " +
        "Downloaded PDFs would collide with dummy files and break rendering.";
    case "inside-plugin":
      return "The plugin scans this folder: downloaded files will be deleted on the next sync " +
        "(deduplication / orphan cleanup). You can re-download them at any time.";
    case "contains-plugin":
      return "This folder contains a folder the plugin scans: that subfolder is still processed " +
        "by sync and cleanup.";
    default:
      return "";
  }
}

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

    const attachmentSetting = new Setting(containerEl).setName("Attachment folders").setDesc("One folder per line (relative to vault root)")
      .addTextArea(t => t.setValue(this.plugin.settings.attachmentFolders.join("\n"))
        .onChange(async v => {
          this.plugin.settings.attachmentFolders = v.split("\n").map(s => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
          renderMissingFolders();
        }));

    // Маршруты обхода не сверялись с vault: путь мог остаться после удаления
    // папки, и плагин молча его игнорировал. Показываем такие пути явно.
    const renderMissingFolders = (): void => {
      attachmentSetting.descEl.querySelector(".s3sync-restore-warning")?.remove();
      const missing = this.plugin.settings.attachmentFolders.filter((folder) => {
        const path = normalizeFolderPath(folder);
        return path && !(this.app.vault.getAbstractFileByPath(path) instanceof TFolder);
      });
      if (missing.length === 0) return;
      attachmentSetting.descEl.createDiv({
        cls: "s3sync-restore-warning",
        text: `Ignored, not found in vault: ${missing.join(", ")}`,
      });
    };
    renderMissingFolders();

    // Папки, которые не должны предлагаться в пикере Restore.
    new Setting(containerEl)
      .setName("Hidden in Restore picker")
      .setDesc("One folder per line. These folders are not offered as a download destination.")
      .addTextArea((t) => t
        .setValue((this.plugin.settings.restoreFolderExclude ?? []).join("\n"))
        .onChange(async (v) => {
          this.plugin.settings.restoreFolderExclude = v.split("\n").map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    // Папка для dummy PDF выбирается из списка папок vault (как в системных
    // настройках Obsidian). Это отдельная настройка, потому что системная
    // «папка вложений» менять не нужно: dummy лучше держать в своей папке,
    // иначе имена настоящих PDF и dummy конфликтуют (появляются суффиксы -2).
    const currentDummyFolder = this.plugin.settings.pdfDummyFolder;
    const loadedFolders = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && f.path !== "/" && f.path !== "")
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b));
    const existingFolders = new Set(loadedFolders);
    const folderPaths = [...loadedFolders];
    const currentMissing = !!currentDummyFolder && !existingFolders.has(currentDummyFolder);
    if (currentMissing) {
      // Папки в vault уже нет (переименовали/удалили) — не теряем значение,
      // но помечаем его, чтобы это было видно.
      folderPaths.unshift(currentDummyFolder);
    }

    new Setting(containerEl)
      .setName("PDF dummy folder")
      .setDesc(
        "Folder where dummy .pdf files are kept (for the PDF++ plugin). " +
        "Pick a folder that is NOT your attachment folder — the plugin creates it if it does not exist yet."
      )
      .addDropdown((d) => {
        for (const p of folderPaths) {
          d.addOption(p, p === currentDummyFolder && currentMissing ? `⚠ ${p} (not found in vault)` : p);
        }
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

    // Папка для команды Restore. Текстовое поле, а не список: папки может ещё
    // не быть — плагин создаст её сам. Ниже выводится предупреждение, если путь
    // пересекается с папками плагина или недоступен.
    const restoreSetting = new Setting(containerEl)
      .setName("Restore folder")
      .setDesc(
        `Folder where “Restore current note” saves objects downloaded from the bucket ` +
        `(default: ${RESTORE_FOLDER_DEFAULT}). The folder is created automatically. ` +
        `Keep it outside the plugin folders below — otherwise the plugin will delete ` +
        `downloaded files on the next sync.`
      )
      .addText((t) => t
        .setPlaceholder(RESTORE_FOLDER_DEFAULT)
        .setValue(this.plugin.settings.restoreFolder)
        .onChange(async (v) => {
          // Пустое значение означает «использовать папку по умолчанию».
          this.plugin.settings.restoreFolder = v.trim();
          await this.plugin.saveSettings();
          renderRestoreWarning();
        }));

    const renderRestoreWarning = (): void => {
      const state = restoreFolderStateOfSettings(this.plugin.settings);
      const message = restoreFolderMessage(state);
      restoreSetting.descEl.querySelector(".s3sync-restore-warning")?.remove();
      if (!message) return;
      restoreSetting.descEl.createDiv({
        cls: `s3sync-restore-warning${state === "blocked" || state === "root" ? " s3sync-restore-warning-error" : ""}`,
        text: message,
      });
    };
    renderRestoreWarning();

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
