export function uniqueLabelVariants(labels: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  labels.forEach((label) => {
    const trimmed = label.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(trimmed);
  });
  return result;
}

function stripParentheticalSuffix(label: string): string {
  return label
    .replace(/\s*[（(][^（）()\r\n]{1,32}[）)]\s*$/u, "")
    .trim();
}

export function expandLabelVariants(labels: string[]): string[] {
  return uniqueLabelVariants(
    labels.flatMap((label) => {
      const trimmed = label.trim();
      const withoutParenthetical = stripParentheticalSuffix(trimmed);
      return withoutParenthetical && withoutParenthetical !== trimmed
        ? [trimmed, withoutParenthetical]
        : [trimmed];
    })
  );
}
