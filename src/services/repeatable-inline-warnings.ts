export interface RepeatableInlineWarningEntry {
  entryText: string;
  fields: Map<string, string>;
  schemaFieldNames: string[];
  sequentialPartCount?: number;
  sequentialTargetCount?: number;
  droppedFragments?: string[];
}

function formatEntryLabelForWarning(entry: RepeatableInlineWarningEntry, rowNumber: number): string {
  const label = entry.entryText.trim();
  return label ? `第 ${rowNumber} 条（${label}）` : `第 ${rowNumber} 条`;
}

export function buildRepeatableInlineEntryWarnings(
  entry: RepeatableInlineWarningEntry,
  rowNumber: number
): string[] {
  const label = formatEntryLabelForWarning(entry, rowNumber);
  const warnings: string[] = [];

  if ((entry.droppedFragments?.length ?? 0) > 0) {
    warnings.push(
      `${label}存在未标明字段名称的片段，已过滤：${entry.droppedFragments!.join("，")}`
    );
  }

  if (
    entry.sequentialPartCount !== undefined &&
    entry.sequentialTargetCount !== undefined
  ) {
    if (entry.sequentialPartCount > entry.sequentialTargetCount) {
      warnings.push(
        `${label}按分隔符拆出 ${entry.sequentialPartCount} 段，当前模板结构需要 ${entry.sequentialTargetCount} 个字段；多出的内容已合并到最后一个字段，请复核字段数量是否匹配`
      );
    } else if (
      entry.sequentialPartCount < entry.sequentialTargetCount &&
      entry.schemaFieldNames.some((fieldName) => (entry.fields.get(fieldName) ?? "").trim().length === 0)
    ) {
      warnings.push(
        `${label}按分隔符拆出 ${entry.sequentialPartCount} 段，当前模板结构需要 ${entry.sequentialTargetCount} 个字段；未匹配到的字段已留空`
      );
    }
  }

  return warnings;
}
