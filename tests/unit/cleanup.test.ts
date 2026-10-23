import { App, TFile, TFolder, normalizePath } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { cmdCleanup } from "../../src/engine/cleanup";
import { DEFAULT_SETTINGS } from "../../src/settings";

// Тесты работают с фиксированной раскладкой ("Файлы" — и папка вложений, и
// папка dummy), поэтому настройки задаются явно, а не берутся из дефолтов
// плагина: дефолты намеренно нейтральные и не содержат личных папок.
const TEST_SETTINGS = {
  ...DEFAULT_SETTINGS,
  attachmentFolders: ["Файлы"],
  pdfDummyFolder: "Файлы",
};

vi.mock("obsidian", () => {
  // Универсальный DOM-stub: вложенные createEl/createDiv возвращают такой же stub.
  // Кнопка "Move to trash" в askConfirmation «нажимается» сразу — иначе реальная
  // ветка cmdCleanup (dryRun = false) ждала бы клика вечно.
  function makeStubEl(opts?: { text?: string }): any {
    const el: any = {
      style: {},
      setText: vi.fn(() => el),
      addClass: vi.fn(() => el),
      removeClass: vi.fn(() => el),
      empty: vi.fn(() => el),
      setAttr: vi.fn(() => el),
      appendChild: vi.fn(() => el),
      addEventListener: (ev: string, cb: () => void) => {
        // Кнопки действий в ResultModal: «Move N file(s) to trash» /
        // «Move N object(s) to quarantine» — нажимаем сразу.
        if (ev === "click" && typeof opts?.text === "string" && /to trash|to quarantine/.test(opts.text)) {
          cb();
        }
      },
      createEl: vi.fn((_tag: string, o?: any) => makeStubEl(o)),
      createDiv: vi.fn((o?: any) => makeStubEl(o)),
      createSpan: vi.fn((o?: any) => makeStubEl(o)),
      appendText: vi.fn(() => el),
    };
    return el;
  }

  return {
  App: class {},
  Modal: class {
    contentEl: any;
    titleEl: any;
    constructor(public app: any) {
      this.contentEl = makeStubEl();
      this.titleEl = makeStubEl();
    }
    open() { (this as any).onOpen?.(); }
    close() { (this as any).onClose?.(); }
  },
  Notice: class {
    constructor(public message: string, public timeout?: number) {}
  },
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {
    setName() { return this; }
    setDesc() { return this; }
    addText() { return this; }
    addDropdown() { return this; }
    addTextArea() { return this; }
    addToggle() { return this; }
  },
  TFile: class {
    public basename: string;
    public extension: string;
    constructor(public name: string, public path: string, public stat: { size: number }) {
      const lastDot = name.lastIndexOf(".");
      this.basename = lastDot > 0 ? name.slice(0, lastDot) : name;
      this.extension = lastDot >= 0 ? name.slice(lastDot + 1) : "";
    }
  },
  TFolder: class {
    constructor(public name: string, public path: string) {}
    children: any[] = [];
  },
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
  };
});

function makeCleanupApp(filesData: { name: string; content: string; folder?: string }[]) {
  const allFiles: TFile[] = [];
  const contents = new Map<string, string>();
  const folders = new Map<string, TFolder>();

  function ensureFolder(path: string) {
    const np = normalizePath(path);
    if (!folders.has(np)) {
      folders.set(np, new (TFolder as any)(np.split("/").pop() ?? np, np));
    }
    return folders.get(np)!;
  }

  for (const f of filesData) {
    const folder = f.folder ?? "Файлы";
    if (folder) ensureFolder(folder);
    const path = folder ? normalizePath(`${folder}/${f.name}`) : normalizePath(f.name);
    const file = new (TFile as any)(f.name, path, { size: f.content.length });
    allFiles.push(file);
    contents.set(path, f.content);
  }

  // Build metadata cache from markdown files
  const embedsCache = new Map<string, { link: string }[]>();
  const linksCache = new Map<string, { link: string }[]>();

  for (const f of filesData) {
    if (f.name.endsWith(".md")) {
      const path = f.folder ? normalizePath(`${f.folder}/${f.name}`) : normalizePath(f.name);
      const embeds: { link: string }[] = [];
      const links: { link: string }[] = [];

      for (const m of f.content.matchAll(/!\[\[([^\]|]+)/g)) {
        embeds.push({ link: m[1] });
      }
      for (const m of f.content.matchAll(/(?<!!)\[\[([^\]|]+)/g)) {
        links.push({ link: m[1] });
      }

      embedsCache.set(path, embeds);
      linksCache.set(path, links);
    }
  }

  const indexOfPath = (p: string) => {
    const np = normalizePath(p);
    return allFiles.findIndex((f) => normalizePath(f.path) === np);
  };

  /** Общая реализация перемещения: обновляет и «диск» (contents), и «индекс» (allFiles). */
  const movePaths = (from: string, to: string) => {
    const npFrom = normalizePath(from);
    const npTo = normalizePath(to);
    const content = contents.get(npFrom) ?? "";
    contents.delete(npFrom);
    const i = indexOfPath(npFrom);
    if (i >= 0) {
      allFiles.splice(i, 1);
      const name = npTo.split("/").pop() ?? npTo;
      allFiles.push(new (TFile as any)(name, npTo, { size: content.length }));
    }
    contents.set(npTo, content);
  };

  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => {
        const np = normalizePath(p);
        return folders.get(np) ?? allFiles.find((f) => normalizePath(f.path) === np) ?? null;
      },
      getFiles: () => allFiles,
      getMarkdownFiles: () => allFiles.filter((f) => f.name.endsWith(".md")),
      read: async (f: TFile) => contents.get(normalizePath(f.path)) ?? "",
      cachedRead: async (f: TFile) => contents.get(normalizePath(f.path)) ?? "",
      rename: vi.fn(async (f: any, dest: string) => { movePaths(f.path, dest); }),
      delete: vi.fn(async (f: any) => {
        contents.delete(normalizePath(f.path));
        const i = indexOfPath(f.path);
        if (i >= 0) allFiles.splice(i, 1);
      }),
      adapter: {
        // Obsidian бросает "Folder already exists." БЕЗ code === EEXIST —
        // именно это раньше роняло cleanup до перемещения файлов.
        mkdir: vi.fn(async () => { throw new Error("Folder already exists."); }),
        exists: vi.fn(async (p: string) => folders.has(normalizePath(p)) || contents.has(normalizePath(p))),
        rename: vi.fn(async (from: string, to: string) => { movePaths(from, to); }),
        readBinary: vi.fn(async (p: string) =>
          new TextEncoder().encode(contents.get(normalizePath(p)) ?? "").buffer
        ),
        writeBinary: vi.fn(async (p: string, data: ArrayBuffer) => {
          contents.set(normalizePath(p), new TextDecoder().decode(data));
        }),
      },
    },
    metadataCache: {
      getFileCache: (f: TFile) => ({
        embeds: embedsCache.get(normalizePath(f.path)) ?? [],
        links: linksCache.get(normalizePath(f.path)) ?? [],
      }),
    },
  };

  return { app, allFiles, contents, folders };
}

describe("cmdCleanup dummy PDF protection", () => {
  it("does not treat referenced dummy PDFs as orphans (dry run)", async () => {
    const { app } = makeCleanupApp([
      { name: "note.md", content: "![[Файлы/dummy.pdf]]", folder: "" },
      {
        name: "dummy.pdf",
        content: "https://s3.example/bucket/docs/abc.pdf\n",
        folder: "Файлы",
      },
      {
        name: "orphan.pdf",
        content: "https://s3.example/bucket/docs/orphan.pdf\n",
        folder: "Файлы",
      },
    ]);

    const result = await (cmdCleanup as any)(app, TEST_SETTINGS, { processed: {}, failedExternal: {} }, true);
    expect(result.orphans).toBe(1); // only orphan.pdf
  });

  it("protects dummy PDF referenced by plain wiki-link [[dummy.pdf]]", async () => {
    const { app } = makeCleanupApp([
      { name: "note.md", content: "См. [[Файлы/dummy.pdf]]", folder: "" },
      {
        name: "dummy.pdf",
        content: "https://s3.example/bucket/docs/abc.pdf\n",
        folder: "Файлы",
      },
      {
        name: "orphan.pdf",
        content: "https://s3.example/bucket/docs/orphan.pdf\n",
        folder: "Файлы",
      },
    ]);

    const result = await (cmdCleanup as any)(app, TEST_SETTINGS, { processed: {}, failedExternal: {} }, true);
    expect(result.orphans).toBe(1);
  });

  it("scans pdfDummyFolder even when it is not listed in attachmentFolders", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      attachmentFolders: ["Картинки"],
      pdfDummyFolder: "Dummies",
    };

    const { app } = makeCleanupApp([
      { name: "note.md", content: "![[Dummies/dummy.pdf]]", folder: "" },
      {
        name: "dummy.pdf",
        content: "https://s3.example/bucket/docs/abc.pdf\n",
        folder: "Dummies",
      },
      {
        name: "orphan.pdf",
        content: "https://s3.example/bucket/docs/orphan.pdf\n",
        folder: "Dummies",
      },
    ]);

    const result = await (cmdCleanup as any)(app, settings, { processed: {}, failedExternal: {} }, true);
    expect(result.orphans).toBe(1);
  });
});

describe("cmdCleanup real move to trash", () => {
  const state = { processed: {}, failedExternal: {} };

  it("moves orphans even when adapter.mkdir throws 'Folder already exists'", async () => {
    const { app, contents } = makeCleanupApp([
      { name: "note.md", content: "в заметке нет ссылок на вложения", folder: "" },
      { name: "cold.jpg", content: "img-bytes", folder: "Файлы" },
    ]);

    // .trash ещё нет в индексе → ensureFolderExists вызовет mkdir, который упадёт
    const res = await (cmdCleanup as any)(app, TEST_SETTINGS, state, false);

    expect(app.vault.adapter.mkdir).toHaveBeenCalled();
    expect(res.moved).toBe(1);
    expect(contents.has(".trash/cold.jpg")).toBe(true);
    expect(contents.has("Файлы/cold.jpg")).toBe(false);
  });

  it("falls back to adapter.rename when vault.rename fails", async () => {
    const { app, contents } = makeCleanupApp([
      { name: "note.md", content: "в заметке нет ссылок на вложения", folder: "" },
      { name: "cold.jpg", content: "img-bytes", folder: "Файлы" },
    ]);
    app.vault.rename.mockRejectedValue(new Error("Folder does not exist"));

    const res = await (cmdCleanup as any)(app, TEST_SETTINGS, state, false);

    expect(res.moved).toBe(1);
    expect(app.vault.adapter.rename).toHaveBeenCalledWith("Файлы/cold.jpg", ".trash/cold.jpg");
    expect(contents.get(".trash/cold.jpg")).toBe("img-bytes");
    expect(contents.has("Файлы/cold.jpg")).toBe(false);
  });

  it("does not overwrite a file that already sits in trash", async () => {
    const { app, contents } = makeCleanupApp([
      { name: "note.md", content: "в заметке нет ссылок на вложения", folder: "" },
      { name: "cold.jpg", content: "img-bytes", folder: "Файлы" },
      { name: "cold.jpg", content: "old-trash-copy", folder: ".trash" },
    ]);

    const res = await (cmdCleanup as any)(app, TEST_SETTINGS, state, false);

    expect(res.moved).toBe(1);
    expect(app.vault.rename).toHaveBeenCalledWith(expect.anything(), ".trash/cold 2.jpg");
    expect(contents.get(".trash/cold.jpg")).toBe("old-trash-copy");
    expect(contents.get(".trash/cold 2.jpg")).toBe("img-bytes");
  });

  it("reports files it could not move instead of failing silently", async () => {
    const { app, contents } = makeCleanupApp([
      { name: "note.md", content: "в заметке нет ссылок на вложения", folder: "" },
      { name: "cold.jpg", content: "img-bytes", folder: "Файлы" },
    ]);
    app.vault.rename.mockRejectedValue(new Error("nope"));
    app.vault.adapter.rename.mockRejectedValue(new Error("nope"));
    app.vault.adapter.writeBinary.mockRejectedValue(new Error("nope"));

    const res = await (cmdCleanup as any)(app, TEST_SETTINGS, state, false);

    expect(res.moved).toBe(0);
    expect(contents.has("Файлы/cold.jpg")).toBe(true); // файл не потерян
  });
});

describe("cmdCleanup URL-encoded references", () => {
  it("protects a file referenced only by an encoded markdown link", async () => {
    const { app } = makeCleanupApp([
      { name: "note.md", content: "![](Файлы/cold%20one.jpg)", folder: "" },
      { name: "cold one.jpg", content: "img-bytes", folder: "Файлы" },
    ]);

    const res = await (cmdCleanup as any)(
      app,
      TEST_SETTINGS,
      { processed: {}, failedExternal: {} },
      true
    );

    // Ссылка в заметке URL-кодированная: без декодирования этот файл
    // считался бы сиротой и уехал бы в .trash при живой ссылке.
    expect(res.orphans).toBe(0);
  });
});

describe("cmdCleanup with nothing to move", () => {
  it("does not ask for confirmation when there are no orphans", async () => {
    const { app } = makeCleanupApp([
      { name: "note.md", content: "![](Файлы/used.jpg)", folder: "" },
      { name: "used.jpg", content: "img-bytes", folder: "Файлы" },
    ]);

    const res = await (cmdCleanup as any)(
      app,
      TEST_SETTINGS,
      { processed: {}, failedExternal: {} },
      false
    );

    expect(res.orphans).toBe(0);
    expect(res.moved).toBe(0);
    // Ни подтверждения, ни подготовки папки, ни перемещений.
    expect(app.vault.adapter.mkdir).not.toHaveBeenCalled();
    expect(app.vault.rename).not.toHaveBeenCalled();
  });
});
