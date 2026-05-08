import type { TemplateStructureDescriptor } from "../types/template-structure-descriptor";

export type TemplateRuntimeRiskLevel = "static" | "assisted" | "dynamic";
export type TemplateRuntimeRiskSeverity = "info" | "warn" | "high";
export type TemplateRuntimeRiskKey =
  | "templater_basic"
  | "templater_prompt"
  | "templater_file_ops"
  | "templater_include"
  | "templater_user_function"
  | "external_runtime"
  | "dataview_query"
  | "dataviewjs"
  | "dataview_custom_view"
  | "task_metadata";

export interface TemplateRuntimeRiskFlag {
  key: TemplateRuntimeRiskKey;
  severity: TemplateRuntimeRiskSeverity;
}

export interface TemplateRuntimeAnalysis {
  level: TemplateRuntimeRiskLevel;
  flags: TemplateRuntimeRiskFlag[];
}

export type TemplateRuntimeChecklistKey =
  | "prompt_answers"
  | "file_destination"
  | "include_fragments"
  | "custom_script_output"
  | "external_data"
  | "dataview_views"
  | "task_metadata";

export function hasBlockingRuntimeRisk(analysis: TemplateRuntimeAnalysis): boolean {
  return analysis.flags.some((flag) => flag.severity === "high");
}

export function hasManualReviewRuntimeRisk(analysis: TemplateRuntimeAnalysis): boolean {
  return analysis.flags.some((flag) => flag.severity === "warn" || flag.severity === "high");
}

export function requiresExplicitRuntimeAcceptance(
  analysis: TemplateRuntimeAnalysis,
  options?: { hasUnresolvedIncludes?: boolean }
): boolean {
  return (
    hasBlockingRuntimeRisk(analysis) ||
    analysis.flags.some((flag) => EXPLICIT_ACCEPTANCE_WARN_FLAGS.has(flag.key)) ||
    Boolean(options?.hasUnresolvedIncludes)
  );
}

export function buildRuntimeReviewChecklist(
  analysis: TemplateRuntimeAnalysis,
  options?: { hasUnresolvedIncludes?: boolean }
): TemplateRuntimeChecklistKey[] {
  const items = new Set<TemplateRuntimeChecklistKey>();

  analysis.flags.forEach((flag) => {
    switch (flag.key) {
      case "templater_prompt":
        items.add("prompt_answers");
        break;
      case "templater_file_ops":
        items.add("file_destination");
        break;
      case "templater_include":
        items.add("include_fragments");
        break;
      case "templater_user_function":
        items.add("custom_script_output");
        break;
      case "external_runtime":
        items.add("external_data");
        break;
      case "dataviewjs":
      case "dataview_custom_view":
        items.add("dataview_views");
        break;
      case "task_metadata":
        items.add("task_metadata");
        break;
      default:
        break;
    }
  });

  if (options?.hasUnresolvedIncludes) {
    items.add("include_fragments");
  }

  return Array.from(items);
}

interface RiskRule {
  key: TemplateRuntimeRiskKey;
  severity: TemplateRuntimeRiskSeverity;
  test: (content: string) => boolean;
}

const EXPLICIT_ACCEPTANCE_WARN_FLAGS = new Set<TemplateRuntimeRiskKey>([
  "templater_user_function",
  "dataviewjs",
  "dataview_custom_view"
]);

const RISK_RULES: RiskRule[] = [
  {
    key: "templater_basic",
    severity: "info",
    test: (content) => /<%[-_=]?[\s\S]+?%>/.test(content)
  },
  {
    key: "templater_prompt",
    severity: "high",
    test: (content) => /\btp\.system\.(prompt|suggester|multi_suggester)\b/.test(content)
  },
  {
    key: "templater_file_ops",
    severity: "high",
    test: (content) => /\btp\.file\.(move|rename|create_new|copy)\b/.test(content)
  },
  {
    key: "templater_include",
    severity: "warn",
    test: (content) => /\btp\.file\.include\b/.test(content)
  },
  {
    key: "templater_user_function",
    severity: "warn",
    test: (content) => /\btp\.user\.[A-Za-z0-9_]+\b/.test(content)
  },
  {
    key: "external_runtime",
    severity: "high",
    test: (content) => /\b(fetch|requestUrl|XMLHttpRequest|axios)\s*\(/.test(content)
  },
  {
    key: "dataview_query",
    severity: "info",
    test: (content) => /```dataview\b/i.test(content)
  },
  {
    key: "dataviewjs",
    severity: "warn",
    test: (content) => /```dataviewjs\b/i.test(content)
  },
  {
    key: "dataview_custom_view",
    severity: "warn",
    test: (content) => /\bdv\.view\s*\(/.test(content)
  },
  {
    key: "task_metadata",
    severity: "warn",
    test: (content) =>
      /^\s*[-*]\s+\[[ xX]\].*(✅|➕|🛫|⏳|⌛|📅|🗓️)\s*\d{4}-\d{2}-\d{2}/m.test(content)
  }
];

function severityRank(severity: TemplateRuntimeRiskSeverity): number {
  switch (severity) {
    case "high":
      return 3;
    case "warn":
      return 2;
    default:
      return 1;
  }
}

function pushUniqueRiskFlag(flags: TemplateRuntimeRiskFlag[], flag: TemplateRuntimeRiskFlag): void {
  if (!flags.some((item) => item.key === flag.key)) {
    flags.push(flag);
  }
}

function collectDescriptorRiskFlags(
  descriptor: TemplateStructureDescriptor | undefined
): TemplateRuntimeRiskFlag[] {
  const flags: TemplateRuntimeRiskFlag[] = [];
  if (!descriptor) {
    return flags;
  }

  if (descriptor.sections.some((section) => section.features.includes("templater_code"))) {
    pushUniqueRiskFlag(flags, { key: "templater_basic", severity: "info" });
  }

  if (descriptor.sections.some((section) => section.features.includes("dataview_code"))) {
    pushUniqueRiskFlag(flags, { key: "dataview_query", severity: "info" });
  }

  return flags;
}

export class TemplateRuntimeAnalysisService {
  analyze(content: string, descriptor?: TemplateStructureDescriptor): TemplateRuntimeAnalysis {
    const flags = [
      ...RISK_RULES
      .filter((rule) => rule.test(content))
      .map<TemplateRuntimeRiskFlag>(({ key, severity }) => ({ key, severity })),
      ...collectDescriptorRiskFlags(descriptor)
    ]
      .reduce<TemplateRuntimeRiskFlag[]>((nextFlags, flag) => {
        pushUniqueRiskFlag(nextFlags, flag);
        return nextFlags;
      }, [])
      .sort((left, right) => severityRank(right.severity) - severityRank(left.severity));

    const hasHigh = flags.some((flag) => flag.severity === "high");
    const hasWarn = flags.some((flag) => flag.severity === "warn");

    return {
      level: hasHigh ? "dynamic" : hasWarn ? "assisted" : "static",
      flags
    };
  }
}
