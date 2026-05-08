export function normalizeLooseCompareValue(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[_\-\s]/g, "")
    .replace(/[：:，,。.;；、|｜/\\\-—–~·`'"“”‘’()[\]{}]/g, "");
}

export function uniqueFieldLinkLabels(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

export function buildFieldLinkHints(fieldName: string): string[] {
  return uniqueFieldLinkLabels([fieldName]);
}

export function scoreFieldLinkCandidate(fieldName: string, labels: string[]): number {
  const normalizedFieldName = normalizeLooseCompareValue(fieldName);
  const normalizedLabels = uniqueFieldLinkLabels(labels).map(normalizeLooseCompareValue).filter(Boolean);
  if (normalizedLabels.includes(normalizedFieldName)) {
    return 100;
  }

  return 0;
}
