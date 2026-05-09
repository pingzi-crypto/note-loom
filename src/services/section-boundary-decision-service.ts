import type { TemplateSectionBoundaryPolicyConfig } from "../types/template";
import {
  detectFirstStructuralLabelStart,
  escapeRegExp,
  hasStructuralLabelBoundaryEvidence,
  normalizeInlineLabelValue,
  startsWithNaturalLanguageContinuation
} from "../utils/label-block";

export interface SectionBoundaryRule<TSource = unknown> {
  labels: string[];
  source?: TSource;
  validateCandidate?: (label: string, value: string, rule: SectionBoundaryRule<TSource>) => boolean;
}

export interface SectionBoundaryLineDecision<TSource = unknown> {
  matched: boolean;
  label?: string;
  value?: string;
  rule?: SectionBoundaryRule<TSource>;
}

export function findSectionBoundaryRule<TSource>(
  label: string,
  rules: Array<SectionBoundaryRule<TSource>>
): SectionBoundaryRule<TSource> | undefined {
  const normalizedLabel = label.trim().toLocaleLowerCase();
  return rules.find((rule) =>
    rule.labels.some((candidate) => candidate.trim().toLocaleLowerCase() === normalizedLabel)
  );
}

export function isValidSectionBoundaryCandidate<TSource>(
  label: string,
  value: string,
  rules: Array<SectionBoundaryRule<TSource>>
): boolean {
  const rule = findSectionBoundaryRule(label, rules);
  if (!rule) {
    return true;
  }

  return rule.validateCandidate?.(label, value, rule) ?? true;
}

export function decideSectionBoundaryLine<TSource>(
  line: string,
  labels: string[],
  rules: Array<SectionBoundaryRule<TSource>>,
  policy: TemplateSectionBoundaryPolicyConfig = {}
): SectionBoundaryLineDecision<TSource> {
  const match = detectFirstStructuralLabelStart(line, labels, {
    allowQuotePrefix: true,
    allowTightLabel: policy.allowTightLabels ?? false,
    allowMarkdownHeading: policy.allowMarkdownHeadings ?? true
  });
  if (!match) {
    return { matched: false };
  }

  const rule = findSectionBoundaryRule(match.label, rules);
  const matched = isValidSectionBoundaryCandidate(match.label, match.value, rules);
  return {
    matched,
    label: match.label,
    value: match.value,
    rule
  };
}

export function truncateValueAtSectionBoundary<TSource>(
  value: string,
  stopLabels: string[],
  currentLabel: string,
  rules: Array<SectionBoundaryRule<TSource>> = [],
  options: { allowTightStructuralStops?: boolean } = {}
): string {
  const currentLabels = new Set(
    [currentLabel]
      .flat()
      .map((label) => label.trim())
      .filter(Boolean)
  );
  const otherLabels = stopLabels
    .map((label) => label.trim())
    .filter((label) => label && !currentLabels.has(label))
    .sort((left, right) => right.length - left.length);
  let endIndex = value.length;

  otherLabels.forEach((label) => {
    const structuralPattern = new RegExp(
      `(?:^|\\n|[\\s，,。；;、])(${escapeRegExp(label)})\\s*([:：,，;；、|｜/\\\\\\-—–~·]+|[。．.]+|\\s+)`,
      "gu"
    );
    let structuralMatch: RegExpExecArray | null;
    while ((structuralMatch = structuralPattern.exec(value)) !== null) {
      const prefix = structuralMatch[0] ?? "";
      const matchedLabel = structuralMatch[1] ?? label;
      const delimiter = structuralMatch[2] ?? "";
      const stopRule = findSectionBoundaryRule(label, rules);
      if (!hasStructuralLabelBoundaryEvidence({
        label,
        delimiter,
        hasKnownStructuralRule: Boolean(stopRule)
      })) {
        continue;
      }

      const labelOffset = prefix.lastIndexOf(matchedLabel);
      const labelStart = structuralMatch.index + Math.max(labelOffset, 0);
      const candidateValue = value.slice(structuralPattern.lastIndex).trimStart();
      const isWhitespaceDelimiter = /^\s+$/u.test(delimiter);
      if (isWhitespaceDelimiter && startsWithNaturalLanguageContinuation(candidateValue)) {
        continue;
      }

      if (isValidSectionBoundaryCandidate(label, candidateValue, rules)) {
        endIndex = Math.min(endIndex, labelStart);
      }
    }

    const stopRule = findSectionBoundaryRule(label, rules);
    if (options.allowTightStructuralStops === true && stopRule) {
      const tightPattern = new RegExp(escapeRegExp(label), "gu");
      let tightMatch: RegExpExecArray | null;
      while ((tightMatch = tightPattern.exec(value)) !== null) {
        if (tightMatch.index <= 0) {
          continue;
        }

        const candidateValue = value
          .slice(tightMatch.index + label.length)
          .replace(/^\s*[:：,，;；、|｜/\\\-—–~·]*\s*/u, "")
          .trimStart();
        const originalRemainder = value.slice(tightMatch.index + label.length);
        if (/^\s+/u.test(originalRemainder) && startsWithNaturalLanguageContinuation(candidateValue)) {
          continue;
        }

        if (isValidSectionBoundaryCandidate(label, candidateValue, rules)) {
          endIndex = Math.min(endIndex, tightMatch.index);
        }
      }
    }

    if (
      options.allowTightStructuralStops === true &&
      label.length >= 2 &&
      /\p{Script=Han}/u.test(label)
    ) {
      const attachedExplicitPattern = new RegExp(`${escapeRegExp(label)}\\s*[:：]`, "gu");
      let attachedMatch: RegExpExecArray | null;
      while ((attachedMatch = attachedExplicitPattern.exec(value)) !== null) {
        if (attachedMatch.index <= 0) {
          continue;
        }

        const candidateValue = value.slice(attachedExplicitPattern.lastIndex).trimStart();
        if (isValidSectionBoundaryCandidate(label, candidateValue, rules)) {
          endIndex = Math.min(endIndex, attachedMatch.index);
        }
      }
    }

    const headingPattern = new RegExp(`(?:^|\\n)\\s*#{1,6}\\s+${escapeRegExp(label)}\\s*(?:\\n|$)`, "u");
    const headingMatch = value.match(headingPattern);
    if (
      headingMatch?.index !== undefined &&
      isValidSectionBoundaryCandidate(label, value.slice(headingMatch.index + headingMatch[0].length), rules)
    ) {
      endIndex = Math.min(endIndex, headingMatch.index);
    }
  });

  const truncatedValue = value.slice(0, endIndex);
  if (endIndex < value.length && /[（([【{「『“"‘']$/u.test(truncatedValue.trimEnd())) {
    return normalizeInlineLabelValue(value);
  }

  return normalizeInlineLabelValue(truncatedValue);
}
