const SAFE_BRAND_NAME = /^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SAFE_ARCH = /^(?:x64|arm64)$/u;

function requireMatch(value, pattern, label) {
  const normalized = String(value ?? "").trim();
  if (!pattern.test(normalized)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function windowsArchLabel(target = "x86_64-pc-windows-msvc") {
  const normalized = String(target ?? "").trim().toLowerCase();
  if (normalized === "x64" || normalized.startsWith("x86_64")) return "x64";
  if (normalized === "arm64" || normalized.startsWith("aarch64")) return "arm64";
  throw new Error(`Unsupported Windows target: ${JSON.stringify(target)}`);
}

export function windowsInstallerName({ artifactBrandName, version, arch = "x64" }) {
  const brand = requireMatch(artifactBrandName, SAFE_BRAND_NAME, "artifact brand name");
  const releaseVersion = requireMatch(version, SEMVER, "desktop version");
  const architecture = requireMatch(arch, SAFE_ARCH, "Windows architecture");
  return `Hermes-${brand}-${releaseVersion}_${architecture}-setup.exe`;
}

export function tauriDefaultWindowsInstallerName({ productName, version, arch = "x64" }) {
  const product = String(productName ?? "").trim();
  if (!product || /[\\/:*?"<>|]/u.test(product)) {
    throw new Error(`Invalid Tauri product name: ${JSON.stringify(productName)}`);
  }
  const releaseVersion = requireMatch(version, SEMVER, "desktop version");
  const architecture = requireMatch(arch, SAFE_ARCH, "Windows architecture");
  return `${product}_${releaseVersion}_${architecture}-setup.exe`;
}
