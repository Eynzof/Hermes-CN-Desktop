import { ExtractionError } from "./types.js";

export interface AnyDocConverter {
  toMarkdown(bytes: Uint8Array, ext: string): Promise<string>;
}

export async function extractWithAnyDoc(_bytes: Uint8Array, _ext: string, _converter?: AnyDocConverter): Promise<string> {
  if (!_converter) throw new ExtractionError("No anydoc converter available");
  return _converter.toMarkdown(_bytes, _ext);
}
