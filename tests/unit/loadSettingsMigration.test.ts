import { describe, expect, it, vi } from "vitest";
import { migrateSettings } from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";

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

describe("migrateSettings", () => {
  it("clean install defaults to path style", () => {
    const migrated = migrateSettings(null);
    expect(migrated.s3.publicUrlStyle).toBe("path");
  });

  it("old saved S3 config without publicUrlStyle migrates to virtual-host", () => {
    const oldData = {
      s3: {
        endpoint: "http://127.0.0.1:9000",
        publicEndpoint: "http://127.0.0.1:9000",
        bucket: "obsidian-plugin-test",
        accessKey: "ak",
        secretKey: "sk",
        region: "us-east-1",
      },
    };
    const migrated = migrateSettings(oldData);
    expect(migrated.s3.publicUrlStyle).toBe("virtual-host");
  });

  it("explicit saved path style is preserved", () => {
    const data = { s3: { publicUrlStyle: "path" as const, bucket: "b" } };
    const migrated = migrateSettings(data);
    expect(migrated.s3.publicUrlStyle).toBe("path");
  });

  it("explicit saved virtual-host style is preserved", () => {
    const data = { s3: { publicUrlStyle: "virtual-host" as const, bucket: "b" } };
    const migrated = migrateSettings(data);
    expect(migrated.s3.publicUrlStyle).toBe("virtual-host");
  });

  it("deeply merges saved s3 fields and fills missing defaults", () => {
    const data = {
      s3: {
        bucket: "mybucket",
        accessKey: "ak",
        secretKey: "sk",
      },
    };
    const migrated = migrateSettings(data);
    expect(migrated.s3.bucket).toBe("mybucket");
    expect(migrated.s3.accessKey).toBe("ak");
    expect(migrated.s3.publicUrlStyle).toBe("virtual-host");
    // Default fields that were missing are filled in
    expect(migrated.s3.endpoint).toBe(DEFAULT_SETTINGS.s3.endpoint);
    expect(migrated.s3.imageWidth).toBe(DEFAULT_SETTINGS.s3.imageWidth);
    expect(migrated.s3.hashFilenames).toBe(DEFAULT_SETTINGS.s3.hashFilenames);
  });

  it("migrates old default trash folder to Obsidian .trash", () => {
    const data = { trashFolder: ".trash_attachments" };
    const migrated = migrateSettings(data);
    expect(migrated.trashFolder).toBe(DEFAULT_SETTINGS.trashFolder);
    expect(migrated.trashFolder).toBe(".trash");
  });

  it("preserves custom trash folder", () => {
    const data = { trashFolder: "my_custom_trash" };
    const migrated = migrateSettings(data);
    expect(migrated.trashFolder).toBe("my_custom_trash");
  });
});
