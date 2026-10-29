// Weekly draft scheduling, kept free of Slack/agent imports so it's unit-testable.
const MS_PER_DAY = 86_400_000;
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface WeeklySlot {
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}

/**
 * Parse WEEKLY_DRAFT_AT like "fri 10:00". Returns undefined when unset; throws on a
 * malformed value so a typo fails at startup instead of firing at the wrong time.
 */
export function parseSlot(value: string | undefined, timezone = DEFAULT_TIMEZONE): WeeklySlot | undefined {
  if (!value?.trim()) return undefined;
  const m = value.trim().toLowerCase().match(/^([a-z]{3})[a-z]*\s+(\d{1,2}):(\d{2})$/);
  const day = m ? DAYS.indexOf(m[1]) : -1;
  const hour = m ? Number(m[2]) : NaN;
  const minute = m ? Number(m[3]) : NaN;
  if (day < 0 || hour > 23 || minute > 59) throw new Error(`Invalid WEEKLY_DRAFT_AT "${value}"; use e.g. "fri 10:00".`);
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  return { day, hour, minute, timezone };
}

/** Milliseconds from `now` until the next `slot` in its timezone. */
export function msUntilNextWeekly(slot: WeeklySlot, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: slot.timezone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const weekday = DAYS.indexOf(get("weekday").toLowerCase().slice(0, 3));
  // Some platforms render midnight as hour "24".
  const nowSec = weekday * 86_400 + (Number(get("hour")) % 24) * 3600 + Number(get("minute")) * 60 + Number(get("second"));
  const targetSec = slot.day * 86_400 + slot.hour * 3600 + slot.minute * 60;
  let delta = targetSec - nowSec;
  if (delta <= 0) delta += 7 * 86_400;
  return delta * 1000;
}

/** Chained timeouts (max one day each) so restarts and DST self-correct. */
export function scheduleWeekly(label: string, slot: WeeklySlot, task: () => Promise<void>): void {
  const tick = () => {
    const ms = msUntilNextWeekly(slot);
    if (ms > MS_PER_DAY) {
      setTimeout(tick, MS_PER_DAY);
      return;
    }
    console.log(`${label} fires in ${Math.round(ms / 60_000)} min (${slot.timezone}).`);
    setTimeout(async () => {
      try {
        await task();
      } catch (err) {
        console.error(`${label} failed:`, err);
      } finally {
        setTimeout(tick, 60_000);
      }
    }, ms);
  };
  tick();
}

export function startWeeklyFromEnv(task: () => Promise<void>): void {
  const timezone = process.env.WEEKLY_DRAFT_TZ?.trim() || DEFAULT_TIMEZONE;
  let slot: WeeklySlot | undefined;
  try {
    slot = parseSlot(process.env.WEEKLY_DRAFT_AT, timezone);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err, "Weekly draft disabled.");
    return;
  }
  if (!slot) {
    console.log("Weekly draft disabled (set WEEKLY_DRAFT_AT, e.g. \"fri 10:00\").");
    return;
  }
  console.log(`Weekly draft scheduled for ${process.env.WEEKLY_DRAFT_AT} ${timezone}.`);
  scheduleWeekly("Weekly draft", slot, task);
}
