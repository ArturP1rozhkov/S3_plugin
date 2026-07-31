import { describe, expect, it } from "vitest";
import {
  isAlreadyS3Ref,
  isExternalRef,
  makeReplacement,
  parseAllRefs,
  refExt,
  refFilename,
  splitRef,
} from "../../src/engine/linkParser";

describe("splitRef", () => {
  it.each([
    [
      "file.pdf#page=3",
      { path: "file.pdf", query: "", anchor: "page=3" },
    ],
    [
      "img.jpg?ver=2",
      { path: "img.jpg", query: "ver=2", anchor: "" },
    ],
    [
      "Folder/img.jpg",
      { path: "Folder/img.jpg", query: "", anchor: "" },
    ],
    [
      "#fnref-1",
      { path: "", query: "", anchor: "fnref-1" },
    ],
    [
      "  folder/file name.jpg?download=1#page=2  ",
      {
        path: "folder/file name.jpg",
        query: "download=1",
        anchor: "page=2",
      },
    ],
  ])("normalizes %s", (raw, expected) => {
    expect(splitRef(raw)).toEqual(expected);
  });

  it("keeps external URLs intact", () => {
    const url = "https://example.com/media/a.jpg?version=2#preview";
    expect(splitRef(url)).toEqual({ path: url, query: "", anchor: "" });
  });
});

describe("refExt and refFilename", () => {
  it.each([
    ["Folder/img.jpg#page=1", ".jpg", "img.jpg"],
    ["file.PDF?download=1", ".pdf", "file.PDF"],
    ["folder/file name with spaces.mp3", ".mp3", "file name with spaces.mp3"],
    ["#fnref-1", "", ""],
  ])("extracts metadata from %s", (raw, extension, filename) => {
    expect(refExt(raw)).toBe(extension);
    expect(refFilename(raw)).toBe(filename);
  });
});

describe("parseAllRefs", () => {
  it.each([
    ["![[img.jpg]]", "wiki-embed", "img.jpg", ""],
    ["[[Folder/img.jpg|alias]]", "wiki-link", "Folder/img.jpg", "alias"],
    ["![alt](img.jpg?ver=2)", "md-embed", "img.jpg?ver=2", "alt"],
    ["[document](file.pdf#page=2)", "md-link", "file.pdf#page=2", "document"],
    ["[folder/file name.jpg]", "bare-link", "folder/file name.jpg", ""],
    ['<img src="img.jpg">', "html-img", "img.jpg", ""],
    ['<video src="video.mp4"></video>', "html-video", "video.mp4", ""],
    ['<audio src="audio.mp3"></audio>', "html-audio", "audio.mp3", ""],
    [
      "[[файл с кириллицей.png]]",
      "wiki-link",
      "файл с кириллицей.png",
      "",
    ],
  ])("parses %s", (input, kind, ref, altText) => {
    expect(parseAllRefs(input)).toEqual([
      {
        fullMatch: input,
        kind,
        ref,
        altText,
      },
    ]);
  });

  it("does not parse footnotes, note links, or anchor-only links as attachments", () => {
    expect(parseAllRefs("^[[1]]")).toEqual([]);
    expect(parseAllRefs("[[note]]")).toEqual([
      {
        fullMatch: "[[note]]",
        ref: "note",
        altText: "",
        kind: "wiki-link",
      },
    ]);
    expect(parseAllRefs("[↩︎](#fnref-1)")).toEqual([
      {
        fullMatch: "[↩︎](#fnref-1)",
        ref: "#fnref-1",
        altText: "↩︎",
        kind: "md-link",
      },
    ]);
  });
});

describe("S3 classification helpers", () => {
  it("identifies external URLs", () => {
    expect(isExternalRef("https://example.com/a.jpg")).toBe(true);
    expect(isExternalRef("http://example.com/a.jpg")).toBe(true);
    expect(isExternalRef("Folder/a.jpg")).toBe(false);
  });

  it("detects public and API S3 URLs", () => {
    expect(
      isAlreadyS3Ref(
        "https://bucket.s3.example/media/a.jpg",
        "https://bucket.s3.example/",
        "",
        ""
      )
    ).toBe(true);

    expect(
      isAlreadyS3Ref(
        "https://s3.example/my-bucket/media/a.jpg",
        "",
        "https://s3.example/",
        "my-bucket"
      )
    ).toBe(true);

    expect(
      isAlreadyS3Ref(
        "https://example.com/a.jpg",
        "https://bucket.s3.example",
        "https://s3.example",
        "my-bucket"
      )
    ).toBe(false);
  });
});

describe("makeReplacement", () => {
  const url = "https://test-s3.invalid/media/object";

  it("creates canonical image, video, audio, PDF, and document output", () => {
    expect(makeReplacement(url, "image.jpg", ".jpg", "")).toBe(
      `![|550](${url})`
    );
    expect(makeReplacement(url, "clip.mp4", ".mp4", "")).toBe(
      `<video src="${url}" controls></video>`
    );
    expect(makeReplacement(url, "sound.mp3", ".mp3", "")).toBe(
      `<audio src="${url}" controls></audio>`
    );
    expect(makeReplacement(url, "report.pdf", ".pdf", "")).toBe(
      "![[report.pdf]]"
    );
    expect(makeReplacement(url, "archive.zip", ".zip", "Backup")).toBe(
      `[Backup](${url})`
    );
    expect(makeReplacement(url, "archive.zip", ".zip", "")).toBe(
      `[archive](${url})`
    );
  });

  it("uses a caller-provided image width", () => {
    expect(makeReplacement(url, "image.png", ".png", "", 750)).toBe(
      `![|750](${url})`
    );
  });
});