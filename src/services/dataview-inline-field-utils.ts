export function escapeInlineFieldRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function dedupeInlineFieldNames(fieldNames: string[] | undefined): string[] {
  const seen = new Set<string>();
  const fields: string[] = [];
  (fieldNames ?? []).forEach((fieldName) => {
    const trimmed = fieldName.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(key)) {
      return;
    }

    seen.add(key);
    fields.push(trimmed);
  });
  return fields;
}

export function normalizeRepeatableInlineFieldValue(value: string): string {
  return value
    .replace(/^[，,。；;、\s]+/u, "")
    .replace(/^(?:是|为|叫)\s*/u, "")
    .replace(/^[-*+]\s+/u, "")
    .replace(/\]+$/u, "")
    .replace(/[，,。；;、\s]+$/u, "")
    .trim();
}
