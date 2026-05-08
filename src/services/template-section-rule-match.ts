import type { TemplateSectionKind } from "../types/template";
import { normalizeSectionHint } from "./template-section-structure-hints";

export type SectionRuleContext = {
  title: string;
  kind: TemplateSectionKind;
};

export type SectionRuleMatcherTarget = {
  sectionTitle?: string;
  sectionKind?: TemplateSectionKind;
};

export function matchesSectionRuleTarget(
  context: SectionRuleContext,
  target: SectionRuleMatcherTarget
): boolean {
  const titleMatches =
    !target.sectionTitle || normalizeSectionHint(target.sectionTitle) === normalizeSectionHint(context.title);
  const kindMatches = !target.sectionKind || target.sectionKind === context.kind;
  return titleMatches && kindMatches;
}

export function selectMatchingSectionRules<T extends SectionRuleMatcherTarget>(
  context: SectionRuleContext,
  rules: readonly T[]
): T[] {
  return rules.filter((rule) => matchesSectionRuleTarget(context, rule));
}
