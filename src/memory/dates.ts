// Resolves phrases like "last Tuesday", "3 November", "yesterday" into a [from, to)
// range so memory can fetch that day's chat. Pure function: `now` is injected so it
// is testable and the benchmark can pin "today".

export interface DateRange {
  from: string; // ISO, inclusive
  to: string; // ISO, exclusive
  label: string;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

function dayRange(d: Date, label: string): DateRange {
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const to = new Date(from.getTime() + 86_400_000);
  return { from: from.toISOString(), to: to.toISOString(), label };
}

export function resolveDate(text: string, now = new Date()): DateRange | null {
  const t = text.toLowerCase();
  const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000);

  if (/\btoday\b/.test(t)) return dayRange(now, "today");
  if (/\byesterday\b/.test(t)) return dayRange(day(-1), "yesterday");

  // "last tuesday" = most recent such weekday strictly before today (1..7 days back).
  const wd = t.match(new RegExp(`\\blast (${DAYS.join("|")})\\b`));
  if (wd) {
    const target = DAYS.indexOf(wd[1]);
    const back = ((now.getUTCDay() - target + 7) % 7) || 7;
    return dayRange(day(-back), `last ${wd[1]}`);
  }

  // "3 november" or "november 3"; assume the most recent past occurrence.
  const m =
    t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${MONTHS.join("|")})\\b`)) ??
    t.match(new RegExp(`\\b(${MONTHS.join("|")}) (\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (m) {
    const [dayNum, month] = /^\d/.test(m[1])
      ? [Number(m[1]), MONTHS.indexOf(m[2])]
      : [Number(m[2]), MONTHS.indexOf(m[1])];
    let year = now.getUTCFullYear();
    if (Date.UTC(year, month, dayNum) > now.getTime()) year -= 1;
    return dayRange(new Date(Date.UTC(year, month, dayNum)), `${dayNum} ${MONTHS[month]}`);
  }
  return null;
}
