import { App, TFile, normalizePath } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { processMdFile } from "../../src/engine/sync";
import { md5Buffer } from "../../src/engine/md5";
import { publicUrl } from "../../src/s3Client";
import { DEFAULT_SETTINGS } from "../../src/settings";

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

function makeApp(fileName: string, fileContent: string, noteContent: string) {
  const filePath = `Картинки/${fileName}`;
  const notePath = "note.md";
  const localFile = new TFile(fileName, normalizePath(filePath), { size: fileContent.length });
  const mdFile = new TFile("note.md", normalizePath(notePath), { size: 0 });

  const files = new Map<string, { content: string; file: TFile }>();
  files.set(normalizePath(filePath), { content: fileContent, file: localFile });
  files.set(normalizePath(notePath), { content: noteContent, file: mdFile });

  const app = {
    vault: {
      getName: () => "test-vault",
      getAbstractFileByPath: (p: string) => {
        return files.get(normalizePath(p))?.file ?? null;
      },
      getFiles: () => Array.from(files.values()).map((e) => e.file),
      readBinary: async (f: TFile) => {
        const entry = files.get(normalizePath(f.path));
        if (!entry) throw new Error(`File not found: ${f.path}`);
        return new TextEncoder().encode(entry.content).buffer;
      },
      read: async (f: TFile) => files.get(normalizePath(f.path))?.content ?? "",
      cachedRead: async (f: TFile) => files.get(normalizePath(f.path))?.content ?? "",
      modify: vi.fn(async (f: TFile, content: string) => {
        files.set(normalizePath(f.path), { content, file: f });
      }),
      create: vi.fn(async (path: string, content: string) => {
        const normalizedPath = normalizePath(path);
        const name = normalizedPath.split("/").pop() ?? normalizedPath;
        const file = new TFile(name, normalizedPath, { size: content.length });
        files.set(normalizedPath, { content, file });
        return file;
      }),
      delete: vi.fn(async (f: TFile) => {
        files.delete(normalizePath(f.path));
      }),
    },
  };
  return { app, mdFile, localFile };
}

function makeAppWithFiles(
  filesData: { name: string; content: string; folder?: string }[],
  noteContent: string
) {
  const notePath = normalizePath("note.md");
  const mdFile = new TFile("note.md", notePath, { size: 0 });
  const files = new Map<string, { content: string; file: TFile }>();
  files.set(notePath, { content: noteContent, file: mdFile });

  for (const f of filesData) {
    const folder = f.folder ?? "Картинки";
    const path = normalizePath(`${folder}/${f.name}`);
    const file = new TFile(f.name, path, { size: f.content.length });
    files.set(path, { content: f.content, file });
  }

  const app = {
    vault: {
      getName: () => "test-vault",
      getAbstractFileByPath: (p: string) => files.get(normalizePath(p))?.file ?? null,
      getFiles: () => Array.from(files.values()).map((e) => e.file),
      readBinary: async (f: TFile) => {
        const entry = files.get(normalizePath(f.path));
        if (!entry) throw new Error(`File not found: ${f.path}`);
        return new TextEncoder().encode(entry.content).buffer;
      },
      read: async (f: TFile) => files.get(normalizePath(f.path))?.content ?? "",
      cachedRead: async (f: TFile) => files.get(normalizePath(f.path))?.content ?? "",
      modify: vi.fn(async (f: TFile, content: string) => {
        files.set(normalizePath(f.path), { content, file: f });
      }),
      create: vi.fn(async (path: string, content: string) => {
        const normalizedPath = normalizePath(path);
        const name = normalizedPath.split("/").pop() ?? normalizedPath;
        const file = new TFile(name, normalizedPath, { size: content.length });
        files.set(normalizedPath, { content, file });
        return file;
      }),
      delete: vi.fn(async (f: TFile) => {
        files.delete(normalizePath(f.path));
      }),
    },
  };
  return { app, mdFile, files };
}

function makeClient(headResponse: object | null = null) {
  return {
    send: vi.fn(async (cmd: any) => {
      if (cmd instanceof HeadObjectCommand) return headResponse;
      return {};
    }),
  };
}

function makeState() {
  return { processed: {}, failedExternal: {} };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function expectedUrl(fileContent: string, ext: string): string {
  const hash = md5Buffer(new TextEncoder().encode(fileContent).buffer);
  const key = `media/${hash}${ext}`;
  return publicUrl(DEFAULT_SETTINGS.s3, key);
}

function expectedPdfUrl(content: string): string {
  const hash = md5Buffer(new TextEncoder().encode(content).buffer);
  const key = `docs/${hash}.pdf`;
  return publicUrl(DEFAULT_SETTINGS.s3, key);
}

describe("processMdFile embed formats", () => {
  const fileName = "photo.jpg";
  const fileContent = "binary-image-stub";

  it("replaces markdown image embed ![alt](path)", async () => {
    const { app, mdFile, localFile } = makeApp(
      fileName,
      fileContent,
      `![alt](Картинки/${fileName})`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(1);
    const newContent = app.vault.modify.mock.calls[0][1];
    expect(newContent).toBe(`![|550](${expectedUrl(fileContent, ".jpg")})`);
    expect(app.vault.delete).toHaveBeenCalledWith(localFile);

    const commands = client.send.mock.calls.map((c: any) => c[0]);
    expect(commands.some((c: any) => c instanceof HeadObjectCommand)).toBe(true);
    expect(commands.some((c: any) => c instanceof PutObjectCommand)).toBe(true);
  });

  it("replaces wiki embed ![[path]]", async () => {
    const { app, mdFile, localFile } = makeApp(
      fileName,
      fileContent,
      `![[Картинки/${fileName}]]`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(1);
    const newContent = app.vault.modify.mock.calls[0][1];
    expect(newContent).toBe(`![|550](${expectedUrl(fileContent, ".jpg")})`);
    expect(app.vault.delete).toHaveBeenCalledWith(localFile);
  });

  it("preserves wiki embed width ![[path|750]]", async () => {
    const { app, mdFile, localFile } = makeApp(
      fileName,
      fileContent,
      `![[Картинки/${fileName}|750]]`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(1);
    const newContent = app.vault.modify.mock.calls[0][1];
    expect(newContent).toBe(`![|750](${expectedUrl(fileContent, ".jpg")})`);
    expect(app.vault.delete).toHaveBeenCalledWith(localFile);
  });

  it("extracts width from wiki embed dimensions ![[path|300x200]]", async () => {
    const { app, mdFile, localFile } = makeApp(
      fileName,
      fileContent,
      `![[Картинки/${fileName}|300x200]]`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(1);
    const newContent = app.vault.modify.mock.calls[0][1];
    expect(newContent).toBe(`![|300](${expectedUrl(fileContent, ".jpg")})`);
    expect(app.vault.delete).toHaveBeenCalledWith(localFile);
  });
});

describe("processMdFile S3 deduplication", () => {
  const fileName = "photo.jpg";
  const fileContent = "duplicate-content";

  it("skips PutObject when identical object already exists in S3", async () => {
    const { app, mdFile, localFile } = makeApp(
      fileName,
      fileContent,
      `![[Картинки/${fileName}]]`
    );
    const hash = md5Buffer(new TextEncoder().encode(fileContent).buffer);
    const client = makeClient({
      ContentLength: fileContent.length,
      ETag: `"${hash}"`,
    });

    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(1);
    expect(app.vault.modify).toHaveBeenCalled();
    expect(app.vault.delete).toHaveBeenCalledWith(localFile);

    const commands = client.send.mock.calls.map((c: any) => c[0]);
    expect(commands.filter((c: any) => c instanceof HeadObjectCommand)).toHaveLength(1);
    expect(commands.some((c: any) => c instanceof PutObjectCommand)).toBe(false);
  });
});

describe("processMdFile non-embed wiki-link attachments", () => {
  const fileContent = "binary-image-stub";

  it("processes [[Pasted image X.png]] without '!'", async () => {
    const fileName = "Pasted image X.png";
    const { app, mdFile, localFile } = makeApp(
      fileName,
      fileContent,
      `[[Картинки/${fileName}]]`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(1);
    const url = expectedUrl(fileContent, ".png");
    expect(app.vault.modify.mock.calls[0][1]).toBe(`![|550](${url})`);
    expect(app.vault.delete).toHaveBeenCalledWith(localFile);
  });

  it.each([
    ["[[Обычная заметка]]"],
    ["[[Обычная заметка.md]]"],
    ["[[Заметка#Заголовок]]"],
  ])("leaves note link %s unchanged", async (noteLink) => {
    const fileName = "photo.jpg";
    const { app, mdFile, localFile } = makeApp(
      fileName,
      fileContent,
      `${noteLink}\n\nтекст`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(0);
    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(app.vault.delete).not.toHaveBeenCalledWith(localFile);
  });

  it("preserves width alias in [[image.png|750]] without '!'", async () => {
    const fileName = "image.png";
    const { app, mdFile, localFile } = makeApp(
      fileName,
      fileContent,
      `[[Картинки/${fileName}|750]]`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(1);
    const url = expectedUrl(fileContent, ".png");
    expect(app.vault.modify.mock.calls[0][1]).toBe(`![|750](${url})`);
    expect(app.vault.delete).toHaveBeenCalledWith(localFile);
  });
});

function makePdfContent(minBytes = 5120): string {
  // Minimal valid PDF header + catalog + page, padded to minBytes.
  const header =
    "%PDF-1.4\n" +
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n" +
    "4 0 obj\n<< /Length 0 >>\nstream\nendstream\nendobj\n" +
    "xref\n" +
    "0 5\n" +
    "0000000000 65535 f \n" +
    "0000000009 00000 n \n" +
    "0000000058 00000 n \n" +
    "0000000115 00000 n \n" +
    "0000000234 00000 n \n" +
    "trailer\n<< /Size 5 /Root 1 0 R >>\n" +
    "startxref\n300\n" +
    "%%EOF\n";
  if (header.length >= minBytes) return header;
  const padding = "0".repeat(minBytes - header.length);
  return header.replace("%%EOF\n", `%%EOF\n% ${padding}\n`);
}

describe("processMdFile PDF handling", () => {
  const content = "pdf-content-stub";

  it("replaces ![[file.pdf]] with wiki-embed on dummy", async () => {
    const fileName = "document.pdf";
    const { app, mdFile, localFile } = makeApp(
      fileName,
      content,
      `![[Картинки/${fileName}]]`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(1);
    expect(app.vault.delete).toHaveBeenCalledWith(localFile);

    const newContent = app.vault.modify.mock.calls[0][1];
    expect(newContent).toBe("![[document.pdf]]");
    expect(newContent).not.toContain(expectedPdfUrl(content));

    // Dummy created with S3 URL and MD5 hash inside
    expect(app.vault.create).toHaveBeenCalledTimes(1);
    const [dummyPath, dummyContent] = app.vault.create.mock.calls[0];
    expect(dummyPath).toBe("Файлы/document.pdf");
    expect(dummyContent).toContain(expectedPdfUrl(content));
    expect(dummyContent).toContain(md5Buffer(new TextEncoder().encode(content).buffer));
  });

  it("replaces [[file.pdf]] without '!' with wiki-embed on dummy", async () => {
    const fileName = "document.pdf";
    const { app, mdFile, localFile } = makeApp(
      fileName,
      content,
      `[[Картинки/${fileName}]]`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(1);
    expect(app.vault.delete).toHaveBeenCalledWith(localFile);

    const newContent = app.vault.modify.mock.calls[0][1];
    expect(newContent).toBe("![[document.pdf]]");
    expect(newContent).not.toContain(expectedPdfUrl(content));
    expect(newContent).not.toContain("[document](");
    expect(newContent).not.toContain("![document](");

    expect(app.vault.create).toHaveBeenCalledTimes(1);
    const [dummyPath] = app.vault.create.mock.calls[0];
    expect(dummyPath).toBe("Файлы/document.pdf");
  });

  it("reuses one dummy for two different PDF filenames with identical content", async () => {
    const { app, mdFile, files } = makeAppWithFiles(
      [
        { name: "a.pdf", content },
        { name: "b.pdf", content },
      ],
      `![[Картинки/a.pdf]]\n[[Картинки/b.pdf]]`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(2);
    const newContent = app.vault.modify.mock.calls[0][1];
    expect(newContent).toContain("![[a.pdf]]");
    expect(newContent).not.toContain("![[b.pdf]]");
    expect(newContent).not.toContain("[[Картинки/b.pdf]]");

    // Only one dummy file created in S3 dummy folder
    const dummyCreates = app.vault.create.mock.calls.filter((c: any) =>
      normalizePath(c[0]).startsWith("Файлы/")
    );
    expect(dummyCreates).toHaveLength(1);

    // The single dummy references the shared S3 object and hash
    const dummyPath = normalizePath(dummyCreates[0][0]);
    const dummyEntry = files.get(dummyPath);
    expect(dummyEntry).toBeDefined();
    const hash = md5Buffer(new TextEncoder().encode(content).buffer);
    expect(dummyEntry!.content).toContain(`docs/${hash}.pdf`);
    expect(dummyEntry!.content).toContain(hash);
  });

  it("real PDF: drag-and-drop and paste with identical content collapse to one text dummy and are idempotent", async () => {
    const pdfContent = makePdfContent();
    const { app, mdFile, files } = makeAppWithFiles(
      [
        { name: "Pasted image 20260807164958.pdf", content: pdfContent, folder: "Картинки" },
        { name: "Testing_roles (4) 1.pdf", content: pdfContent, folder: "Картинки" },
      ],
      `![[Картинки/Pasted image 20260807164958.pdf]]\n[[Картинки/Testing_roles (4) 1.pdf]]`
    );
    const client = makeClient();
    const state = makeState();
    const logger = makeLogger();

    // First sync run
    const changes1 = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      state,
      mdFile,
      logger
    );
    expect(changes1).toBe(2);
    expect(logger.error).not.toHaveBeenCalled();

    const newContent1 = app.vault.modify.mock.calls[0][1];
    const dummyMatches = newContent1.match(/!\[\[([^\]]+\.pdf)\]\]/g);
    expect(dummyMatches).toHaveLength(2);
    expect(dummyMatches![0]).toBe(dummyMatches![1]);

    // Exactly one dummy created in the dummy folder
    const dummyCreates = app.vault.create.mock.calls.filter((c: any) =>
      normalizePath(c[0]).startsWith("Файлы/")
    );
    expect(dummyCreates).toHaveLength(1);

    const dummyPath = normalizePath(dummyCreates[0][0]);
    const dummyName = dummyPath.split("/").pop()!;
    const dummyEntry = files.get(dummyPath);
    expect(dummyEntry).toBeDefined();
    // Dummy must be a text placeholder, never raw binary PDF
    expect(dummyEntry!.content.startsWith("%PDF-")).toBe(false);
    expect(dummyEntry!.content).toContain("# vault-s3-sync:md5=");
    expect(dummyEntry!.content).toContain(expectedPdfUrl(pdfContent));

    // Second sync run: must be a no-op (idempotent)
    const changes2 = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      state,
      mdFile,
      logger
    );
    expect(changes2).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();

    // Note content unchanged
    expect(app.vault.modify).toHaveBeenCalledTimes(1);

    // Dummy file not recreated or modified
    expect(app.vault.create.mock.calls.filter((c: any) =>
      normalizePath(c[0]).startsWith("Файлы/")
    )).toHaveLength(1);

    // Original PDFs were deleted; only the dummy and the note remain
    const remainingPdfNames = Array.from(files.values())
      .map((e) => e.file.name)
      .filter((n) => n.endsWith(".pdf"));
    expect(remainingPdfNames).toHaveLength(1);
    expect(remainingPdfNames[0]).toBe(dummyName);
  });

  it("does not overwrite an existing real PDF in dummy folder when names collide", async () => {
    const pdfContent = makePdfContent();
    const otherPdfContent = makePdfContent(5200);
    const { app, mdFile, files } = makeAppWithFiles(
      [
        // Original attachment in attachment folder
        { name: "Testing_roles (4).pdf", content: pdfContent, folder: "Картинки" },
        // Pre-existing real PDF in dummy folder with the SAME name but different content
        { name: "Testing_roles (4).pdf", content: otherPdfContent, folder: "Файлы" },
      ],
      `[[Картинки/Testing_roles (4).pdf]]`
    );
    const client = makeClient();
    const changes = await (processMdFile as any)(
      app,
      DEFAULT_SETTINGS,
      client,
      makeState(),
      mdFile,
      makeLogger()
    );

    expect(changes).toBe(1);

    // Existing real PDF in dummy folder must remain untouched
    const existingEntry = files.get("Файлы/Testing_roles (4).pdf");
    expect(existingEntry).toBeDefined();
    expect(existingEntry!.content).toBe(otherPdfContent);

    // A new dummy must be created with a disambiguated name
    const dummyCreates = app.vault.create.mock.calls.filter((c: any) =>
      normalizePath(c[0]).startsWith("Файлы/")
    );
    expect(dummyCreates).toHaveLength(1);
    const createdPath = normalizePath(dummyCreates[0][0]);
    expect(createdPath).not.toBe("Файлы/Testing_roles (4).pdf");
    expect(createdPath).toMatch(/Testing_roles \(4\)-\d+\.pdf$/);

    const newContent = app.vault.modify.mock.calls[0][1];
    expect(newContent).toBe(`![[${createdPath.split("/").pop()}]]`);
  });
});
