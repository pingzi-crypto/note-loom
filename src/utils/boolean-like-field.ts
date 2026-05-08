import type { TemplateFieldConfig } from "../types/template";

function normalizeBooleanOption(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, "")
    .replace(/[：:，,。.;；、|｜/\\\-—–~·`'"“”‘’()[\]{}]/g, "");
}

const YES_VALUES = new Set(["yes", "y", "true", "1", "是", "已", "有", "完成", "已完成"]);
const NO_VALUES = new Set(["no", "n", "false", "0", "否", "未", "无", "未完成", "不完成"]);

export function isBooleanLikeOptionSet(options: string[] | undefined): boolean {
  const normalized = new Set((options ?? []).map((option) => normalizeBooleanOption(option)).filter(Boolean));
  if (normalized.size < 2 || normalized.size > 3) {
    return false;
  }

  const hasYes = Array.from(normalized).some((option) => YES_VALUES.has(option));
  const hasNo = Array.from(normalized).some((option) => NO_VALUES.has(option));
  return hasYes && hasNo;
}

export function isBooleanLikeField(field: TemplateFieldConfig): boolean {
  return field.normalizerKey === "yes_no" || isBooleanLikeOptionSet(field.checkboxOptions);
}
