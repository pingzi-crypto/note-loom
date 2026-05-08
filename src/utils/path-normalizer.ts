export function normalizePathCompatible(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized === "/") {
    return normalized;
  }

  return normalized.replace(/^\.\//, "").replace(/\/$/, "");
}
