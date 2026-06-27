// A minimal valid 1x1 PNG, shared by the protocol smoke test and the browser
// image spec so "the image" is one fixture with one known decoded byte length.
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
export const PNG_BYTE_LENGTH = PNG_BYTES.length;
