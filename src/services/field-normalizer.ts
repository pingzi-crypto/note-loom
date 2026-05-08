import type { TemplateFieldConfig } from "../types/template";
import type { FieldStructureDescriptor } from "../types/template-structure-descriptor";
import { normalizeGenericFieldValue } from "./generic-field-normalizer-profile-service";

export type FieldNormalizerInput = TemplateFieldConfig | FieldStructureDescriptor;

function containsAny(source: string, patterns: string[]): boolean {
  return patterns.some((pattern) => source.includes(pattern));
}

function normalizeDate(value: string): string {
  const match = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return match?.[1] ?? value.trim();
}

function normalizeYesNo(value: string): string {
  const text = value.trim();

  if (containsAny(text, ["未", "没有", "未触发", "未接管", "no", "No"])) {
    return "no";
  }

  if (containsAny(text, ["是", "已", "有", "触发", "接管", "yes", "Yes"])) {
    return "yes";
  }

  return text;
}

function getNormalizerKey(field: FieldNormalizerInput): string | undefined {
  return field.normalizerKey;
}

function hasFieldFeature(field: FieldNormalizerInput, feature: FieldStructureDescriptor["features"][number]): boolean {
  return "features" in field && field.features.includes(feature);
}

export class FieldNormalizer {
  normalize(field: FieldNormalizerInput, value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    const numericValue = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*[。.]$/)?.[1];
    if (numericValue) {
      return numericValue;
    }

    const normalizerKey = getNormalizerKey(field);
    switch (normalizerKey) {
      case "date":
        return normalizeDate(trimmed);
      case "yes_no":
        return normalizeYesNo(trimmed);
      default:
        return normalizeGenericFieldValue(normalizerKey, trimmed) ?? trimmed;
    }
  }

  inferNormalizedValue(field: FieldNormalizerInput, sourceText: string): string {
    const text = sourceText.trim();
    if (!text) {
      return "";
    }

    const normalizerKey = getNormalizerKey(field);
    if (normalizerKey === "yes_no" || hasFieldFeature(field, "boolean_like_options")) {
      return "";
    }

    return normalizeGenericFieldValue(normalizerKey, text) ?? "";
  }
}
