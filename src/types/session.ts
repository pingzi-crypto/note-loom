import type { FieldMatchResult } from "./match";

export interface GenerateSessionState {
  sourceNotePath: string;
  sourceNoteBasename: string;
  templateId: string;
  outputPath: string;
  filename: string;
  writeIndexEntry: boolean;
  openGeneratedNote: boolean;
  showUnmatchedOnly: boolean;
  fieldResults: FieldMatchResult[];
}
