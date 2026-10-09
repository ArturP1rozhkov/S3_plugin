import { describe, expect, it, vi } from "vitest";
import { ensurePdfDummy, isDummyPdf } from "../../src/engine/pdfDummy";

vi.mock("obsidian", () => {
  class App {}
  class TAbstractFile {}
  class TFile extends TAbstractFile {}
  class TFolder extends TAbstractFile {}
  function normalizePath(p: string) { return p.replace(/\\/g, "/"); }
  return { App, TAbstractFile, TFile, TFolder, normalizePath };
});

const pdfUrl = "http://127.0.0.1:9000/obsidian-plugin-test/docs/c62ec98d095431469103e7318dd9df8a.pdf";
const httpsPdfUrl = "https://s3.example/bucket/docs/report.pdf";

describe("ensurePdfDummy", () => {
  function makeApp() {
    const createdFolders: string[] = [];
    const createdFiles: string[] = [];
    const app: any = {
      vault: {
        adapter: {
          exists: async (p: string) => createdFolders.includes(p),
          mkdir: async (p: string) => { createdFolders.push(p); },
        },
        createFolder: async (p: string) => { createdFolders.push(p); },
        getFiles: () => [],
        getAbstractFileByPath: () => null,
        create: async (p: string) => { createdFiles.push(p); return {}; },
        read: async () => "",
        modify: async () => {},
      },
    };
    return { app, createdFolders, createdFiles };
  }

  it("creates the dummy folder when it is missing in the vault", async () => {
    const { app, createdFolders, createdFiles } = makeApp();
    const settings: any = { pdfDummyFolder: "Объекты из бакета" };

    const name = await ensurePdfDummy(app, settings, "doc.pdf", "a".repeat(32), httpsPdfUrl);

    // Папка была переименована/удалена — плагин создаёт её сам, вместо ENOENT.
    expect(createdFolders).toContain("Объекты из бакета");
    expect(createdFiles).toEqual(["Объекты из бакета/doc.pdf"]);
    expect(name).toBe("doc.pdf");
  });

  it("does not touch an existing folder", async () => {
    const { app, createdFolders } = makeApp();
    app.vault.adapter.exists = async () => true;
    const settings: any = { pdfDummyFolder: "Объекты из бакета" };

    await ensurePdfDummy(app, settings, "doc.pdf", "a".repeat(32), httpsPdfUrl);

    expect(createdFolders).toEqual([]);
  });
});

describe("isDummyPdf", () => {
  it("recognizes bare URL: file.pdf", () => {
    expect(isDummyPdf(`${pdfUrl}\n`, pdfUrl.length + 1)).toBe(true);
  });

  it("recognizes bare URL: file.pdf?download=1", () => {
    const url = `${pdfUrl}?download=1`;
    expect(isDummyPdf(`${url}\n`, url.length + 1)).toBe(true);
  });

  it("recognizes bare URL: file.pdf#page=3", () => {
    const url = `${pdfUrl}#page=3`;
    expect(isDummyPdf(`${url}\n`, url.length + 1)).toBe(true);
  });

  it("recognizes bare URL: file.pdf?download=1#page=3", () => {
    const url = `${pdfUrl}?download=1#page=3`;
    expect(isDummyPdf(`${url}\n`, url.length + 1)).toBe(true);
  });

  it("recognizes legacy Markdown link with fragment", () => {
    const url = `${pdfUrl}#page=5`;
    const content = `[${url}](${url})`;
    expect(isDummyPdf(content, content.length)).toBe(true);
  });

  it("recognizes legacy Markdown link with query and fragment", () => {
    const url = `${pdfUrl}?download=1#page=7`;
    const content = `[${url}](${url})`;
    expect(isDummyPdf(content, content.length)).toBe(true);
  });

  it("rejects real PDF binary header", () => {
    const realPdf = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
    expect(isDummyPdf(realPdf, 1024)).toBe(false);
  });

  it("rejects arbitrary text containing .pdf substring", () => {
    expect(isDummyPdf("hello world.pdf and other text", 100)).toBe(false);
  });

  it("rejects empty content", () => {
    expect(isDummyPdf("", 0)).toBe(false);
  });

  it("rejects whitespace-only content", () => {
    expect(isDummyPdf("   \n\t  ", 10)).toBe(false);
  });

  it("rejects URL that does not point to .pdf", () => {
    expect(isDummyPdf("http://example.com/docs/report.txt", 100)).toBe(false);
  });

  it("rejects large files even if content looks like dummy", () => {
    expect(isDummyPdf(`${pdfUrl}\n`, 5000)).toBe(false);
  });

  it("rejects Markdown link to non-PDF URL", () => {
    const content = "[http://example.com/file.txt](http://example.com/file.txt)";
    expect(isDummyPdf(content, content.length)).toBe(false);
  });
});
