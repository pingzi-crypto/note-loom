export const NOTE_LOOM_CREATED_BY = "note-loom";
export const LEGACY_TEMPLATE_EXTRACTOR_CREATED_BY = "template-extractor";
export const SOURCE_METADATA_CREATED_BY_VALUES = [
  NOTE_LOOM_CREATED_BY,
  LEGACY_TEMPLATE_EXTRACTOR_CREATED_BY
] as const;

export interface FrontmatterProtocolField {
  canonical: string;
  aliases: string[];
}

export const SOURCE_METADATA_FRONTMATTER_FIELDS = {
  sourceNote: {
    canonical: "source-note",
    aliases: ["source_note", "source-note"]
  },
  sourceTemplate: {
    canonical: "source-template",
    aliases: ["source_template", "source-template"]
  },
  createdBy: {
    canonical: "created-by",
    aliases: ["created_by", "created-by"]
  },
  createdAt: {
    canonical: "created-at",
    aliases: ["created_at", "created-at"]
  }
} as const satisfies Record<string, FrontmatterProtocolField>;

export const INDEX_METADATA_FRONTMATTER_FIELDS = {
  indexNote: {
    canonical: "index-note",
    aliases: ["index_note", "index-note"]
  }
} as const satisfies Record<string, FrontmatterProtocolField>;

export const MANAGED_INDEX_ENTRY_SOURCE_LABEL = "来源";
export const MANAGED_INDEX_ENTRY_SOURCE_LABEL_ALIASES = [MANAGED_INDEX_ENTRY_SOURCE_LABEL, "Source"] as const;
