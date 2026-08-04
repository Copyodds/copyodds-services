type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** 将时区内日历时刻转为 UTC `Date`（迭代校正 DST/偏移）。 */
export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
  timeZone: string
): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const targetMs = utcMs;
  for (let i = 0; i < 4; i++) {
    const p = getZonedParts(new Date(utcMs), timeZone);
    const actualMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    utcMs += targetMs - actualMs;
  }
  return new Date(utcMs);
}

function subtractCalendarDayInZone(
  year: number,
  month: number,
  day: number,
  timeZone: string
): Pick<ZonedParts, 'year' | 'month' | 'day'> {
  const noon = zonedDateTimeToUtc(year, month, day, 12, 0, 0, timeZone);
  const prev = new Date(noon.getTime() - 24 * 60 * 60 * 1000);
  const p = getZonedParts(prev, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * 当前「今日收益」窗口起点：在 `timeZone` 内最近一次 `resetHour:00`（含整点），且 ≤ `now`。
 * 例：resetHour=8 时，5/27 10:00 → 5/27 08:00；5/27 07:00 → 5/26 08:00。
 */
export function getPnlDayWindowStartUtc(
  now: Date,
  timeZone: string,
  resetHour: number
): Date {
  const reset = Math.min(23, Math.max(0, Math.floor(resetHour)));
  const p = getZonedParts(now, timeZone);
  let { year, month, day } = p;
  if (p.hour < reset) {
    ({ year, month, day } = subtractCalendarDayInZone(year, month, day, timeZone));
  }
  return zonedDateTimeToUtc(year, month, day, reset, 0, 0, timeZone);
}
