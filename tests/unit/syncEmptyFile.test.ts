import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { processMdFile } from "../../src/engine/sync";
import type { VaultS3Settings } from "../../src/settings";

vi.mock("obsidian", () => ({
  App: class {},
  Modal: class {},
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
  TFolder: class {},
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
}));

const DEFAULT_SETTINGS: VaultS3Settings = {
  s3: {
    endpoint: "http://127.0.0.1:9000",
    publicEndpoint: "http://127.0.0.1:9000",
    bucket: "test-bucket",
    accessKey: "test-key",
    secretKey: "test-secret",
    region: "us-east-1",
    quarantineFolder: "quarantine",
    quarantineRetentionDays: 14,
    folderMap: {},
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
  downloadExternalImages: false,
  externalImageTimeoutSec: 10,
  maxExternalAttempts: 3,
};

function makeApp(fileName: string, size: number, noteContent: string) {
  const filePath = `Картинки/${fileName}`;
  const notePath = "note.md";
  const localFile = new TFile(fileName, filePath, { size });
  const mdFile = new TFile("note.md", notePath, { size: 0 });

  const app = {
    vault: {
      getName: () => "test-vault",
      getAbstractFileByPath: (p: string) => {
        if (p === filePath) return localFile;
        if (p === notePath) return mdFile;
        return null;
      },
      getFiles: () => [localFile, mdFile],
      readBinary: async (file: any) => new ArrayBuffer(size),
      read: async (file: any) => noteContent,
      cachedRead: async (file: any) => noteContent,
      modify: vi.fn(),
      delete: vi.fn(),
    },
  };
  return { app, mdFile, localFile };
}

const client = {
  send: vi.fn().mockResolvedValue({}),
};

function makeState() {
  return { processed: {}, failedExternal: {} };
}

function makeLogger() {
  const warnMessages: string[] = [];
  const errorMessages: string[] = [];
  return {
    info: vi.fn(),
    warn: (m: string) => warnMessages.push(m),
    error: (m: string) => errorMessages.push(m),
    getWarnings: () => warnMessages,
    getErrors: () => errorMessages,
  };
}

describe("processMdFile empty-file handling", () => {
  it("increments empty-file counter without replacing or deleting", async () => {
    const fileName = "photo_0byte.jpg";
    const { app, mdFile, localFile } = await makeApp(fileName, 0, `![[${fileName}]]`);
    const logger = makeLogger();
    const emptyEntries: { fileName: string; notePath: string }[] = [];

    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      logger,
      (fileName: string, notePath: string) => emptyEntries.push({ fileName, notePath })
    );

    expect(changes).toBe(0);
    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(app.vault.delete).not.toHaveBeenCalled();
    expect(emptyEntries).toHaveLength(1);
    expect(emptyEntries[0]).toEqual({ fileName, notePath: "note.md" });
    expect(logger.getWarnings()[0]).toContain("Skipped empty file: " + fileName);
    expect(logger.getWarnings()[0]).toContain("note.md");
  });
});
