import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class App {}
  class Modal {}
  class Notice {}
  class Plugin {}
  class PluginSettingTab {}
  class Setting {
    setName() { return this; }
    setDesc() { return this; }
    addText() { return this; }
    addDropdown() { return this; }
    addTextArea() { return this; }
    addToggle() { return this; }
  }
  class TAbstractFile {}
  class TFile extends TAbstractFile {}
  class TFolder extends TAbstractFile {}
  function normalizePath(p: string) { return p.replace(/\\/g, "/"); }
  return { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, normalizePath };
});

import { DEFAULT_SETTINGS, restoreFolderState, type VaultS3Settings } from "../../src/settings";
import {
  allocateTarget,
  keyFromS3Url,
  nameFromState,
  originalNameFromMetadata,
  sanitizeFilename,
} from "../../src/engine/restoreNote";

function settingsWith(overrides: Partial<VaultS3Settings> = {}): VaultS3Settings {
  const s3 = {
    ...DEFAULT_SETTINGS.s3,
    endpoint: "https://s3.cloud.ru",
    publicEndpoint: "https://my-bucket.s3.cloud.ru",
    bucket: "my-bucket",
    publicUrlStyle: "virtual-host" as const,
  };
  return {
    ...DEFAULT_SETTINGS,
    s3,
    attachmentFolders: ["Картинки", "Файлы"],
    pdfDummyFolder: "PDF",
    ...overrides,
  };
}

describe("keyFromS3Url", () => {
  it("virtual-host: prefix is publicEndpoint itself", () => {
    const cfg = settingsWith().s3;
    expect(keyFromS3Url("https://my-bucket.s3.cloud.ru/media/abc.jpg", cfg)).toBe("media/abc.jpg");
  });

  it("path style: prefix includes the bucket", () => {
    const cfg = { ...settingsWith().s3, publicEndpoint: "http://127.0.0.1:9000", publicUrlStyle: "path" as const };
    expect(keyFromS3Url("http://127.0.0.1:9000/my-bucket/docs/a.pdf", cfg)).toBe("docs/a.pdf");
  });

  it("falls back to endpoint/bucket when publicEndpoint is empty", () => {
    const cfg = {
      ...settingsWith().s3,
      publicEndpoint: "",
      endpoint: "https://s3.cloud.ru",
      publicUrlStyle: "path" as const,
    };
    expect(keyFromS3Url("https://s3.cloud.ru/my-bucket/files/x.zip", cfg)).toBe("files/x.zip");
  });

  it("decodes percent-encoded keys and strips query/anchor", () => {
    const cfg = settingsWith().s3;
    expect(keyFromS3Url("https://my-bucket.s3.cloud.ru/media/%D1%84%D0%B0%D0%B9%D0%BB.jpg?x=1", cfg))
      .toBe("media/файл.jpg");
  });

  it("returns null for foreign and relative refs", () => {
    const cfg = settingsWith().s3;
    expect(keyFromS3Url("https://example.com/media/a.jpg", cfg)).toBeNull();
    expect(keyFromS3Url("Картинки/a.jpg", cfg)).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it("replaces characters forbidden on Windows", () => {
    // Слэш считается разделителем пути, поэтому в имени его быть не должно.
    expect(sanitizeFilename('a:b*c?d"e<f>g|h\\i.jpg')).toBe("a-b-c-d-e-f-g-h-i.jpg");
  });

  it("keeps the last path segment only", () => {
    expect(sanitizeFilename("media/photo 1.png")).toBe("photo 1.png");
  });

  it("trims trailing dots and spaces", () => {
    expect(sanitizeFilename("name.  ")).toBe("name");
  });

  it("falls back for empty or dot-only names", () => {
    expect(sanitizeFilename("", "fallback.jpg")).toBe("fallback.jpg");
    expect(sanitizeFilename("..", "fallback.jpg")).toBe("fallback.jpg");
  });

  it("keeps the extension when cutting a long name", () => {
    const long = `${"a".repeat(300)}.mp4`;
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(150);
    expect(result.endsWith(".mp4")).toBe(true);
  });
});

describe("originalNameFromMetadata", () => {
  it("decodes URL-encoded original name", () => {
    expect(originalNameFromMetadata({ "original-name": encodeURIComponent("Снимок экрана.png") }, "x.png"))
      .toBe("Снимок экрана.png");
  });

  it("tolerates plain text values", () => {
    expect(originalNameFromMetadata({ "original-name": "simple name.png" }, "x.png")).toBe("simple name.png");
  });

  it("falls back to the key name when metadata is missing", () => {
    expect(originalNameFromMetadata(undefined, "media/abc123.jpg")).toBe("abc123.jpg");
    expect(originalNameFromMetadata({}, "media/abc123.jpg")).toBe("abc123.jpg");
  });
});

describe("restoreFolderState", () => {
  it("ok for an unrelated folder", () => {
    expect(restoreFolderState("Restore", settingsWith())).toBe("ok");
  });

  it("inside-plugin for a folder nested into an attachment folder", () => {
    expect(restoreFolderState("Картинки/Restore", settingsWith())).toBe("inside-plugin");
    expect(restoreFolderState("Файлы", settingsWith())).toBe("inside-plugin");
  });

  it("contains-plugin when an attachment folder lives inside", () => {
    const settings = settingsWith({ attachmentFolders: ["Restore/Картинки", "Файлы"] });
    expect(restoreFolderState("Restore", settings)).toBe("contains-plugin");
  });

  it("blocked for the PDF dummy folder and its subfolders", () => {
    expect(restoreFolderState("PDF", settingsWith())).toBe("blocked");
    expect(restoreFolderState("PDF/restored", settingsWith())).toBe("blocked");
  });

  it("blocked for system folders", () => {
    expect(restoreFolderState(".obsidian", settingsWith())).toBe("blocked");
    expect(restoreFolderState(".trash", settingsWith())).toBe("blocked");
  });

  it("root for an empty path", () => {
    expect(restoreFolderState("/", settingsWith())).toBe("root");
    expect(restoreFolderState("", settingsWith())).toBe("root");
  });
});

describe("nameFromState", () => {
  it("maps an object key back to the vault file name", () => {
    const cfg = settingsWith().s3;
    const state: any = {
      processed: {
        "Картинки/книга.jpg": {
          hash: "x",
          s3url: "https://my-bucket.s3.cloud.ru/media/abc123.jpg",
          processedAt: "",
        },
      },
    };
    expect(nameFromState(state, cfg).get("media/abc123.jpg")).toBe("книга.jpg");
  });

  it("ignores entries from other storages", () => {
    const cfg = settingsWith().s3;
    const state: any = {
      processed: {
        "a.jpg": { hash: "x", s3url: "https://other.s3.cloud.ru/media/abc.jpg", processedAt: "" },
      },
    };
    expect(nameFromState(state, cfg).size).toBe(0);
  });
});

describe("allocateTarget", () => {
  const none = () => null;

  it("uses the plain name when free", () => {
    expect(allocateTarget("Restore", "doc.pdf", 10, none)).toEqual({ path: "Restore/doc.pdf", skip: false });
  });

  it("adds a numeric suffix when the name is taken by a different size", () => {
    const taken = (path: string) => (path === "Restore/doc.pdf" ? { size: 99 } : null);
    expect(allocateTarget("Restore", "doc.pdf", 10, taken)).toEqual({ path: "Restore/doc 2.pdf", skip: false });
  });

  it("skips when the same name has the same size", () => {
    const same = (path: string) => (path === "Restore/doc.pdf" ? { size: 10 } : null);
    expect(allocateTarget("Restore", "doc.pdf", 10, same)).toEqual({ path: "Restore/doc.pdf", skip: true });
  });

  it("keeps the extension when a file has no extension", () => {
    const taken = (path: string) => (path === "Restore/README" ? { size: 1 } : null);
    expect(allocateTarget("Restore", "README", 2, taken)).toEqual({ path: "Restore/README 2", skip: false });
  });
});
