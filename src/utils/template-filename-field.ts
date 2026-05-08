export interface FilenameFieldCandidate {
  name: string;
  aliases?: string[];
}

export function resolveTemplateFilenameField(
  configuredFieldName: string | undefined,
  fields: FilenameFieldCandidate[]
): string {
  const normalizedFieldName = configuredFieldName?.trim() ?? "";
  if (normalizedFieldName && fields.some((field) => field.name === normalizedFieldName)) {
    return normalizedFieldName;
  }

  const aliasedField = fields.find((field) =>
    (field.aliases ?? []).some((alias) => alias.trim() === normalizedFieldName)
  );
  if (normalizedFieldName && aliasedField) {
    return aliasedField.name;
  }

  return fields[0]?.name ?? "";
}
