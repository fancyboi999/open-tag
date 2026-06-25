// Date/time formatting helpers (no React deps, so they're unit-testable in isolation).
//
// fmtTime (store.tsx) is deliberately time-of-day only — it's right for message and reminder
// timestamps where the date is implied by context. fmtDateTime adds the calendar date for places
// that span days: a member's workspace join time and an agent's creation date.
export const fmtDateTime = (iso?: string): string => {
  try {
    return iso
      ? new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      : "";
  } catch { return ""; }
};
