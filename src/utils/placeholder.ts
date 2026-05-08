function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractPlaceholders(content: string): string[] {
  const matches = content.matchAll(/{{\s*([^{}\r\n]+?)\s*}}/g);
  const placeholders: string[] = [];

  for (const match of matches) {
    const fieldName = match[1]?.trim();
    if (fieldName) {
      placeholders.push(fieldName);
    }
  }

  return placeholders;
}

export function replacePlaceholder(content: string, fieldName: string, value: string): string {
  const pattern = new RegExp(`{{\\s*${escapeRegExp(fieldName)}\\s*}}`, "g");
  return content.replace(pattern, value);
}

export function replaceAllPlaceholders(
  content: string,
  values: Record<string, string>
): string {
  return Object.entries(values).reduce(
    (currentContent, [fieldName, value]) => replacePlaceholder(currentContent, fieldName, value),
    content
  );
}
