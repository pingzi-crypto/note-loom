export interface DetectedLabelStart {
  value: string;
  columnIndex: number;
}

export interface LabelBlockMatch {
  value: string;
  lineIndex: number;
  columnIndex: number;
  label?: string;
  priority: number;
}

export interface LabelBlockCollectorLineContext {
  sourceText: string;
  lines: string[];
  label: string;
  initialMatch: DetectedLabelStart;
  blockLines: string[];
  nextLine: string;
  nextIndex: number;
  previousLine: string;
}

export interface LabelBlockCollectorOptions {
  labels: string[];
  startOptions?: StructuralLabelStartOptions;
  shouldSkipStart?: (line: string, label: string, lineIndex: number) => boolean;
  shouldStopLine?: (context: LabelBlockCollectorLineContext) => boolean;
  mapValue?: (rawValue: string, label: string, initialMatch: DetectedLabelStart) => string;
}

export interface StructuralLabelStartOptions {
  allowQuotePrefix?: boolean;
  allowTightLabel?: boolean;
  allowMarkdownHeading?: boolean;
}

export interface StructuralLabelMatch extends DetectedLabelStart {
  label: string;
  priority: number;
}

export interface CompactLabelOccurrenceContext {
  label: string;
  previousChar: string;
  textBeforeLabel: string;
  textAfterLabel: string;
  nextLabels: string[];
  chainedBoundaryLabels?: string[];
}

export interface StructuralLabelBoundaryEvidenceContext {
  label: string;
  delimiter: string;
  textBeforeLabel?: string;
  hasKnownStructuralRule?: boolean;
  allowWhitespaceForAsciiLabel?: boolean;
}

export interface KnownLabelBoundaryContext extends StructuralLabelBoundaryEvidenceContext {
  textAfterLabel: string;
}

export type LabelTruncationStrategy =
  | "field-value"
  | "section-block"
  | "table-cell"
  | "frontmatter-short-value";

const EXPLICIT_LABEL_DELIMITER_PATTERN = /[:：=，,。；;、|｜/\\—–~·-]/u;
const ASCII_LIKE_LABEL_PATTERN = /^[A-Za-z0-9_:-]+$/;
const COMPACT_LABEL_VALUE_SEPARATOR_PATTERN = /[:：=，,；;、|｜/\\—–~·\s-]/u;
const SENTENCE_TERMINATOR_PATTERN = /^[。．.!！?？]/u;
const OPENING_QUOTE_OR_BRACKET_PATTERN = new RegExp("[（(\\u005b【{「『“\"‘']", "u");
const CLOSING_QUOTE_OR_BRACKET_PATTERN = new RegExp("[）)\\u005d】}」』”\"’']", "u");

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectLabelStart(line: string, label: string, options: { allowQuotePrefix?: boolean } = {}): DetectedLabelStart | null {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return null;
  }

  const quotePrefix = options.allowQuotePrefix ? ">?\\s*" : "";
  const columnIndex = Math.max(0, line.search(/\S|$/));
  const inlinePattern = new RegExp(
    `^\\s*${quotePrefix}${escapeRegExp(trimmedLabel)}\\s*[：:，,。.;；、|｜/\\\\\\-—–~·]\\s*(.*)$`
  );
  const inlineMatch = line.match(inlinePattern);
  if (inlineMatch) {
    return {
      value: inlineMatch[1]?.trimEnd() ?? "",
      columnIndex
    };
  }

  const noPunctuationPattern = new RegExp(`^\\s*${quotePrefix}${escapeRegExp(trimmedLabel)}\\s+(.+)$`);
  const noPunctuationMatch = line.match(noPunctuationPattern);
  if (noPunctuationMatch) {
    return {
      value: noPunctuationMatch[1]?.trimEnd() ?? "",
      columnIndex
    };
  }

  const headingPattern = new RegExp(`^\\s*${quotePrefix}${escapeRegExp(trimmedLabel)}\\s*$`);
  if (headingPattern.test(line)) {
    return {
      value: "",
      columnIndex
    };
  }

  return null;
}

export function detectTightLabelStart(
  line: string,
  label: string,
  options: { allowQuotePrefix?: boolean } = {}
): DetectedLabelStart | null {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return null;
  }

  const quotePrefix = options.allowQuotePrefix ? ">?\\s*" : "";
  const columnIndex = Math.max(0, line.search(/\S|$/));
  const directInlinePattern = new RegExp(`^\\s*${quotePrefix}${escapeRegExp(trimmedLabel)}([^？?].*)$`);
  const directInlineMatch = line.match(directInlinePattern);
  const value = directInlineMatch?.[1]?.trimEnd();
  if (!value) {
    return null;
  }

  if (/^[的地得]/u.test(value)) {
    return null;
  }

  if (/^(?:和|与|及|以及)\S/u.test(value)) {
    return null;
  }

  if (/\p{Script=Han}/u.test(trimmedLabel) && /^(?:是|为)\S/u.test(value)) {
    return null;
  }

  return {
    value,
    columnIndex
  };
}

export function detectMarkdownHeadingLabelStart(line: string, label: string): DetectedLabelStart | null {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return null;
  }

  const headingMatch = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
  if (!headingMatch) {
    return null;
  }

  const headingText = headingMatch[1]?.trim();
  if (headingText !== trimmedLabel) {
    return null;
  }

  return {
    value: "",
    columnIndex: Math.max(0, line.search(/\S|$/))
  };
}

export function detectStructuralLabelStart(
  line: string,
  label: string,
  options: StructuralLabelStartOptions = {}
): DetectedLabelStart | null {
  return (
    detectLabelStart(line, label, { allowQuotePrefix: options.allowQuotePrefix }) ??
    (options.allowTightLabel ? detectTightLabelStart(line, label, { allowQuotePrefix: options.allowQuotePrefix }) : null) ??
    (options.allowMarkdownHeading ? detectMarkdownHeadingLabelStart(line, label) : null)
  );
}

export function detectFirstStructuralLabelStart(
  line: string,
  labels: string[],
  options: StructuralLabelStartOptions = {}
): StructuralLabelMatch | null {
  const matches = labels
    .map((label, priority): StructuralLabelMatch | null => {
      const trimmedLabel = label.trim();
      if (!trimmedLabel) {
        return null;
      }

      const match = detectStructuralLabelStart(line, trimmedLabel, options);
      return match
        ? {
          ...match,
          label: trimmedLabel,
          priority
        }
        : null;
    })
    .filter((match): match is StructuralLabelMatch => match !== null)
    .sort((left, right) => {
      if (left.columnIndex !== right.columnIndex) {
        return left.columnIndex - right.columnIndex;
      }

      return left.priority - right.priority;
    });

  return matches[0] ?? null;
}

export function hasStructuralLabelStart(
  line: string,
  labels: string[],
  options: StructuralLabelStartOptions = {}
): boolean {
  return detectFirstStructuralLabelStart(line, labels, options) !== null;
}

export function collectBestLabelBlock(
  sourceText: string,
  options: LabelBlockCollectorOptions
): LabelBlockMatch | null {
  const labels = options.labels
    .map((label) => label.trim())
    .filter(Boolean);
  if (labels.length === 0) {
    return null;
  }

  const lines = sourceText.split(/\r?\n/);
  const matches: LabelBlockMatch[] = labels
    .map((label, priority): LabelBlockMatch | null => {
      for (let index = 0; index < lines.length; index += 1) {
        const currentLine = lines[index] ?? "";
        if (options.shouldSkipStart?.(currentLine, label, index)) {
          continue;
        }

        const initialMatch = detectStructuralLabelStart(currentLine, label, options.startOptions);
        if (!initialMatch) {
          continue;
        }

        const blockLines: string[] = [];
        if (initialMatch.value.length > 0) {
          blockLines.push(initialMatch.value);
        }

        let nextIndex = index + 1;
        while (nextIndex < lines.length) {
          const nextLine = lines[nextIndex] ?? "";
          const previousLine = blockLines[blockLines.length - 1] ?? "";
          if (
            options.shouldStopLine?.({
              sourceText,
              lines,
              label,
              initialMatch,
              blockLines,
              nextLine,
              nextIndex,
              previousLine
            })
          ) {
            break;
          }

          blockLines.push(nextLine);
          nextIndex += 1;
        }

        const rawValue = trimBlockLines(blockLines);
        const value = options.mapValue
          ? options.mapValue(rawValue, label, initialMatch)
          : rawValue;
        if (!value) {
          continue;
        }

        return {
          value,
          lineIndex: index,
          columnIndex: initialMatch.columnIndex,
          label,
          priority
        };
      }

      return null;
    })
    .filter((match): match is LabelBlockMatch => match !== null)
    .sort(compareLabelMatches);

  return matches[0] ?? null;
}

export function normalizeLineStartForLabelCheck(line: string): string {
  return line
    .trim()
    .replace(/^>\s*/, "")
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

export function startsWithLongerKnownLabel(line: string, label: string, knownLabels: string[]): boolean {
  const currentLabel = label.trim();
  if (!currentLabel) {
    return false;
  }

  const normalizedLine = normalizeLineStartForLabelCheck(line);
  return knownLabels.some((knownLabel) => {
    const normalizedKnownLabel = knownLabel.trim();
    return (
      normalizedKnownLabel.length > currentLabel.length &&
      normalizedKnownLabel.startsWith(currentLabel) &&
      normalizedLine.startsWith(normalizedKnownLabel)
    );
  });
}

export function isAsciiLikeLabel(label: string): boolean {
  return ASCII_LIKE_LABEL_PATTERN.test(label.trim());
}

export function hasStructuralLabelBoundaryEvidence(context: StructuralLabelBoundaryEvidenceContext): boolean {
  const label = context.label.trim();
  const delimiter = context.delimiter;
  if (!label) {
    return false;
  }

  if (/^[。．.]+$/u.test(delimiter)) {
    return true;
  }

  if (EXPLICIT_LABEL_DELIMITER_PATTERN.test(delimiter)) {
    return true;
  }

  if (/^\s+$/.test(delimiter)) {
    if (
      isAsciiLikeLabel(label) &&
      !context.hasKnownStructuralRule &&
      context.allowWhitespaceForAsciiLabel !== true
    ) {
      return false;
    }

    return true;
  }

  return false;
}

export function isSentenceTerminatedKnownLabelValue(context: { textAfterLabel: string }): boolean {
  return SENTENCE_TERMINATOR_PATTERN.test(context.textAfterLabel.trimStart());
}

function isNonAsciiCharacter(value: string): boolean {
  const codePoint = value.codePointAt(0);
  return codePoint !== undefined && codePoint > 0x7f;
}

function startsWithKnownStructuralValue(value: string): boolean {
  if (/^[A-Za-z0-9_-]+/iu.test(value)) {
    return true;
  }

  return ["是", "为", "我给", "大概", "约"].some((prefix) => {
    if (!value.startsWith(prefix)) {
      return false;
    }

    const nextChar = value.slice(prefix.length, prefix.length + 1);
    return !nextChar || /\s/u.test(nextChar) || isNonAsciiCharacter(nextChar);
  });
}

export function hasKnownLabelStructuralBoundary(context: KnownLabelBoundaryContext): boolean {
  const afterLabel = context.textAfterLabel.trimStart();
  if (!afterLabel || isSentenceTerminatedKnownLabelValue({ textAfterLabel: afterLabel })) {
    return false;
  }

  if (
    isAsciiLikeLabel(context.label) &&
    /^\s+$/.test(context.delimiter) &&
    startsWithKnownStructuralValue(afterLabel)
  ) {
    return true;
  }

  return hasStructuralLabelBoundaryEvidence(context);
}

export function startsWithNaturalLanguageContinuation(value: string): boolean {
  return /^(?:需要|能|可以|会|要|应|应该|可能|准备|继续|保持|用于|用来|作为|说明|提示|提醒|等待|记录|补|补充|写|做|处理|确认|验证|观察|形成|进入|避免|导致|让|把|被|给)/u.test(value.trimStart());
}

export function isCompactLabelOccurrenceInsideValue(context: CompactLabelOccurrenceContext): boolean {
  const label = context.label.trim();
  if (!label) {
    return false;
  }

  const normalizedNextLabels = context.nextLabels
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const chainedBoundaryLabels = new Set(
    (context.chainedBoundaryLabels ?? context.nextLabels)
      .map((candidate) => candidate.trim())
      .filter(Boolean)
  );
  const currentLineBeforeLabel = context.textBeforeLabel.slice(context.textBeforeLabel.lastIndexOf("\n") + 1);
  const nextNonWhitespaceAfterLabel = context.textAfterLabel.match(/^\s*(.)/)?.[1] ?? "";

  if (
    CLOSING_QUOTE_OR_BRACKET_PATTERN.test(nextNonWhitespaceAfterLabel) ||
    (
      OPENING_QUOTE_OR_BRACKET_PATTERN.test(context.previousChar) &&
      CLOSING_QUOTE_OR_BRACKET_PATTERN.test(nextNonWhitespaceAfterLabel)
    )
  ) {
    return true;
  }

  if (/^\s*#{1,6}\s*$/.test(currentLineBeforeLabel)) {
    return true;
  }

  if (label.length < 3 && /\p{Script=Han}/u.test(context.previousChar) && !/^\s*[：:]/.test(context.textAfterLabel)) {
    return true;
  }

  const sameLabelOpenMatch = currentLineBeforeLabel.match(
    new RegExp(`^\\s*${escapeRegExp(label)}(?:\\s*[：:，,。.;；、|｜/\\\\\\-—–~·]|\\s+)(.*)$`)
  );
  if (sameLabelOpenMatch) {
    const sameFieldValuePrefix = sameLabelOpenMatch[1] ?? "";
    const containsOtherLabel = normalizedNextLabels.some(
      (candidate) => candidate !== label && sameFieldValuePrefix.includes(candidate)
    );
    if (!containsOtherLabel) {
      return true;
    }
  }

  const startsAnotherKnownLabel = normalizedNextLabels.some(
    (candidate) => candidate !== label && context.textAfterLabel.trimStart().startsWith(candidate)
  );
  const sameLabelAppearedInCurrentValue = new RegExp(
    `${escapeRegExp(label)}\\s*[：:，,。.;；、|｜/\\\\\\-—–~·]`
  ).test(currentLineBeforeLabel);
  const startsLongerLabelThatIncludesCurrent = normalizedNextLabels.some(
    (candidate) =>
      candidate !== label &&
      candidate.endsWith(label) &&
      context.textAfterLabel.trimStart().startsWith(candidate)
  );
  if (startsAnotherKnownLabel && (sameLabelAppearedInCurrentValue || startsLongerLabelThatIncludesCurrent)) {
    return true;
  }
  if (sameLabelAppearedInCurrentValue && isSentenceTerminatedKnownLabelValue(context)) {
    return true;
  }

  const previousLabelValuePattern = new RegExp(`${escapeRegExp(label)}(?:\\s*[：:]|\\s+)\\s*$`);
  if (previousLabelValuePattern.test(context.textBeforeLabel) && !context.textAfterLabel.trimStart().startsWith(label)) {
    return true;
  }

  const nextNonWhitespace = nextNonWhitespaceAfterLabel;
  if (isSentenceTerminatedKnownLabelValue(context)) {
    return true;
  }

  if (nextNonWhitespace === "#") {
    return true;
  }

  if (
    isAsciiLikeLabel(label) &&
    !/[：:]/.test(context.textAfterLabel.slice(0, 3)) &&
    !/[：:]$/.test(context.textBeforeLabel)
  ) {
    return true;
  }

  if (
    chainedBoundaryLabels.has(label) &&
    /\p{Script=Han}/u.test(label) &&
    /^\s*\p{Script=Han}/u.test(context.textAfterLabel) &&
    /[\s，,、；;]/u.test(context.previousChar)
  ) {
    return true;
  }

  if (chainedBoundaryLabels.has(label) && nextNonWhitespace !== "：" && nextNonWhitespace !== ":") {
    const immediateNextChar = context.textAfterLabel.charAt(0);
    if (/\p{Script=Han}/u.test(immediateNextChar) && context.previousChar !== "：" && context.previousChar !== ":") {
      return true;
    }
    if (context.previousChar === "：" || context.previousChar === ":") {
      return true;
    }
    if (!nextNonWhitespace || /[，,。；;、]/u.test(nextNonWhitespace)) {
      return true;
    }
    const valueListPrefix = normalizedNextLabels
      .filter((candidate) => candidate !== label)
      .map((candidate) => {
        const openerMatch = currentLineBeforeLabel.match(
          new RegExp(`${escapeRegExp(candidate)}\\s*[：:]([^\\r\\n]*)$`)
        );
        return openerMatch?.[1] ?? "";
      })
      .find((prefix) => {
        const listSeparatorMatch = prefix.match(/[，,、]([^，,、]*)$/u);
        if (!listSeparatorMatch) {
          return false;
        }

        const tail = listSeparatorMatch[1] ?? "";
        return !normalizedNextLabels.some((candidate) => candidate !== label && tail.includes(candidate));
      });
    if (valueListPrefix) {
      return true;
    }
  }

  return false;
}

export function trimBlockLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.trim().length === 0) {
    start += 1;
  }

  while (end > start && lines[end - 1]?.trim().length === 0) {
    end -= 1;
  }

  return lines.slice(start, end).join("\n").trim();
}

export function normalizeInlineLabelValue(value: string): string {
  const trimmed = value.trim();
  const keepShortJudgement = /^(?:是|为)[。．.!！?？]?$/u.test(trimmed);
  const normalized = trimmed
    .trim()
    .replace(/^[，,。；;、]\s*/u, "")
    .replace(keepShortJudgement ? /^$/u : /^(?:(?:如果|若)?要填的话(?:就是|是)?|如果(?:要填)?(?:就是|是)|是(?=\s|["“]|\d)|为(?=\s|["“]|\d)|我给|大概|约|[=:：])\s*/i, "")
    .replace(/([0-9%％])[。．.]+$/u, "$1")
    .replace(/[，,；;\s]+$/g, "")
    .trim();

  return normalized || trimmed;
}

function truncateFrontmatterShortValue(value: string): string {
  const separatorIndex = value.search(/[。，]/u);
  const truncated = separatorIndex > 0 ? value.slice(0, separatorIndex) : value;

  return truncated.replace(/[。，]+$/u, "");
}

function splitKnownLabelFollowingText(value: string): { delimiter: string; textAfterDelimiter: string } {
  const delimiterMatch = value.match(/^(\s*([:：=，,；;、|｜/\\\-—–~·]|\s+))/u);
  return {
    delimiter: delimiterMatch?.[2] ?? "",
    textAfterDelimiter: value.slice(delimiterMatch?.[1]?.length ?? 0)
  };
}

function hasAttachedKnownLabelBoundary(context: { label: string; previousChar: string; textAfterLabel: string }): boolean {
  if (
    context.label.trim().length < 2 ||
    !/\p{Script=Han}/u.test(context.label) ||
    !/[，,。；;、\s]/u.test(context.previousChar)
  ) {
    return false;
  }

  return /^(?:这里|这一块|这一部分|这块|今天|如果|若|要填|填写|大概|约|就是|是|为)/u.test(
    context.textAfterLabel.trimStart()
  );
}

export function truncateKnownLabelsByStrategy(
  value: string,
  allLabels: string[],
  currentLabel: string | string[],
  strategy: LabelTruncationStrategy
): string {
  const sourceValue = strategy === "frontmatter-short-value"
    ? truncateFrontmatterShortValue(value)
    : value;
  const currentLabels = new Set(
    (Array.isArray(currentLabel) ? currentLabel : [currentLabel])
      .map((label) => label.trim())
      .filter(Boolean)
  );
  const otherLabels = allLabels
    .map((label) => label.trim())
    .filter((label) => label && !currentLabels.has(label))
    .sort((left, right) => right.length - left.length);
  let endIndex = sourceValue.length;

  otherLabels.forEach((label) => {
    const separatedPattern = new RegExp(`([\\s，,。；;、])${escapeRegExp(label)}`, "gi");
    let separatedMatch: RegExpExecArray | null;
    while ((separatedMatch = separatedPattern.exec(sourceValue)) !== null) {
      const labelStart = separatedMatch.index + (separatedMatch[1]?.length ?? 0);
      const beforeSeparator = separatedMatch.index > 0 ? sourceValue.charAt(separatedMatch.index - 1) : "";
      const afterLabelFirstChar = sourceValue.charAt(labelStart + label.length);
      if (
        OPENING_QUOTE_OR_BRACKET_PATTERN.test(beforeSeparator) ||
        CLOSING_QUOTE_OR_BRACKET_PATTERN.test(afterLabelFirstChar)
      ) {
        continue;
      }

      const afterLabel = sourceValue.slice(labelStart + label.length);
      const { delimiter, textAfterDelimiter } = splitKnownLabelFollowingText(afterLabel);
      if (hasKnownLabelStructuralBoundary({ label, delimiter, textAfterLabel: textAfterDelimiter })) {
        endIndex = Math.min(endIndex, labelStart);
      }
    }

    const compactIndex = sourceValue.indexOf(label);
    const compactPrevChar = compactIndex > 0 ? sourceValue.charAt(compactIndex - 1) : "";
    const compactNextChar = compactIndex >= 0 ? sourceValue.charAt(compactIndex + label.length) : "";
    const compactTextAfterLabel = compactIndex >= 0
      ? sourceValue.slice(compactIndex + label.length + compactNextChar.length)
      : "";
    if (
      compactIndex > 0 &&
      (
        CLOSING_QUOTE_OR_BRACKET_PATTERN.test(compactNextChar) ||
        (
          OPENING_QUOTE_OR_BRACKET_PATTERN.test(compactPrevChar) &&
          CLOSING_QUOTE_OR_BRACKET_PATTERN.test(compactNextChar)
        )
      )
    ) {
      return;
    }

    if (
      compactIndex > 0 &&
      !/\p{L}/u.test(compactPrevChar) &&
      COMPACT_LABEL_VALUE_SEPARATOR_PATTERN.test(compactNextChar) &&
      hasKnownLabelStructuralBoundary({
        label,
        delimiter: compactNextChar,
        textAfterLabel: compactTextAfterLabel
      })
    ) {
      endIndex = Math.min(endIndex, compactIndex);
    }

    if (
      compactIndex > 0 &&
      hasAttachedKnownLabelBoundary({
        label,
        previousChar: compactPrevChar,
        textAfterLabel: sourceValue.slice(compactIndex + label.length)
      })
    ) {
      endIndex = Math.min(endIndex, compactIndex);
    }

    if (
      compactIndex > 0 &&
      label.length >= 2 &&
      /\p{Script=Han}/u.test(label) &&
      label.length >= 3 &&
      !otherLabels.some((otherLabel) => otherLabel !== label && otherLabel.includes(label)) &&
      (
        /[A-Za-z0-9%\s:=：，,。；;、]/u.test(compactPrevChar) ||
        /\p{Script=Han}/u.test(compactPrevChar)
      ) &&
      COMPACT_LABEL_VALUE_SEPARATOR_PATTERN.test(compactNextChar) &&
      hasKnownLabelStructuralBoundary({
        label,
        delimiter: compactNextChar,
        textAfterLabel: compactTextAfterLabel
      })
    ) {
      endIndex = Math.min(endIndex, compactIndex);
    }
  });

  const truncatedValue = sourceValue.slice(0, endIndex);
  if (
    endIndex < sourceValue.length &&
    OPENING_QUOTE_OR_BRACKET_PATTERN.test(truncatedValue.trimEnd().slice(-1))
  ) {
    return normalizeInlineLabelValue(sourceValue);
  }

  return normalizeInlineLabelValue(truncatedValue);
}

export function truncateFieldValueAtNextKnownLabel(
  value: string,
  allLabels: string[],
  currentLabel: string | string[]
): string {
  return truncateKnownLabelsByStrategy(value, allLabels, currentLabel, "field-value");
}

export function truncateSectionBlockAtNextKnownLabel(
  value: string,
  allLabels: string[],
  currentLabel: string | string[]
): string {
  return truncateKnownLabelsByStrategy(value, allLabels, currentLabel, "section-block");
}

export function truncateTableCellAtNextKnownLabel(
  value: string,
  allLabels: string[],
  currentLabel: string | string[]
): string {
  return truncateKnownLabelsByStrategy(value, allLabels, currentLabel, "table-cell");
}

export function truncateFrontmatterShortValueAtNextKnownLabel(
  value: string,
  allLabels: string[],
  currentLabel: string | string[]
): string {
  return truncateKnownLabelsByStrategy(value, allLabels, currentLabel, "frontmatter-short-value");
}

export function compareLabelMatches(left: LabelBlockMatch, right: LabelBlockMatch): number {
  if (left.lineIndex !== right.lineIndex) {
    return left.lineIndex - right.lineIndex;
  }

  if (left.columnIndex !== right.columnIndex) {
    return left.columnIndex - right.columnIndex;
  }

  return left.priority - right.priority;
}
