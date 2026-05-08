import {
  MANAGED_INDEX_ENTRY_SOURCE_LABEL,
  MANAGED_INDEX_ENTRY_SOURCE_LABEL_ALIASES
} from "./generation-protocol";

export interface ManagedIndexDisplayEntry {
  createdNoteBasename: string;
  sourceNoteBasename: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MANAGED_INDEX_ENTRY_SOURCE_LABEL_PATTERN = MANAGED_INDEX_ENTRY_SOURCE_LABEL_ALIASES
  .map(escapeRegExp)
  .join("|");

const MANAGED_INDEX_ENTRY_PATTERN =
  new RegExp(
    `^\\s*-\\s+\\[\\[([^\\]]+)\\]\\]\\s+\\|\\s+(?:${MANAGED_INDEX_ENTRY_SOURCE_LABEL_PATTERN})\\s+\\[\\[([^\\]]+)\\]\\]\\s*$`,
    "u"
  );

export function parseManagedIndexEntryLine(line: string): ManagedIndexDisplayEntry | null {
  const match = line.match(MANAGED_INDEX_ENTRY_PATTERN);
  const createdNoteBasename = match?.[1]?.trim() ?? "";
  const sourceNoteBasename = match?.[2]?.trim() ?? "";

  if (!createdNoteBasename || !sourceNoteBasename) {
    return null;
  }

  return {
    createdNoteBasename,
    sourceNoteBasename
  };
}

function buildManagedIndexEntry(entry: ManagedIndexDisplayEntry): string {
  return `- [[${entry.createdNoteBasename}]] | ${MANAGED_INDEX_ENTRY_SOURCE_LABEL} [[${entry.sourceNoteBasename}]]`;
}

export function rewriteManagedIndexContent(
  currentContent: string,
  options: {
    entryToAdd?: ManagedIndexDisplayEntry;
    entryToRemove?: ManagedIndexDisplayEntry;
    doesManagedEntryTargetExist?: (entry: ManagedIndexDisplayEntry) => boolean;
  }
): string {
  const lines = currentContent.length === 0 ? [] : currentContent.split(/\r?\n/);
  const nextLines: string[] = [];

  for (const line of lines) {
    const parsed = parseManagedIndexEntryLine(line);
    if (!parsed) {
      nextLines.push(line);
      continue;
    }

    const shouldRemove =
      options.entryToRemove &&
      parsed.createdNoteBasename === options.entryToRemove.createdNoteBasename &&
      parsed.sourceNoteBasename === options.entryToRemove.sourceNoteBasename;

    if (shouldRemove) {
      continue;
    }

    const isDuplicateOfEntryToAdd =
      options.entryToAdd &&
      parsed.createdNoteBasename === options.entryToAdd.createdNoteBasename &&
      parsed.sourceNoteBasename === options.entryToAdd.sourceNoteBasename;

    if (isDuplicateOfEntryToAdd) {
      continue;
    }

    if (options.doesManagedEntryTargetExist && !options.doesManagedEntryTargetExist(parsed)) {
      continue;
    }

    nextLines.push(line);
  }

  while (nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() === "") {
    nextLines.pop();
  }

  if (options.entryToAdd) {
    nextLines.push(buildManagedIndexEntry(options.entryToAdd));
  }

  return nextLines.length > 0 ? `${nextLines.join("\n")}\n` : "";
}
