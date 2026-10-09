import { describe, expect, it } from "vitest";
import {
  canonicalMediaTag,
  isAlreadyS3Ref,
  isAttachmentCandidate,
  isExternalRef,
  makeReplacement,
  parseAllAttachmentRefs,
  parseAllRefs,
  parseWikilinkSize,
  refExt,
  refFilename,
  splitRef,
} from "../../src/engine/linkParser";
import { ATTACHMENT_EXT } from "../../src/engine/fileClassifier";

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
    // Режим markdown-ссылок Obsidian: путь приходит URL-кодированным.
    [
      "folder/file%20name.jpg?download=1#page=2",
      {
        path: "folder/file name.jpg",
        query: "download=1",
        anchor: "page=2",
      },
    ],
    // %23 — это «#» внутри имени файла, а не anchor.
    ["a%23b.png", { path: "a#b.png", query: "", anchor: "" }],
    // Литеральный «%», не являющийся escape-последовательностью.
    ["bad%escape.png", { path: "bad%escape.png", query: "", anchor: "" }],
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
    [
      "Снимок%20экрана%202026-03-24%20095018.png",
      ".png",
      "Снимок экрана 2026-03-24 095018.png",
    ],
    ["Folder/file%20name.pdf#page=2", ".pdf", "file name.pdf"],
  ])("extracts metadata from %s", (raw, extension, filename) => {
    expect(refExt(raw)).toBe(extension);
    expect(refFilename(raw)).toBe(filename);
  });
});

describe("parseAllRefs", () => {
  it("parses a wikilink whose file name contains square brackets", () => {
    const refs = parseAllRefs("![[Marianne Main Trailer Netflix [get.gt] - 2026-02-15.mp4]]");
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("wiki-embed");
    expect(refs[0].ref).toBe("Marianne Main Trailer Netflix [get.gt] - 2026-02-15.mp4");
    expect(isAttachmentCandidate(refs[0], ATTACHMENT_EXT)).toBe(true);
  });

  it("still splits the alias for bracketed names", () => {
    const refs = parseAllRefs("![[Folder/file [v2] name.png|720]]");
    expect(refs[0].ref).toBe("Folder/file [v2] name.png");
    expect(refs[0].altText).toBe("720");
  });

  it.each([
    ["![[img.jpg]]", "wiki-embed", "img.jpg", ""],
    ["[[Folder/img.jpg|alias]]", "wiki-link", "Folder/img.jpg", "alias"],
    ["![alt](img.jpg?ver=2)", "md-embed", "img.jpg?ver=2", "alt"],
    ["[document](file.pdf#page=2)", "md-link", "file.pdf#page=2", "document"],
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

describe("isAttachmentCandidate", () => {
  const ext = ATTACHMENT_EXT;

  it.each([
    ["wiki-embed image", "![[Files/photo.png]]", true],
    ["wiki-embed image with size", "![[Files/photo.png|550]]", true],
    ["wiki-embed image with dimensions", "![[Files/photo.png|550x300]]", true],
    ["wiki-embed pdf", "![[Files/file.pdf]]", true],
    ["wiki-embed audio", "![[Files/audio.mp3]]", true],
    ["wiki-embed video", "![[Files/video.mp4]]", true],
    ["wiki-link image", "[[Files/photo.png]]", true],
    ["wiki-link image with alias", "[[Files/photo.png|Открыть]]", true],
    ["wiki-link pdf", "[[Files/file.pdf]]", true],
    ["wiki-link pdf with alias", "[[Files/file.pdf|Открыть]]", true],
    ["markdown-embed local image", "![alt](Files/photo.jpg)", true],
    ["markdown-embed encoded local image", "![alt](Files/photo%20one.jpg)", true],
    ["markdown-embed local pdf", "![alt](Files/file.pdf)", true],
    ["markdown-link local image", "[фото](Files/photo.png)", true],
    ["markdown-link local pdf", "[Открыть](Files/file.pdf)", true],
    ["markdown-link local video", "[видео](Files/clip.mp4)", true],
    ["html image local", '<img src="Files/photo.jpg" width="550">', true],
    ["html video local", '<video src="Files/video.mp4" controls></video>', true],
    ["html audio local", '<audio src="Files/audio.mp3" controls></audio>', true],
    ["html source local", '<source src="Files/video.webm" type="video/webm">', true],
  ])("accepts %s", (_name, input, expected) => {
    const parsed = parseAllRefs(input)[0];
    expect(isAttachmentCandidate(parsed, ext)).toBe(expected);
  });

  it.each([
    ["wiki-link note", "[[Обычная заметка]]", false],
    ["wiki-link md note", "[[Обычная заметка.md]]", false],
    ["wiki-link heading transclusion", "[[Заметка#Заголовок]]", false],
    ["markdown-link note", "[Обычная заметка](Обычная заметка.md)", false],
    ["markdown-link note without extension", "[Обычная заметка](Обычная заметка)", false],
    ["markdown-link image", "[Обычная ссылка](https://host/image.jpg)", false],
    ["markdown-link pdf", "[Открыть PDF](https://host/file.pdf)", false],
    ["markdown-embed external image", "![alt](https://host/image.png)", false],
    ["markdown-embed external image with title", '![Схема](https://host/image.png "title")', false],
    ["markdown-embed external pdf", "![alt](https://host/file.pdf)", false],
    ["html image external", '<img src="https://host/image.jpg" width="550">', false],
    ["html video external", '<video src="https://host/video.mp4" controls></video>', false],
    ["html audio external", '<audio src="https://host/audio.mp3" controls></audio>', false],
    ["html source external", '<source src="https://host/video.webm" type="video/webm">', false],
    ["bare url does not parse as ref", "https://host/image.jpg", false],
    ["autolink does not parse as ref", "<https://host/image.jpg>", false],
    ["anchor", "[Сноска](#fn-1)", false],
    ["note transclusion", "![[Note]]", false],
    ["note md transclusion", "![[Note.md]]", false],
    ["heading transclusion", "![[Note#Heading]]", false],
    ["block transclusion", "![[Note#^block-id]]", false],
    ["markdown image fragment-only", "![alt](#anchor)", false],
    ["markdown link fragment-only", "[text](#fnref-1)", false],
  ])("rejects %s", (_name, input, expected) => {
    const parsed = parseAllRefs(input)[0];
    if (!parsed) {
      expect(expected).toBe(false);
      return;
    }
    expect(isAttachmentCandidate(parsed, ext)).toBe(expected);
  });
});

describe("parseAllAttachmentRefs", () => {
  it("returns attachment candidates of every local form from mixed content", () => {
    const content = [
      "![[Files/file.pdf]]",
      "[[Files/file.pdf]]",
      "![alt](Files/image.png)",
      "[Открыть](Files/image.png)",
      '<img src="Files/image.jpg">',
      '<a href="Files/file.pdf">Открыть</a>',
      "https://host/video.mp4",
      "[Сноска](#fn-1)",
      "![[Note#^block-id]]",
    ].join("\n");

    const refs = parseAllAttachmentRefs(content, ATTACHMENT_EXT);
    const kinds = refs.map((r) => r.kind);
    expect(kinds).toEqual(["wiki-embed", "wiki-link", "md-embed", "md-link", "html-img"]);
  });

  it("ignores external links in every form", () => {
    const content = [
      "![alt](https://host/image.png)",
      "[Открыть](https://host/file.pdf)",
      '<img src="https://host/image.jpg">',
      '<video src="https://host/video.mp4" controls></video>',
      '<audio src="https://host/audio.mp3" controls></audio>',
    ].join("\n");

    expect(parseAllAttachmentRefs(content, ATTACHMENT_EXT)).toEqual([]);
  });

  it("treats a local link and a local embed of the same file as two refs", () => {
    const path = "Files/image.png";
    const content = `[ссылка](${path}) и ![картинка](${path})`;
    const refs = parseAllAttachmentRefs(content, ATTACHMENT_EXT);
    expect(refs.map((r) => r.kind)).toEqual(["md-link", "md-embed"]);
    expect(refs.map((r) => r.fullMatch)).toEqual([
      `[ссылка](${path})`,
      `![картинка](${path})`,
    ]);
  });

  it("preserves Obsidian size aliases on image embeds", () => {
    const refs = parseAllAttachmentRefs(
      "![[Files/photo.png|550]]\n![[Files/photo.png|550x300]]",
      ATTACHMENT_EXT
    );
    expect(refs.map((r) => r.ref)).toEqual([
      "Files/photo.png",
      "Files/photo.png",
    ]);
    expect(refs.map((r) => r.altText)).toEqual(["550", "550x300"]);
  });

  it("preserves markdown image alt text and title", () => {
    const refs = parseAllAttachmentRefs(
      '![Схема](Files/image.png "title")',
      ATTACHMENT_EXT
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].ref).toBe("Files/image.png");
    expect(refs[0].altText).toBe("Схема");
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

  it("gives media the same player form for links and embeds", () => {
    // Видео/аудио рендерятся сразу, независимо от способа вставки.
    expect(makeReplacement(url, "clip.mp4", ".mp4", "видео", 550, "md-link")).toBe(
      `<video src="${url}" controls></video>`
    );
    expect(makeReplacement(url, "clip.mp4", ".mp4", "видео", 550, "wiki-link")).toBe(
      `<video src="${url}" controls></video>`
    );
    expect(makeReplacement(url, "sound.mp3", ".mp3", "", 550, "md-link")).toBe(
      `<audio src="${url}" controls></audio>`
    );
    // Картинка: принудительный «!» + ширина, чтобы рендерилась сразу.
    expect(makeReplacement(url, "image.jpg", ".jpg", "фото", 550, "md-link")).toBe(
      `![|550](${url})`
    );
    // Не медиа: обычная ссылка.
    expect(makeReplacement(url, "doc.docx", ".docx", "док", 550, "md-link")).toBe(
      `[док](${url})`
    );
    expect(makeReplacement(url, "report.pdf", ".pdf", "документ", 550, "md-link")).toBe(
      "![[report.pdf]]"
    );
  });
});

describe("canonicalMediaTag", () => {
  const mp4 = "https://s3.example/media/a.mp4";
  const mp3 = "https://s3.example/media/a.mp3";
  const png = "https://s3.example/media/a.png";

  it("rewrites video/audio that was embedded as an image or a link", () => {
    expect(canonicalMediaTag("md-embed", mp4)).toBe(`<video src="${mp4}" controls></video>`);
    expect(canonicalMediaTag("wiki-embed", mp4)).toBe(`<video src="${mp4}" controls></video>`);
    expect(canonicalMediaTag("html-img", mp3)).toBe(`<audio src="${mp3}" controls></audio>`);
    expect(canonicalMediaTag("md-link", mp4)).toBe(`<video src="${mp4}" controls></video>`);
    expect(canonicalMediaTag("wiki-link", mp3)).toBe(`<audio src="${mp3}" controls></audio>`);
  });

  it("leaves correct forms untouched", () => {
    expect(canonicalMediaTag("html-video", mp4)).toBeNull();
    expect(canonicalMediaTag("html-audio", mp3)).toBeNull();
    expect(canonicalMediaTag("html-source", mp4)).toBeNull();
    expect(canonicalMediaTag("md-embed", png)).toBeNull();
    expect(canonicalMediaTag("md-embed", "https://s3.example/docs/a.pdf")).toBeNull();
  });
});

describe("parseWikilinkSize", () => {
  it.each([
    ["", undefined],
    ["750", 750],
    ["300x200", 300],
    ["550x", undefined],
    ["x200", undefined],
    ["caption", undefined],
    ["  800x600  ", 800],
  ])("parses %s as %s", (alias, expected) => {
    expect(parseWikilinkSize(alias)).toBe(expected);
  });
});