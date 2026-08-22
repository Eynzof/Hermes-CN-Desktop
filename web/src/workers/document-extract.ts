import { extractDocumentBytes } from "../lib/document-extract/index.js";

self.onmessage = async (event: MessageEvent) => {
  const { bytes, path } = event.data;
  try {
    const result = await extractDocumentBytes(bytes, path);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error) });
  }
};
