import {
  type SectionRuleContext,
  type SectionRuleMatcherTarget,
  selectMatchingSectionRules
} from "./template-section-rule-match";

export function foldMatchingSectionRules<TSeed, TRule extends SectionRuleMatcherTarget>(
  context: SectionRuleContext,
  rules: readonly TRule[],
  seed: TSeed,
  reducer: (accumulator: TSeed, rule: TRule) => TSeed
): TSeed {
  const matchedRules = selectMatchingSectionRules(context, rules);
  return matchedRules.reduce((accumulator, rule) => reducer(accumulator, rule), seed);
}
