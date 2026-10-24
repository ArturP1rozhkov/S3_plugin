import { describe, expect, it, vi } from "vitest";
import { publicUrl, serverSideEncryption, uploadBuffer } from "../../src/s3Client";
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

describe("uploadBuffer encryption fallback", () => {
  function fakeClient(onSend: (input: any) => void) {
    const calls: any[] = [];
    return {
      calls,
      client: {
        send: async (cmd: any) => {
          calls.push(cmd.input);
          onSend(cmd.input);
          return {};
        },
      } as any,
    };
  }

  function encryptionError(): any {
    const err: any = new Error(
      "Requests specifying Server Side Encryption with Customer provided keys must provide a valid encryption algorithm"
    );
    err.name = "InvalidArgument";
    err.$metadata = { httpStatusCode: 400 };
    return err;
  }

  it("sends AES256 when encryption is enabled", async () => {
    const { client, calls } = fakeClient(() => {});
    const result = await uploadBuffer(
      client, { ...baseCfg, encryption: "SSE-S3" }, "media/a.jpg", new Uint8Array([1]), "image/jpeg"
    );
    expect(result.encryptionApplied).toBe(true);
    expect(calls[0].ServerSideEncryption).toBe("AES256");
  });

  it("retries without encryption when the storage rejects the header", async () => {
    const { client, calls } = fakeClient((input) => {
      if (input.ServerSideEncryption) throw encryptionError();
    });
    const result = await uploadBuffer(
      client, { ...baseCfg, encryption: "SSE-S3" }, "media/a.jpg", new Uint8Array([1]), "image/jpeg"
    );
    expect(result.encryptionApplied).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1].ServerSideEncryption).toBeUndefined();
  });

  it("does not swallow unrelated errors", async () => {
    const { client } = fakeClient(() => {
      const err: any = new Error("Forbidden");
      err.name = "AccessDenied";
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    });
    await expect(
      uploadBuffer(client, { ...baseCfg, encryption: "SSE-S3" }, "k", new Uint8Array([1]), "text/plain")
    ).rejects.toThrow("Forbidden");
  });

  it("sends nothing extra when encryption is off", async () => {
    const { client, calls } = fakeClient(() => {});
    await uploadBuffer(client, baseCfg, "k", new Uint8Array([1]), "text/plain");
    expect(calls[0].ServerSideEncryption).toBeUndefined();
  });
});

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
