// src/engine/restoreModal.ts
//
// Плашка команды «Restore: download current note's objects» — в том же стиле,
// что и остальные модалки плагина: заголовок, сетка строк, кнопки внизу.
//
// Пользователь выбирает папку назначения (из списка существующих или вводит
// новую), видит предупреждение/запрет по правилам из settings.ts и запускает
// скачивание. После выполнения та же плашка показывает отчёт.

import { App, Modal, TFile, TFolder, normalizePath } from "obsidian";
import {
  effectiveRestoreFolder,
  foldersOverlap,
  normalizeFolderPath,
  restoreFolderMessage,
  restoreFolderState,
  RESTORE_BLOCKED_FOLDERS,
  RESTORE_FOLDER_DEFAULT,
  type RestoreFolderState,
  type VaultS3Settings,
} from "../settings";
import type { SyncState } from "../state";
import { downloadNoteObjects, type RestoreResult } from "./restoreNote";

export interface RestoreHost {
  settings: VaultS3Settings;
  syncState: SyncState;
  saveSettings(): Promise<void>;
}

export class RestoreModal extends Modal {
  private host: RestoreHost;
  private note: TFile;
  private folder: string;
  private remember = true;
  private busy = false;
  private report: RestoreResult | null = null;
  private warningEl: HTMLElement | null = null;
  private folderValueEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private downloadBtn: HTMLButtonElement | null = null;

  constructor(app: App, host: RestoreHost, note: TFile) {
    super(app);
    this.host = host;
    this.note = note;
    this.folder = effectiveRestoreFolder(host.settings);
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ── Отрисовка ──────────────────────────────────────────────────────────────

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("s3sync-modal-content");

    const header = contentEl.createDiv({ cls: "s3sync-result-header" });
    header.createEl("h2", { text: "📥 S3 Restore" });
    header.createEl("div", { cls: "s3sync-result-subtitle", text: this.note.name });
    header.createEl("div", {
      cls: "s3sync-result-hint",
      text: this.report
        ? "The note, its links and PDF dummies were not changed."
        : "Downloads only: the note, its links and PDF dummies stay unchanged.",
    });

    if (this.report) this.renderReport(contentEl, this.report);
    else this.renderPicker(contentEl);

    this.renderActions(contentEl);
  }

  private folderCandidates(): string[] {
    const dummyFolder = this.host.settings.pdfDummyFolder ?? "";
    const excluded = this.host.settings.restoreFolderExclude ?? [];
    const available = (path: string): boolean =>
      path !== "/" &&
      path !== "" &&
      !RESTORE_BLOCKED_FOLDERS.some((b) => path === b || path.startsWith(`${b}/`)) &&
      !(!!dummyFolder && foldersOverlap(path, dummyFolder)) &&
      !excluded.some((e) => !!e && foldersOverlap(path, e));

    const folders = (this.app.vault.getAllLoadedFiles?.() ?? [])
      .filter((f): f is TFolder => f instanceof TFolder)
      .map((f) => f.path)
      .filter(available);

    const set = new Set(folders);
    set.add(RESTORE_FOLDER_DEFAULT);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  private renderPicker(parent: HTMLElement): void {
    const rows = parent.createDiv({ cls: "s3sync-status-grid" });
    rows.createDiv({ cls: "s3sync-status-label", text: "📝 Note" });
    rows.createDiv({ cls: "s3sync-status-value", text: this.note.path });
    rows.createDiv({ cls: "s3sync-status-label", text: "📁 Folder" });
    this.folderValueEl = rows.createDiv({
      cls: "s3sync-status-value",
      text: this.folder || RESTORE_FOLDER_DEFAULT,
    });

    const field = parent.createDiv({ cls: "s3sync-restore-field" });

    // Существующие папки — списком, чтобы не угадывать путь руками.
    const select = field.createEl("select", { cls: "dropdown s3sync-restore-input" });
    select.createEl("option", { text: "— existing folder —", attr: { value: "" } });
    for (const folder of this.folderCandidates()) {
      select.createEl("option", { text: folder, attr: { value: folder } });
    }

    const input = field.createEl("input", {
      cls: "s3sync-restore-input",
      attr: { type: "text", placeholder: RESTORE_FOLDER_DEFAULT, value: this.folder },
    });
    this.inputEl = input;

    field.createDiv({
      cls: "s3sync-restore-hint",
      text: "Any vault folder, including a new one. Keep it outside the folders the plugin scans.",
    });

    const rememberRow = field.createDiv({ cls: "s3sync-restore-row" });
    const checkbox = rememberRow.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = this.remember;
    const label = rememberRow.createEl("label", { text: "Remember as default" });
    label.addEventListener("click", () => {
      checkbox.checked = !checkbox.checked;
      this.remember = checkbox.checked;
    });
    checkbox.addEventListener("change", () => {
      this.remember = checkbox.checked;
    });

    this.warningEl = field.createDiv({ cls: "s3sync-restore-warning" });

    const syncFromInput = (): void => {
      this.folder = normalizeFolderPath(input.value) || RESTORE_FOLDER_DEFAULT;
      if (this.folderValueEl) this.folderValueEl.setText(this.folder);
      if (select.value && select.value !== this.folder) select.value = "";
      this.renderWarning();
    };

    select.addEventListener("change", () => {
      if (!select.value) return;
      input.value = select.value;
      syncFromInput();
    });
    input.addEventListener("input", syncFromInput);
    input.addEventListener("change", syncFromInput);

    this.renderWarning();
  }

  private currentState(): RestoreFolderState {
    return restoreFolderState(this.folder, this.host.settings);
  }

  private renderWarning(): void {
    if (!this.warningEl) return;
    const state = this.currentState();
    const message = restoreFolderMessage(state);
    this.warningEl.setText(message);
    this.warningEl.toggleClass(
      "s3sync-restore-warning-error",
      state === "blocked" || state === "root"
    );
    if (this.downloadBtn) {
      const forbidden = state === "blocked" || state === "root";
      this.downloadBtn.disabled = forbidden || this.busy;
      this.downloadBtn.setText(forbidden ? "Folder not allowed" : "Download");
    }
  }

  private renderReport(parent: HTMLElement, report: RestoreResult): void {
    const rows = parent.createDiv({ cls: "s3sync-status-grid" });
    const add = (label: string, value: string): void => {
      rows.createDiv({ cls: "s3sync-status-label", text: label });
      rows.createDiv({ cls: "s3sync-status-value", text: value });
    };
    const totalBytes = report.downloaded.reduce((sum, f) => sum + f.size, 0);

    add("📥 Downloaded", String(report.downloaded.length));
    add("♻️ Already present", String(report.skipped.length));
    add("💾 Size", `${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    add("📁 Folder", report.folder);
    add("🔗 Other links", String(report.foreign));
    add("⚠️ Missing", report.missing.length ? String(report.missing.length) : "none");
    add("⚠️ Errors", report.errors.length ? String(report.errors.length) : "none");

    if (report.alsoPresent.length > 0) {
      this.renderList(parent, "Same files already in other folders", "📍",
        report.alsoPresent.map((path) => ({ label: path })));
    }

    if (report.downloaded.length > 0) {
      this.renderList(parent, "Downloaded", "📥", report.downloaded.map((f) => ({
        label: f.name,
        value: `${(f.size / 1024).toFixed(1)} KB`,
      })));
    }
    if (report.missing.length > 0) {
      this.renderList(parent, "Missing in bucket", "⚠️",
        report.missing.map((key) => ({ label: key })));
    }
    if (report.errors.length > 0) {
      this.renderList(parent, "Errors", "❌", report.errors.map((e) => ({ label: e })));
    }
  }

  private renderList(
    parent: HTMLElement,
    title: string,
    icon: string,
    items: Array<{ label: string; value?: string }>
  ): void {
    const section = parent.createDiv({ cls: "s3sync-result-section" });
    const details = section.createEl("details", { cls: "s3sync-result-details" });
    details.open = true;
    details.createEl("summary", {
      cls: "s3sync-result-summary",
      text: `${icon} ${title} (${items.length})`,
    });
    const list = details.createDiv({ cls: "s3sync-result-list" });
    for (const item of items) {
      const row = list.createDiv({ cls: "s3sync-result-list-item" });
      row.createSpan({ cls: "s3sync-result-list-icon", text: "•" });
      row.createSpan({ cls: "s3sync-result-list-label", text: item.label });
      if (item.value) row.createSpan({ cls: "s3sync-result-list-value", text: item.value });
    }
  }

  private renderActions(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "s3sync-modal-actions" });

    if (this.report) {
      const closeBtn = row.createEl("button", { text: "Close", cls: "mod-cta" });
      closeBtn.addEventListener("click", () => this.close());
      return;
    }

    this.downloadBtn = row.createEl("button", { text: "Download", cls: "mod-cta" });
    this.downloadBtn.addEventListener("click", () => void this.runDownload());

    const closeBtn = row.createEl("button", { text: "Close" });
    closeBtn.addEventListener("click", () => this.close());

    this.renderWarning();
  }

  // ── Запуск ─────────────────────────────────────────────────────────────────

  private async runDownload(): Promise<void> {
    if (this.busy) return;
    const state = this.currentState();
    if (state === "blocked" || state === "root") {
      this.renderWarning();
      return;
    }

    this.busy = true;
    if (this.downloadBtn) {
      this.downloadBtn.disabled = true;
      this.downloadBtn.setText("Downloading…");
    }

    try {
      const folder = normalizePath(this.folder || RESTORE_FOLDER_DEFAULT);
      const result = await downloadNoteObjects(
        this.app,
        this.host.settings,
        this.host.syncState,
        this.note,
        folder
      );

      if (this.remember && this.host.settings.restoreFolder !== folder) {
        this.host.settings.restoreFolder = folder;
        await this.host.saveSettings();
      }

      this.report = result;
      this.render();
    } catch (err) {
      this.report = {
        folder: this.folder,
        note: this.note.path,
        downloaded: [],
        skipped: [],
        missing: [],
        foreign: 0,
        alsoPresent: [],
        errors: [String(err)],
      };
      this.render();
    } finally {
      this.busy = false;
    }
  }
}
