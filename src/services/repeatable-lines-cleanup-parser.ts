import {
  prefixRepeatableBullet,
  runRepeatableEntryParser,
  type RepeatableEntryParseResult
} from "./repeatable-entry-parser";

export type RepeatableLinesCleanupParseResult = RepeatableEntryParseResult;

export interface RepeatableLinesCleanupParseContext {
  shouldStopAtLine?: (line: string) => boolean;
}

function normalizeLine(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .trim();
}

export class RepeatableLinesCleanupParser {
  parse(content: string, context: RepeatableLinesCleanupParseContext = {}): RepeatableLinesCleanupParseResult {
    const boundedContent = content
      .split(/\r?\n/)
      .reduce<{ lines: string[]; stopped: boolean }>((state, line) => {
        if (state.stopped) {
          return state;
        }

        if (context.shouldStopAtLine?.(line)) {
          return { ...state, stopped: true };
        }

        state.lines.push(line);
        return state;
      }, { lines: [], stopped: false })
      .lines
      .join("\n");
    return runRepeatableEntryParser(boundedContent, {
      parseLine: (line) => prefixRepeatableBullet(normalizeLine(line))
    });
  }
}
