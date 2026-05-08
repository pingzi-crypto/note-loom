export type MatchReason = "label" | "alias" | "pattern" | "unmatched";

export interface FieldMatchResult {
  fieldName: string;
  enabled: boolean;
  matched: boolean;
  candidateValue: string;
  finalValue: string;
  edited: boolean;
  matchReason: MatchReason;
  matchedLabel?: string;
}
