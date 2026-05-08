export interface RepeatableInlineLeadingTimeRangeMatch {
  start: string;
  end: string;
  remainder: string;
}

export interface RepeatableInlineEmbeddedTimeMatch {
  leadingText: string;
  start: string;
  end: string;
  remainder: string;
}

export function matchLeadingTimeRangeEntry(line: string): RepeatableInlineLeadingTimeRangeMatch | undefined {
  const match = line.match(
    /^(\d{1,2}[:：]\d{2})\s*(?:-|~|–|—|至|到)\s*(\d{1,2}[:：]\d{2})(?:\s+|[，,；;、])?([\s\S]*)$/u
  );
  return match
    ? {
        start: match[1] ?? "",
        end: match[2] ?? "",
        remainder: match[3] ?? ""
      }
    : undefined;
}

export function matchEmbeddedTimeRangeEntry(line: string): RepeatableInlineEmbeddedTimeMatch | undefined {
  const match = line.match(
    /^(.+?)\s+(\d{1,2}[:：]\d{2})\s*(?:-|~|–|—|至|到)\s*(\d{1,2}[:：]\d{2})(?:\s+|[，,；;、])?([\s\S]*)$/u
  );
  return match
    ? {
        leadingText: match[1] ?? "",
        start: match[2] ?? "",
        end: match[3] ?? "",
        remainder: match[4] ?? ""
      }
    : undefined;
}

export function matchEmbeddedTimePairEntry(line: string): RepeatableInlineEmbeddedTimeMatch | undefined {
  const match = line.match(
    /^(.+?)[，,。；;、\s]+(\d{1,2}[:：]\d{2})[，,。；;、\s]+(\d{1,2}[:：]\d{2})(?:\s+|[，,；;、])?([\s\S]*)$/u
  );
  return match
    ? {
        leadingText: match[1] ?? "",
        start: match[2] ?? "",
        end: match[3] ?? "",
        remainder: match[4] ?? ""
      }
    : undefined;
}
