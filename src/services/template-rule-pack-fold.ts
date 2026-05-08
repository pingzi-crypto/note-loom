import type { TemplateRulePackOverrideMode } from "../types/template";

type OverrideWithMode = {
  mode?: TemplateRulePackOverrideMode;
};

type FoldHandlers<TOverride extends OverrideWithMode, TState> = {
  onDisable: (state: TState, override: TOverride) => TState;
  onReplace: (state: TState, override: TOverride) => TState;
  onMerge: (state: TState, override: TOverride) => TState;
};

export interface RulePackOverrideFoldState<TValue> {
  disabled: boolean;
  value: TValue;
}

type OverrideStateFoldHandlers<TOverride extends OverrideWithMode, TValue> = {
  onDisable?: (value: TValue, override: TOverride) => TValue;
  onReplace: (value: TValue, override: TOverride) => TValue;
  onMerge: (value: TValue, override: TOverride) => TValue;
};

export function foldRulePackOverrides<TOverride extends OverrideWithMode, TState>(
  overrides: readonly TOverride[],
  initialState: TState,
  handlers: FoldHandlers<TOverride, TState>
): TState {
  return overrides.reduce((state, override) => {
    if (override.mode === "disable") {
      return handlers.onDisable(state, override);
    }

    if (override.mode === "replace") {
      return handlers.onReplace(state, override);
    }

    return handlers.onMerge(state, override);
  }, initialState);
}

export function foldRulePackOverrideState<TOverride extends OverrideWithMode, TValue>(
  overrides: readonly TOverride[],
  initialValue: TValue,
  handlers: OverrideStateFoldHandlers<TOverride, TValue>
): RulePackOverrideFoldState<TValue> {
  const initialState: RulePackOverrideFoldState<TValue> = {
    disabled: false,
    value: initialValue
  };

  return foldRulePackOverrides(
    overrides,
    initialState,
    {
      onDisable: (state, override) => ({
        disabled: true,
        value: handlers.onDisable ? handlers.onDisable(state.value, override) : state.value
      }),
      onReplace: (state, override) => ({
        disabled: false,
        value: handlers.onReplace(state.value, override)
      }),
      onMerge: (state, override) => ({
        disabled: false,
        value: handlers.onMerge(state.value, override)
      })
    }
  );
}
