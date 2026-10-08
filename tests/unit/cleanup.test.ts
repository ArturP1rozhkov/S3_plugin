import { App, TFile, TFolder, normalizePath } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { cmdCleanup } from "../../src/engine/cleanup";
import { DEFAULT_SETTINGS } from "../../src/settings";

vi.mock("obsidian", () => ({
  App: class {},
  Modal: class {
    contentEl: any;
    titleEl: any;
    constructor(public app: any) {
      this.contentEl = {
        empty: vi.fn(),
        addClass: vi.fn(),
        setText: vi.fn(),
        createEl: vi.fn(() => ({
          setText: vi.fn(),
          addEventListener: vi.fn(),
        })),
        createDiv: vi.fn(() => ({
          createEl: vi.fn(() => ({
            setText: vi.fn(),
            addEventListener: vi.fn(),
          })),
        })),
      };
      this.titleEl = { setText: vi.fn() };
    }
    open() {}
    close() {}
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
}));

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
    ensureFolder(folder);
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
      rename: vi.fn(),
      adapter: { mkdir: vi.fn() },
    },
    metadataCache: {
      getFileCache: (f: TFile) => ({
        embeds: embedsCache.get(normalizePath(f.path)) ?? [],
        links: linksCache.get(normalizePath(f.path)) ?? [],
      }),
    },
  };

  return { app, allFiles };
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

    const result = await (cmdCleanup as any)(app, DEFAULT_SETTINGS, { processed: {}, failedExternal: {} }, true);
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

    const result = await (cmdCleanup as any)(app, DEFAULT_SETTINGS, { processed: {}, failedExternal: {} }, true);
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
