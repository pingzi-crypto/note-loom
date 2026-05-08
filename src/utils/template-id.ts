function hashString(input: string): string {
  let hash = 5381;
  for (const char of input) {
    hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  }

  return Math.abs(hash >>> 0).toString(36);
}

function normalizeTemplatePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

export function createTemplateId(path: string): string {
  const normalized = normalizeTemplatePath(path);
  return `template-${hashString(normalized || "empty")}`;
}
