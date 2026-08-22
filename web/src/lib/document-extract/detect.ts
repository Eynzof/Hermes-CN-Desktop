const BUILT_IN_EXTENSIONS = new Set([".ipynb", ".docx", ".xlsx"]);
const ANYDOC_EXTENSIONS = new Set([
  ".doc", ".docm", ".ppt", ".pps", ".pot", ".pptx", ".pptm", ".ppsx", ".ppsm",
  ".xls", ".xlsm", ".xlsb", ".odt", ".ods", ".odp", ".rtf", ".epub", ".pdf",
]);

export function getExt(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx).toLowerCase() : "";
}

export function isBuiltInExtractable(path: string): boolean {
  return BUILT_IN_EXTENSIONS.has(getExt(path));
}

export function isAnyDocExtension(path: string): boolean {
  return ANYDOC_EXTENSIONS.has(getExt(path));
}

export function isExtractableDocument(path: string, anydocAvailable = false): boolean {
  return isBuiltInExtractable(path) || (anydocAvailable && isAnyDocExtension(path));
}
