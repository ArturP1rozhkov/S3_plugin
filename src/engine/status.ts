import { App, Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { VaultS3Settings } from "../settings";
import { createS3Client, listAllObjects } from "../s3Client";
import { ATTACHMENT_EXT } from "./fileClassifier";
import { parseAllRefs, isExternalRef } from "./linkParser";

function isIgnored(path: string, ignoreFolders: string[]): boolean {
  return path.split("/").some((p) => ignoreFolders.includes(p));
}

export interface ResultSection {
  title: string;
  rows: Record<string, string>;
  error?: boolean;
}

export interface ResultList {
  title: string;
  icon?: string;
  items: Array<{ label: string; value?: string; icon?: string }>;
  initiallyExpanded?: boolean;
  maxInitialItems?: number;
}

export interface ResultData {
  title: string;
  icon?: string;
  subtitle?: string;
  /** Уточняющая строка под подзаголовком: например, куда сохранены файлы. */
  hint?: string;
  sections: ResultSection[];
  lists?: ResultList[];
}

/** Кнопка действия в модалке результата. */
export interface ResultAction {
  label: string;
  /** Основная (подсвеченная) кнопка. */
  cta?: boolean;
  /** Выполняется по клику; содержимое модалки можно обновить через modal.setData(). */
  run: (modal: ResultModal) => void | Promise<void>;
}

export class ResultModal extends Modal {
  private data: ResultData;
  private actions: ResultAction[];
  private onClosed?: () => void;

  constructor(
    app: App,
    data: ResultData,
    actions: ResultAction[] = [],
    onClosed?: () => void
  ) {
    super(app);
    this.data = data;
    this.actions = actions;
    this.onClosed = onClosed;
  }

  /** Обновляет уже открытую модалку (например, показывает итог после перемещения). */
  setData(data: ResultData, actions: ResultAction[] = []): void {
    this.data = data;
    this.actions = actions;
    this.render();
  }

  onOpen() {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("s3sync-modal-content");

    const header = contentEl.createDiv({ cls: "s3sync-result-header" });
    header.createEl("h2", {
      text: this.data.icon ? `${this.data.icon} ${this.data.title}` : this.data.title,
    });
    if (this.data.subtitle) {
      header.createEl("div", { cls: "s3sync-result-subtitle", text: this.data.subtitle });
    }
    // Пояснение под заголовком: куда сохранены файлы, что осталось локально и т.п.
    if (this.data.hint) {
      header.createEl("div", { cls: "s3sync-result-hint", text: this.data.hint });
    }

    for (const section of this.data.sections) {
      const grid = contentEl.createDiv({ cls: "s3sync-status-grid" });
      if (section.error) {
        grid.addClass("s3sync-status-grid-error");
      }
      for (const [label, value] of Object.entries(section.rows)) {
        grid.createDiv({ cls: "s3sync-status-label", text: label });
        const valueEl = grid.createDiv({ cls: "s3sync-status-value", text: value });
        if (section.error) {
          valueEl.addClass("s3sync-status-value-error");
        }
      }
    }

    for (const list of this.data.lists ?? []) {
      this.renderList(contentEl, list);
    }

    this.renderActions(contentEl);
  }

  private renderActions(container: HTMLElement): void {
    if (this.actions.length === 0) return;

    const row = container.createDiv({ cls: "s3sync-modal-actions" });

    const addButton = (
      label: string,
      cta: boolean,
      handler: () => void | Promise<void>
    ): void => {
      const opts: { text: string; cls?: string } = { text: label };
      if (cta) opts.cls = "mod-cta";
      const btn = row.createEl("button", opts);
      btn.addEventListener("click", async () => {
        if (typeof btn.setAttr === "function") btn.setAttr("disabled", "true");
        try {
          await handler();
        } catch (err) {
          // Действие не должно «подвешивать» вызвавшую его команду.
          console.error("[S3 Sync] Modal action failed:", err);
        } finally {
          if (typeof btn.removeAttribute === "function") btn.removeAttribute("disabled");
        }
      });
    };

    // Порядок: основное действие → второстепенные (Close).
    for (const action of this.actions.filter((a) => a.cta)) {
      addButton(action.label, true, () => action.run(this));
    }
    for (const action of this.actions.filter((a) => !a.cta)) {
      addButton(action.label, false, () => action.run(this));
    }
  }

  private renderList(container: HTMLElement, list: ResultList) {
    const section = container.createDiv({ cls: "s3sync-result-section" });
    const titleText = list.icon ? `${list.icon} ${list.title}` : list.title;
    const count = list.items.length;
    const summaryEl = section.createEl("details", { cls: "s3sync-result-details" });
    summaryEl.open = list.initiallyExpanded ?? (count <= (list.maxInitialItems ?? 15));

    const summary = summaryEl.createEl("summary", { cls: "s3sync-result-summary" });
    summary.setText(`${titleText} (${count})`);

    const listEl = summaryEl.createDiv({ cls: "s3sync-result-list" });
    for (const item of list.items) {
      const row = listEl.createDiv({ cls: "s3sync-result-list-item" });
      const icon = item.icon ?? "•";
      row.createSpan({ cls: "s3sync-result-list-icon", text: icon });
      row.createSpan({ cls: "s3sync-result-list-label", text: item.label });
      if (item.value) {
        row.createSpan({ cls: "s3sync-result-list-value", text: item.value });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

export async function cmdStatus(app: App, settings: VaultS3Settings): Promise<void> {
  const { attachmentFolders, ignoreFolders, s3 } = settings;
  new Notice("S3 Status: collecting data…");

  // ── Local stats ───────────────────────────────────────────────────────
  let localCount = 0;
  let localSize = 0;
  for (const folderName of attachmentFolders) {
    const folder = app.vault.getAbstractFileByPath(normalizePath(folderName));
    if (!(folder instanceof TFolder)) continue;
    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      const ext = "." + child.extension.toLowerCase();
      if (!ATTACHMENT_EXT.has(ext)) continue;
      localCount++;
      localSize += child.stat.size;
    }
  }

  // ── Markdown notes ────────────────────────────────────────────────────
  const mdFiles = app.vault.getMarkdownFiles().filter(
    (f) => !isIgnored(f.path, ignoreFolders)
  );

  // ── S3 stats ──────────────────────────────────────────────────────────
  let s3Count = 0;
  let s3Size = 0;
  const s3ByFolder: Record<string, number> = {};
  let s3Error = "";

  if (s3.bucket && s3.accessKey && s3.secretKey) {
    try {
      const client = createS3Client(s3);
      const objects = await listAllObjects(client, s3.bucket);
      s3Count = objects.length;
      s3Size = objects.reduce((sum, o) => sum + o.size, 0);
      for (const obj of objects) {
        const folder = obj.key.includes("/") ? obj.key.split("/")[0] : "root";
        s3ByFolder[folder] = (s3ByFolder[folder] ?? 0) + 1;
      }
    } catch (err) {
      s3Error = "Cannot connect to S3";
      console.error("[S3 Status]", err);
    }
  } else {
    s3Error = "S3 not configured";
  }

  // ── S3 refs in vault ──────────────────────────────────────────────────
  const publicEndpoint = s3.publicEndpoint.replace(/\/$/, "");
  let s3RefCount = 0;
  for (const md of mdFiles) {
    try {
      const text = await app.vault.read(md);
      const urls = text.match(/https?:\/\/[^\s)"'>]+/g) ?? [];
      for (const url of urls) {
        if (publicEndpoint && url.startsWith(publicEndpoint)) s3RefCount++;
      }
    } catch { /* skip */ }
  }

  // ── Build display data ────────────────────────────────────────────────
  const mainRows: Record<string, string> = {
    "📝 Markdown files": String(mdFiles.length),
    "📎 Local attachments": `${localCount} files (${(localSize / 1024 / 1024).toFixed(2)} MB)`,
    "🔗 S3 links in notes": String(s3RefCount),
    "☁️ S3 objects": s3Error
      ? `⚠️ ${s3Error}`
      : `${s3Count} files (${(s3Size / 1024 / 1024).toFixed(2)} MB)`,
  };

  const sections: ResultSection[] = [{ title: "", rows: mainRows }];

  if (!s3Error) {
    const folderRows: Record<string, string> = {};
    for (const [folder, count] of Object.entries(s3ByFolder).sort()) {
      folderRows[`  └ ${folder}/`] = `${count} objects`;
    }
    sections.push({ title: "", rows: folderRows });
  } else {
    sections[0].error = true;
  }

  const footerRows: Record<string, string> = {
    "🗑️ Trash folder": settings.trashFolder,
    "🔒 Quarantine prefix": s3.quarantineFolder + "/",
  };
  sections.push({ title: "", rows: footerRows });

  new ResultModal(app, {
    title: "Vault S3 Sync — Status",
    sections,
  }).open();
  console.log("[S3 Status]", mainRows, s3ByFolder, footerRows);
}
