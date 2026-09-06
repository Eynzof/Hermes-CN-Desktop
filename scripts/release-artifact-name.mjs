export function safeReleaseAssetName(fileName) {
  const normalised = fileName
    .replace(/[^0-9A-Za-z._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,254}$/.test(normalised)) {
    throw new Error(`release asset 文件名无法安全规范化：${fileName}`);
  }
  return normalised;
}
