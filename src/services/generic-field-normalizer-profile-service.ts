export interface GenericFieldNormalizerProfile {
  key: string;
  profileId: "generic_enum";
  normalize: (value: string) => string;
}

function containsAny(source: string, patterns: string[]): boolean {
  return patterns.some((pattern) => source.includes(pattern));
}

function normalizeLowMediumHigh(value: string): string {
  const text = value.trim();

  if (containsAny(text, ["高难度", "高精力", "高"])) {
    return "high";
  }

  if (containsAny(text, ["中难度", "中等", "中"])) {
    return "medium";
  }

  if (containsAny(text, ["低难度", "低精力", "低"])) {
    return "low";
  }

  return text;
}

const GENERIC_FIELD_NORMALIZER_PROFILES: GenericFieldNormalizerProfile[] = [
  {
    key: "level_low_medium_high",
    profileId: "generic_enum",
    normalize: normalizeLowMediumHigh
  }
];

const genericFieldNormalizerProfileMap = new Map(
  GENERIC_FIELD_NORMALIZER_PROFILES.map((profile) => [profile.key, profile] as const)
);

export function listGenericFieldNormalizerProfiles(): GenericFieldNormalizerProfile[] {
  return GENERIC_FIELD_NORMALIZER_PROFILES.map((profile) => ({ ...profile }));
}

export function resolveGenericFieldNormalizerProfile(
  normalizerKey: string | undefined
): GenericFieldNormalizerProfile | undefined {
  const key = normalizerKey?.trim();
  return key ? genericFieldNormalizerProfileMap.get(key) : undefined;
}

export function normalizeGenericFieldValue(
  normalizerKey: string | undefined,
  value: string
): string | undefined {
  return resolveGenericFieldNormalizerProfile(normalizerKey)?.normalize(value);
}
