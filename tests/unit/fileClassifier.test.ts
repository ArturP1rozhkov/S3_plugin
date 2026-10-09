import { describe, expect, it } from "vitest";
import {
  canonicalExt,
  fileType,
  s3Key,
  DEFAULT_FOLDER_MAP,
} from "../../src/engine/fileClassifier";

describe("canonicalExt", () => {
  it("collapses jpeg aliases into one extension", () => {
    expect(canonicalExt(".jpeg")).toBe(".jpg");
    expect(canonicalExt(".JPEG")).toBe(".jpg");
    expect(canonicalExt(".jpe")).toBe(".jpg");
    expect(canonicalExt(".jpg")).toBe(".jpg");
  });

  it("leaves other extensions untouched (lowercased)", () => {
    expect(canonicalExt(".PDF")).toBe(".pdf");
    expect(canonicalExt(".PNG")).toBe(".png");
    expect(canonicalExt("")).toBe("");
  });

  it("keeps canonical keys in the same type folder", () => {
    // Именно это делает a.jpg и b.jpeg одним объектом в бакете.
    expect(s3Key(DEFAULT_FOLDER_MAP, "abc123.jpg", canonicalExt(".jpeg"))).toBe("media/abc123.jpg");
    expect(s3Key(DEFAULT_FOLDER_MAP, "abc123.jpg", canonicalExt(".jpg"))).toBe("media/abc123.jpg");
  });

  it("still classifies .jpeg as an image", () => {
    expect(fileType(".jpeg")).toBe("image");
  });
});
