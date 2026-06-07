export type ApprovalMode = "default" | "smart" | "yolo";

const DEFAULT_VALUES = ["manual", "default", "ask"];
const YOLO_VALUES = ["yolo", "off"];

function normalizeOption(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  const normalized = normalizeOption(value);
  if (normalized === "smart") return "smart";
  if (YOLO_VALUES.includes(normalized)) return "yolo";
  return "default";
}

export function approvalModeLabel(mode: ApprovalMode): string {
  switch (mode) {
    case "smart":
      return "Smart 智能审批";
    case "yolo":
      return "YOLO 全部放行";
    case "default":
    default:
      return "默认手动审批";
  }
}

export function approvalModeConfigValue(
  mode: ApprovalMode,
  schemaOptions?: readonly string[],
): string {
  const options = schemaOptions?.map(normalizeOption).filter(Boolean) ?? [];
  const hasOptions = options.length > 0;
  const pick = (candidates: readonly string[], fallback: string) =>
    candidates.find((candidate) => options.includes(candidate)) ?? fallback;

  if (mode === "smart") return hasOptions ? pick(["smart"], "smart") : "smart";
  if (mode === "yolo") return hasOptions ? pick(YOLO_VALUES, "yolo") : "yolo";
  return hasOptions ? pick(DEFAULT_VALUES, "manual") : "manual";
}

export function isApprovalModeAvailable(
  mode: ApprovalMode,
  schemaOptions?: readonly string[],
  schemaFields?: Record<string, unknown>,
): boolean {
  const options = schemaOptions?.map(normalizeOption).filter(Boolean) ?? [];
  if (options.length === 0) {
    return mode !== "smart" || hasSmartApprovalCapability(schemaFields);
  }
  if (mode === "smart") return options.includes("smart") || hasSmartApprovalCapability(schemaFields);
  if (mode === "yolo") return YOLO_VALUES.some((value) => options.includes(value));
  return DEFAULT_VALUES.some((value) => options.includes(value));
}

export function hasSmartApprovalCapability(schemaFields?: Record<string, unknown>): boolean {
  if (!schemaFields) return false;
  return [
    "auxiliary.approval.provider",
    "auxiliary.approval.model",
    "auxiliary.approval.timeout",
  ].some((key) => Object.prototype.hasOwnProperty.call(schemaFields, key));
}
