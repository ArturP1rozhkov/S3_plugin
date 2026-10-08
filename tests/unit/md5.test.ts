import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { md5Buffer } from "../../src/engine/md5";

function nodeMd5(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  return createHash("md5").update(bytes).digest("hex");
}

describe("md5Buffer", () => {
  it.each([
    "",
    "abc",
    "The quick brown fox jumps over the lazy dog",
    "холодос 2.jpg content",
    "a".repeat(1_000_000),
  ])("matches Node crypto for %s", (input) => {
    const buf = new TextEncoder().encode(input).buffer;
    expect(md5Buffer(buf)).toBe(nodeMd5(buf));
  });

  it("accepts Uint8Array input", () => {
    const bytes = new TextEncoder().encode("hello world");
    expect(md5Buffer(bytes)).toBe(nodeMd5(bytes));
  });

  it("returns known empty-buffer MD5", () => {
    expect(md5Buffer(new ArrayBuffer(0))).toBe(
      "d41d8cd98f00b204e9800998ecf8427e"
    );
  });
});
