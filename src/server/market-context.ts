export interface BackpackMarketSession {
  name: string;
  description: string;
  startTime: string;
  endTime: string;
  timezone: string;
  startWeekday: number;
  endWeekday: number;
}

export interface BackpackMarketHoliday {
  market: string;
  name: string;
  date: string;
  startTime?: string;
  endTime?: string;
  timezone: string;
}

export interface FundingIntervalRate {
  symbol: string;
  fundingRate: string;
  intervalEndTimestamp: string;
}

interface LocalTime {
  date: string;
  weekday: number;
  seconds: number;
}

const weekdayByName: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function timeToSeconds(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`Invalid market time: ${value}`);
  }
  const [hours, minutes, seconds] = parts as [number, number, number];
  if (hours > 23 || minutes > 59 || seconds > 59 || parts.some((part) => part < 0)) {
    throw new Error(`Invalid market time: ${value}`);
  }
  return hours * 3_600 + minutes * 60 + seconds;
}

function localTimeAt(value: Date, timezone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  const weekday = weekdayByName[part("weekday") ?? ""];
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const hours = Number(part("hour"));
  const minutes = Number(part("minute"));
  const seconds = Number(part("second"));
  if (!weekday || !year || !month || !day || [hours, minutes, seconds].some(Number.isNaN)) {
    throw new Error(`Could not resolve local market time for ${timezone}`);
  }
  return { date: `${year}-${month}-${day}`, weekday, seconds: hours * 3_600 + minutes * 60 + seconds };
}

function weekdayInRange(weekday: number, start: number, end: number): boolean {
  return start <= end
    ? weekday >= start && weekday <= end
    : weekday >= start || weekday <= end;
}

function previousWeekday(weekday: number): number {
  return weekday === 1 ? 7 : weekday - 1;
}

function sessionIsActive(local: LocalTime, session: BackpackMarketSession): boolean {
  const start = timeToSeconds(session.startTime);
  const end = timeToSeconds(session.endTime);
  if (start < end) {
    return weekdayInRange(local.weekday, session.startWeekday, session.endWeekday)
      && local.seconds >= start
      && local.seconds < end;
  }

  const sessionStartWeekday = local.seconds >= start
    ? local.weekday
    : previousWeekday(local.weekday);
  return weekdayInRange(sessionStartWeekday, session.startWeekday, session.endWeekday)
    && (local.seconds >= start || local.seconds < end);
}

export function inferFundingIntervalMinutes(rates: FundingIntervalRate[]): number {
  const timestamps = rates
    .map((rate) => Date.parse(rate.intervalEndTimestamp))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const intervals = timestamps
    .slice(1)
    .map((timestamp, index) => (timestamp - timestamps[index]!) / 60_000)
    .filter((minutes) => minutes > 0);
  if (intervals.length === 0) throw new Error("Not enough valid funding rates to infer interval");
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)]!;
}

export function getMarketContext(
  now: Date,
  sessions: BackpackMarketSession[],
  holidays: BackpackMarketHoliday[],
) {
  const timezone = sessions[0]?.timezone ?? "America/New_York";
  const local = localTimeAt(now, timezone);
  const holiday = holidays.find((item) => {
    if (item.market !== "US_EQUITIES" || item.date !== local.date) return false;
    if (!item.startTime || !item.endTime) return true;
    return local.seconds >= timeToSeconds(item.startTime)
      && local.seconds < timeToSeconds(item.endTime);
  });
  if (holiday) return { session: "CLOSED" as const, holiday: holiday.name, timezone };

  const session = sessions.find((item) =>
    item.timezone === timezone && sessionIsActive(local, item));
  return { session: session?.name ?? "CLOSED", holiday: null, timezone };
}
