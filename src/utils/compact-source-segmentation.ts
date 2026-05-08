export const COMPACT_PLAIN_BULLET_BOUNDARY = "[-*+]\\s+(?!\\[[ xX]\\]\\s+)(?!\\d)";
export const COMPACT_MARKDOWN_TASK_BOUNDARY = "[-*+]\\s+\\[[ xX]\\]\\s+";
export const COMPACT_TIME_RANGE_BULLET_BOUNDARY =
  "[-*+]\\s+\\d{1,2}[:：]\\d{2}\\s*[-~—–到至]+\\s*\\d{1,2}[:：]\\d{2}";

export interface CompactSourceSegmentOptions {
  boundaryPatterns: string[];
}

function buildBoundaryPattern(patterns: string[]): RegExp | null {
  const effectivePatterns = patterns.map((pattern) => pattern.trim()).filter(Boolean);
  if (effectivePatterns.length === 0) {
    return null;
  }

  return new RegExp(`(?=\\s*(?:${effectivePatterns.join("|")}))`, "u");
}

export function splitCompactSourceLine(
  line: string,
  options: CompactSourceSegmentOptions
): string[] {
  const boundaryPattern = buildBoundaryPattern(options.boundaryPatterns);
  const normalizedLine = line.trim();
  if (!boundaryPattern || !normalizedLine) {
    return [line];
  }

  const fragments = normalizedLine
    .split(boundaryPattern)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);

  return fragments.length > 1 ? fragments : [line];
}

export function splitCompactSourceText(
  content: string,
  options: CompactSourceSegmentOptions
): string {
  return content
    .split(/\r?\n/)
    .flatMap((line) => splitCompactSourceLine(line, options))
    .join("\n");
}
