import type { FieldMatchResult } from "../types/match";

export type RunFieldDecisionKind = "manual" | "semantic" | "matched" | "unmatched";

export interface RunFieldDecision {
  fieldName: string;
  kind: RunFieldDecisionKind;
  rawValue: string;
  resolvedValue: string;
  changed: boolean;
}

export interface RunDecisionSummary {
  manualCount: number;
  semanticCount: number;
  matchedCount: number;
  unmatchedCount: number;
  changedCount: number;
  fields: RunFieldDecision[];
}

function cloneValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

export class TemplateRunDiffService {
  build(rawResults: FieldMatchResult[], resolvedResults: FieldMatchResult[]): RunDecisionSummary {
    const resolvedMap = new Map(resolvedResults.map((result) => [result.fieldName, result] as const));
    const fields = rawResults.map((raw) => {
      const resolved = resolvedMap.get(raw.fieldName) ?? raw;
      const rawValue = cloneValue(raw.finalValue);
      const resolvedValue = cloneValue(resolved.finalValue);
      const changed =
        rawValue !== resolvedValue ||
        raw.enabled !== resolved.enabled ||
        raw.matched !== resolved.matched;

      let kind: RunFieldDecisionKind = "unmatched";
      if (resolved.edited) {
        kind = "manual";
      } else if (changed && (resolved.matched || resolvedValue.length > 0)) {
        kind = "semantic";
      } else if (raw.matched || rawValue.length > 0) {
        kind = "matched";
      }

      return {
        fieldName: raw.fieldName,
        kind,
        rawValue,
        resolvedValue,
        changed
      };
    });

    return {
      manualCount: fields.filter((field) => field.kind === "manual").length,
      semanticCount: fields.filter((field) => field.kind === "semantic").length,
      matchedCount: fields.filter((field) => field.kind === "matched").length,
      unmatchedCount: fields.filter((field) => field.kind === "unmatched").length,
      changedCount: fields.filter((field) => field.changed).length,
      fields
    };
  }
}
