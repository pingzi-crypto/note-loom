export function stripTemplateRuntimeBlocks(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/<%[\s\S]*?%>/g, "");
}
