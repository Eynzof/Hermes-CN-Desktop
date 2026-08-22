import { describe, expect, it } from "vitest";
import { classifyImageFiles, imageFilesFromDataTransfer } from "./image-paste";

function createMockFile(name: string, type: string): File {
  return new File([new Uint8Array([0x89, 0x50])], name, { type });
}

class MockDataTransfer {
  items: DataTransferItemList = {
    add: (file: File) => {
      this.files.push(file);
      return null as unknown as DataTransferItem;
    },
  } as unknown as DataTransferItemList;
  files: File[] = [];
}

function createMockDataTransfer(files: File[]): DataTransfer {
  const dataTransfer = new MockDataTransfer();
  for (const file of files) {
    dataTransfer.items.add(file);
  }
  return dataTransfer as unknown as DataTransfer;
}

describe("imageFilesFromDataTransfer", () => {
  it("returns only image files", () => {
    const files = [
      createMockFile("a.png", "image/png"),
      createMockFile("b.txt", "text/plain"),
      createMockFile("c.jpg", "image/jpeg"),
    ];
    const result = imageFilesFromDataTransfer(createMockDataTransfer(files));
    expect(result.map((f) => f.name)).toEqual(["a.png", "c.jpg"]);
  });

  it("detects image by extension when type is missing", () => {
    const files = [createMockFile("x.heic", ""), createMockFile("y.svg", "")];
    const result = imageFilesFromDataTransfer(createMockDataTransfer(files));
    expect(result.map((f) => f.name)).toEqual(["x.heic", "y.svg"]);
  });
});

describe("classifyImageFiles", () => {
  it("accepts supported image types", () => {
    const files = [createMockFile("a.png", "image/png")];
    const { accepted, rejected } = classifyImageFiles(files, "browser");
    expect(accepted.length).toBe(1);
    expect(rejected.length).toBe(0);
    expect(accepted[0].source).toBe("browser");
  });

  it("rejects SVG with guidance", () => {
    const files = [createMockFile("a.svg", "image/svg+xml")];
    const { accepted, rejected } = classifyImageFiles(files, "clipboard");
    expect(accepted.length).toBe(0);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason.reason).toBe("svg");
    expect(rejected[0].reason.guidance).toContain("SVG");
  });

  it("rejects HEIC with guidance", () => {
    const files = [createMockFile("a.heic", "image/heic")];
    const { accepted, rejected } = classifyImageFiles(files, "drag");
    expect(accepted.length).toBe(0);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason.reason).toBe("unsupported");
  });
});
