import { describe, expect, it } from "vitest";
import { publicUrl, serverSideEncryption } from "../../src/s3Client";
import type { S3Config } from "../../src/settings";

const baseCfg: S3Config = {
  endpoint: "http://127.0.0.1:9000",
  publicEndpoint: "http://127.0.0.1:9000",
  bucket: "obsidian-plugin-test",
  accessKey: "",
  secretKey: "",
  region: "us-east-1",
  quarantineFolder: "quarantine",
  quarantineRetentionDays: 14,
  folderMap: {},
  imageWidth: 550,
  imageMaxPx: 1920,
  hashFilenames: true,
  publicUrlStyle: "path",
  encryption: "none",
};

describe("serverSideEncryption", () => {
  it("returns undefined when encryption is off", () => {
    expect(serverSideEncryption(baseCfg)).toBeUndefined();
  });

  it("returns AES256 for SSE-S3", () => {
    expect(serverSideEncryption({ ...baseCfg, encryption: "SSE-S3" })).toBe("AES256");
  });

  it("treats a missing value as off (old data.json)", () => {
    const cfg = { ...baseCfg } as S3Config;
    delete (cfg as Partial<S3Config>).encryption;
    expect(serverSideEncryption(cfg)).toBeUndefined();
  });
});

describe("publicUrl", () => {
  it("path style: inserts bucket between publicEndpoint and key", () => {
    const cfg = { ...baseCfg, publicUrlStyle: "path" as const };
    expect(publicUrl(cfg, "media/6a8903a8583f073af66de38d403095d9.jpg")).toBe(
      "http://127.0.0.1:9000/obsidian-plugin-test/media/6a8903a8583f073af66de38d403095d9.jpg"
    );
  });

  it("virtual-host style: does not repeat bucket", () => {
    const cfg = {
      ...baseCfg,
      publicEndpoint: "https://obsidian-plugin-test.s3.example.com",
      publicUrlStyle: "virtual-host" as const,
    };
    expect(publicUrl(cfg, "media/6a8903a8583f073af66de38d403095d9.jpg")).toBe(
      "https://obsidian-plugin-test.s3.example.com/media/6a8903a8583f073af66de38d403095d9.jpg"
    );
  });

  it("strips multiple trailing slashes from publicEndpoint", () => {
    const cfg = {
      ...baseCfg,
      publicEndpoint: "http://127.0.0.1:9000///",
      publicUrlStyle: "path" as const,
    };
    expect(publicUrl(cfg, "media/abc.jpg")).toBe(
      "http://127.0.0.1:9000/obsidian-plugin-test/media/abc.jpg"
    );
  });

  it("keeps Unicode and spaces in key without double encoding", () => {
    const cfg = { ...baseCfg, publicUrlStyle: "path" as const };
    expect(publicUrl(cfg, "media/файл с пробелом.jpg")).toBe(
      "http://127.0.0.1:9000/obsidian-plugin-test/media/файл с пробелом.jpg"
    );
  });

  it("path style works with key that has no folder prefix", () => {
    const cfg = { ...baseCfg, publicUrlStyle: "path" as const };
    expect(publicUrl(cfg, "abc.jpg")).toBe(
      "http://127.0.0.1:9000/obsidian-plugin-test/abc.jpg"
    );
  });
});
