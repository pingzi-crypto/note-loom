function trimTrailingDotsAndSpaces(value: string): string {
  return value.replace(/[. ]+$/g, "").trim();
}

const INVALID_FILENAME_PATTERN = new RegExp(
  `[<>:"/\\\\|?*${String.fromCharCode(0)}-${String.fromCharCode(31)}]`,
  "g"
);

export function sanitizeFilename(input: string): string {
  const sanitized = input
    .replace(INVALID_FILENAME_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();

  const trimmed = trimTrailingDotsAndSpaces(sanitized);
  return trimmed.slice(0, 180);
}

export function fallbackFilename(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `Untitled-${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}
