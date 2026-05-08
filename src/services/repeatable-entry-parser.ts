export interface RepeatableEntryParseResult {
  content: string;
  warnings: string[];
}

export interface RepeatableEntryLineParseResult {
  content: string;
  warnings?: string[];
}

export interface RepeatableEntryParserOptions {
  parseLine: (line: string) => RepeatableEntryLineParseResult | string;
  shouldSkipLine?: (line: string) => boolean;
}

function shouldSkipDefaultLine(line: string): boolean {
  return /^(#|>|```|---)/.test(line);
}

export function prefixRepeatableBullet(line: string): string {
  const normalized = line.trim();
  if (!normalized) {
    return "";
  }

  return normalized.startsWith("- ") ? normalized : `- ${normalized}`;
}

export function runRepeatableEntryParser(
  content: string,
  options: RepeatableEntryParserOptions
): RepeatableEntryParseResult {
  const warnings: string[] = [];
  const parsedLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !(options.shouldSkipLine ?? shouldSkipDefaultLine)(line))
    .map((line) => {
      const parsed = options.parseLine(line);
      if (typeof parsed === "string") {
        return parsed;
      }

      warnings.push(...(parsed.warnings ?? []));
      return parsed.content;
    })
    .filter((line) => line.length > 0);

  return {
    content: parsedLines.join("\n"),
    warnings: Array.from(new Set(warnings))
  };
}
