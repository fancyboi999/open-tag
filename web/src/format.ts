// Date/time formatting helpers (no React deps, so they're unit-testable in isolation).
export const fmtDateTime = (iso?: string): string => {
  try {
    return iso
      ? new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      : "";
  } catch { return ""; }
};

// True when two ISO timestamps fall on the same calendar day in the browser's local timezone.
export const isSameLocalDay = (aIso?: string, bIso?: string): boolean => {
  if (!aIso || !bIso) return false;
  const a = new Date(aIso), b = new Date(bIso);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
};

// Label for a date-divider inserted between messages on different calendar days: "Today"/"Yesterday"
// for the two most recent days, otherwise a localized weekday + date (year included once it's not
// the current year). `lang` drives Intl.DateTimeFormat so the divider matches the active UI language.
export const fmtDateDivider = (iso: string, lang: string, todayLabel: string, yesterdayLabel: string): string => {
  try {
    const now = new Date();
    if (isSameLocalDay(iso, now.toISOString())) return todayLabel;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (isSameLocalDay(iso, yesterday.toISOString())) return yesterdayLabel;
    const d = new Date(iso);
    const sameYear = d.getFullYear() === now.getFullYear();
    return new Intl.DateTimeFormat(lang, sameYear
      ? { month: "long", day: "numeric", weekday: "long" }
      : { year: "numeric", month: "long", day: "numeric", weekday: "long" }
    ).format(d);
  } catch { return ""; }
};
