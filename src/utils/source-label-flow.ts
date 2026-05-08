import {
  escapeRegExp,
  hasStructuralLabelBoundaryEvidence,
  isCompactLabelOccurrenceInsideValue,
  startsWithNaturalLanguageContinuation
} from "./label-block";

function uniqueSortedLabels(labels: string[]): string[] {
  return Array.from(
    new Set(
      labels
        .map((label) => label.trim())
        .filter((label) => label.length > 0)
    )
  ).sort((left, right) => right.length - left.length);
}

function isDataviewInlineFieldOccurrenceOnBullet(
  label: string,
  textBeforeLabel: string,
  textAfterLabel: string
): boolean {
  const lastOpenBracketIndex = textBeforeLabel.lastIndexOf("[");
  const lastCloseBracketIndex = textBeforeLabel.lastIndexOf("]");
  if (lastOpenBracketIndex < 0 || lastCloseBracketIndex > lastOpenBracketIndex) {
    return false;
  }

  const currentLineStartIndex = Math.max(textBeforeLabel.lastIndexOf("\n"), textBeforeLabel.lastIndexOf("\r")) + 1;
  const linePrefixBeforeBracket = textBeforeLabel.slice(currentLineStartIndex, lastOpenBracketIndex);
  if (!/^\s*[-*+]\s+\S/u.test(linePrefixBeforeBracket)) {
    return false;
  }

  const nextCloseBracketIndex = textAfterLabel.indexOf("]");
  const nextOpenBracketIndex = textAfterLabel.indexOf("[");
  if (nextCloseBracketIndex < 0 || (nextOpenBracketIndex >= 0 && nextOpenBracketIndex < nextCloseBracketIndex)) {
    return false;
  }

  const inlineFieldFragment = `${textBeforeLabel.slice(lastOpenBracketIndex + 1)}${label}${textAfterLabel.slice(0, nextCloseBracketIndex)}`;
  return /^[^\]\r\n:]+::[\s\S]*$/u.test(inlineFieldFragment);
}

export function normalizeCompactSourceLabelFlow(
  sourceText: string,
  boundaryLabels: string[],
  nextLabels: string[],
  chainedBoundaryLabels: string[] = boundaryLabels
): string {
  const normalizedBoundaries = uniqueSortedLabels(boundaryLabels);
  const normalizedNextLabels = uniqueSortedLabels(nextLabels);
  const normalizedChainedBoundaries = new Set(uniqueSortedLabels(chainedBoundaryLabels));
  if (normalizedBoundaries.length === 0 || normalizedNextLabels.length === 0) {
    return sourceText;
  }

  const nextLabelPattern = normalizedNextLabels.map((label) => escapeRegExp(label)).join("|");
  if (!nextLabelPattern) {
    return sourceText;
  }

  return normalizedBoundaries.reduce((text, label) => {
    const overlapPrefixes = normalizedNextLabels
      .filter((candidate) => candidate !== label && candidate.endsWith(label))
      .map((candidate) => candidate.slice(0, candidate.length - label.length))
      .filter((prefix) => prefix.length > 0);
    const chainedLookahead = normalizedChainedBoundaries.has(label)
      ? `|(?:\\s+(?:${nextLabelPattern}))`
      : "";
    const pattern = new RegExp(
      `([^\\r\\n])(${escapeRegExp(label)})(?=(?:\\s*[：:])${chainedLookahead}|\\s+\\S|\\S)`,
      "g"
    );
    return text.replace(pattern, (match, prevChar: string, currentLabel: string, offset: number, fullText: string) => {
      const labelIndex = offset + prevChar.length;
      const textBeforeLabel = fullText.slice(0, labelIndex);
      const isSuffixOfLongerLabel = overlapPrefixes.some((prefix) => textBeforeLabel.endsWith(prefix));
      if (isSuffixOfLongerLabel) {
        return match;
      }
      const textAfterLabel = fullText.slice(offset + prevChar.length + currentLabel.length);
      if (isDataviewInlineFieldOccurrenceOnBullet(label, textBeforeLabel, textAfterLabel)) {
        return match;
      }

      if (isCompactLabelOccurrenceInsideValue({
        label,
        previousChar: prevChar,
        textBeforeLabel,
        textAfterLabel,
        nextLabels: normalizedNextLabels,
        chainedBoundaryLabels: Array.from(normalizedChainedBoundaries)
      })) {
        return match;
      }

      const nextNonWhitespace = textAfterLabel.match(/^\s*(.)/)?.[1] ?? "";
      const candidateValue = textAfterLabel.replace(/^\s*[：:，,。.;；、|｜/\\\-—–~·]*\s*/u, "");
      if (
        normalizedChainedBoundaries.has(label) &&
        nextNonWhitespace !== "：" &&
        nextNonWhitespace !== ":" &&
        startsWithNaturalLanguageContinuation(candidateValue)
      ) {
        return match;
      }

      if (normalizedChainedBoundaries.has(label) && nextNonWhitespace !== "：" && nextNonWhitespace !== ":") {
        const delimiter = textAfterLabel.match(/^(\s+)/)?.[1] ?? "";
        if (!hasStructuralLabelBoundaryEvidence({
          label,
          delimiter,
          hasKnownStructuralRule: true
        })) {
          return match;
        }

        return `${prevChar}\n${currentLabel}：\n`;
      }

      return `${prevChar}\n${currentLabel}`;
    });
  }, sourceText);
}
