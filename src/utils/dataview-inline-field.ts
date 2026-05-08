export const DATAVIEW_INLINE_FIELD_KEY_PATTERN = "[\\p{L}\\p{N}_-]+";

export function createDataviewInlineFieldRegex(flags = "gu"): RegExp {
  return new RegExp(`\\[(${DATAVIEW_INLINE_FIELD_KEY_PATTERN})::((?:<%[\\s\\S]*?%>|[^\\]])*)\\]`, flags);
}

export function createDataviewInlineFieldPresenceRegex(flags = "u"): RegExp {
  return new RegExp(`\\[${DATAVIEW_INLINE_FIELD_KEY_PATTERN}::(?:<%[\\s\\S]*?%>|[^\\]])*\\]`, flags);
}

export function extractDataviewInlineFieldNames(content: string): string[] {
  return Array.from(content.matchAll(createDataviewInlineFieldRegex("gu")), (match) => match[1]?.trim() ?? "")
    .filter((fieldName) => fieldName.length > 0);
}

export function hasDataviewInlineField(content: string): boolean {
  return createDataviewInlineFieldPresenceRegex("u").test(content);
}
