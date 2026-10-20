/** The stored label, then its sentence-case and title-case forms ("MAIN ROOM" -> "Main room", "Main Room"). */
export function labelForms(label: string): string[] {
  const s = label.trim().replace(/\s+/g, ' ');
  const lower = s.toLowerCase();
  const sentence = lower.charAt(0).toUpperCase() + lower.slice(1);
  const title = lower.replace(/(^|\s)(\p{L})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase());
  return [...new Set([label, s, sentence, title])];
}
