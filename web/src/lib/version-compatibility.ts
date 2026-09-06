import matrixJson from "../../../compatibility/desktop-core.json";

export interface DesktopCoreCompatibilityRule {
  desktopSeries: string;
  coreSeries: string[];
  runtimeManifestSchemas: number[];
  status: "current" | "historical" | string;
}

export interface DesktopCoreCompatibilityMatrix {
  schemaVersion: number;
  rules: DesktopCoreCompatibilityRule[];
}

export const DESKTOP_CORE_COMPATIBILITY_MATRIX = matrixJson as DesktopCoreCompatibilityMatrix;

export function versionSeries(version: string | null | undefined): string | null {
  const match = version?.trim().replace(/^[vV]/, "").match(/^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/);
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}`;
}

export function compatibilityRuleForDesktop(
  desktopVersion: string,
): DesktopCoreCompatibilityRule | null {
  const desktopSeries = versionSeries(desktopVersion);
  if (!desktopSeries) return null;
  return (
    DESKTOP_CORE_COMPATIBILITY_MATRIX.rules.find(
      (rule) => rule.desktopSeries === desktopSeries,
    ) ?? null
  );
}

export function compatibleCoreSeriesForDesktop(desktopVersion: string): string[] {
  return compatibilityRuleForDesktop(desktopVersion)?.coreSeries ?? [];
}

export function expectedCoreSeriesLabel(desktopVersion: string): string | null {
  const series = compatibleCoreSeriesForDesktop(desktopVersion);
  return series.length > 0 ? series.map((value) => `${value}.x`).join(" / ") : null;
}

export function isDesktopCoreCompatible(
  desktopVersion: string,
  coreVersion: string,
): boolean {
  const coreSeries = versionSeries(coreVersion);
  return coreSeries !== null
    && compatibleCoreSeriesForDesktop(desktopVersion).includes(coreSeries);
}
