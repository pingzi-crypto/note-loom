import {
  buildRuntimeReviewChecklist,
  hasBlockingRuntimeRisk,
  hasManualReviewRuntimeRisk,
  requiresExplicitRuntimeAcceptance,
  type TemplateRuntimeAnalysis,
  type TemplateRuntimeChecklistKey,
  type TemplateRuntimeRiskLevel
} from "./template-runtime-analysis-service";

export interface TemplateRuntimeGateState {
  level: TemplateRuntimeRiskLevel;
  hasBlockingRisk: boolean;
  hasManualReviewRisk: boolean;
  requiresExplicitAcceptance: boolean;
  reviewChecklist: TemplateRuntimeChecklistKey[];
  hasDetails: boolean;
}

export interface TemplateRuntimeGateOptions {
  includePaths?: string[];
  unresolvedIncludes?: string[];
}

export function buildTemplateRuntimeGateState(
  analysis: TemplateRuntimeAnalysis,
  options?: TemplateRuntimeGateOptions
): TemplateRuntimeGateState {
  const includePaths = options?.includePaths ?? [];
  const unresolvedIncludes = options?.unresolvedIncludes ?? [];
  const hasUnresolvedIncludes = unresolvedIncludes.length > 0;
  const hasBlockingRisk = hasBlockingRuntimeRisk(analysis) || hasUnresolvedIncludes;
  const hasManualReviewRisk = hasManualReviewRuntimeRisk(analysis) || hasUnresolvedIncludes;
  const requiresExplicitAcceptance = requiresExplicitRuntimeAcceptance(analysis, {
    hasUnresolvedIncludes
  });
  const reviewChecklist = buildRuntimeReviewChecklist(analysis, {
    hasUnresolvedIncludes
  });
  const hasDetails =
    includePaths.length > 0 ||
    hasUnresolvedIncludes ||
    analysis.flags.length > 0 ||
    reviewChecklist.length > 0;

  return {
    level: hasBlockingRisk ? "dynamic" : hasManualReviewRisk ? "assisted" : "static",
    hasBlockingRisk,
    hasManualReviewRisk,
    requiresExplicitAcceptance,
    reviewChecklist,
    hasDetails
  };
}
