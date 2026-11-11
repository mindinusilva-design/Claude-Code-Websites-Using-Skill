/**
 * Entity extraction for natural-language commands: dates, times, durations,
 * recurrence, numbers. Pure functions, no dependencies, deterministic given
 * `now`, so they are easy to unit test.
 */

const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4,
  june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};
const MONTH_RE = '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';

const WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const WEEKDAY_RE = '(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)';

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, 'a couple of': 2, couple: 2, few: 3,
};
const NUMBER_RE = '(\\d+(?:\\.\\d+)?|a couple of|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|ninety|half an|half a|a quarter of an|quarter of an)';
const UNIT_RE = '(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?)';

const UNIT_MS = {
  second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000,
};

export function parseNumber(word) {
  if (word == null) return null;
  const w = String(word).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(w)) return Number(w);
  if (w === 'half an' || w === 'half a' || w === 'half') return 0.5;
  if (w === 'a quarter of an' || w === 'quarter of an' || w === 'quarter') return 0.25;
  if (w === 'forty-five') return 45;
  if (w in NUMBER_WORDS) return NUMBER_WORDS[w];
  const parts = w.split(/[\s-]+/);
  let total = 0;
  for (const part of parts) {
    if (!(part in NUMBER_WORDS)) return null;
    total += NUMBER_WORDS[part];
  }
  return total;
}

function unitKey(unit) {
  const u = unit.toLowerCase();
  if (u.startsWith('sec')) return 'second';
  if (u.startsWith('min')) return 'minute';
  if (u.startsWith('h')) return 'hour';
  if (u.startsWith('d')) return 'day';
  if (u.startsWith('w')) return 'week';
  if (u.startsWith('mo')) return 'month';
  return null;
}

/** "in 10 minutes", "for 2 hours", "half an hour" -> { ms, matched } */
export function parseDuration(text) {
  const re = new RegExp(`\\b${NUMBER_RE}\\s*${UNIT_RE}(?:\\s+and\\s+${NUMBER_RE}\\s*${UNIT_RE})?\\b`, 'i');
  const m = re.exec(String(text));
  if (!m) return null;
  const n = parseNumber(m[1]);
  const unit = unitKey(m[2]);
  if (n == null || !unit) return null;
  let ms = n * UNIT_MS[unit];
  if (m[3] && m[4]) {
    const n2 = parseNumber(m[3]);
    const unit2 = unitKey(m[4]);
    if (n2 != null && unit2) ms += n2 * UNIT_MS[unit2];
  }
  return { ms, matched: m[0], index: m.index };
}

function atTime(base, hour, minute = 0) {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function addDays(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

const PERIOD_HOURS = { morning: 9, afternoon: 15, evening: 18, night: 20, tonight: 20 };

/**
 * Parse a date/time reference out of free text.
 * Returns null when the text carries no temporal reference, otherwise
 * { date, hasTime, hasDate, recurrence, matched, remainder }.
 */
export function parseDateTime(text, { now = new Date(), defaultHour = 9, preferMorning = false } = {}) {
  const source = String(text);
  const lower = source.toLowerCase();
  const matched = [];
  let dayBase = null; // Date (start of the day) chosen by a day reference
  let hour = null;
  let minute = 0;
  let meridiemKnown = false;
  let periodHour = null;
  let recurrence = null;
  let relative = null;
  let hasDate = false;
  let hasTime = false;

  const take = (m) => {
    matched.push({ text: m[0], index: m.index });
  };

  // --- recurrence -------------------------------------------------------
  let m = new RegExp(`\\b(?:every|each)\\s+(day|morning|afternoon|evening|night|weekday|week|month|hour|${WEEKDAY_RE.slice(1, -1)})\\b`, 'i').exec(lower);
  if (m) {
    take(m);
    const word = m[1].toLowerCase();
    if (word === 'day') recurrence = 'daily';
    else if (word === 'week') recurrence = 'weekly';
    else if (word === 'month') recurrence = 'monthly';
    else if (word === 'hour') recurrence = 'hourly';
    else if (word === 'weekday') recurrence = 'weekdays';
    else if (word in PERIOD_HOURS) { recurrence = 'daily'; periodHour = PERIOD_HOURS[word]; }
    else if (word in WEEKDAYS) { recurrence = `weekly:${WEEKDAYS[word]}`; dayBase = nextWeekday(now, WEEKDAYS[word], false); hasDate = true; }
  } else {
    m = /\b(daily|weekly|monthly|hourly|every weekday)\b/i.exec(lower);
    if (m) {
      take(m);
      recurrence = m[1].toLowerCase() === 'every weekday' ? 'weekdays' : m[1].toLowerCase();
    } else {
      m = new RegExp(`\\bevery\\s+${NUMBER_RE}\\s*${UNIT_RE}\\b`, 'i').exec(lower);
      if (m) {
        take(m);
        const n = parseNumber(m[1]);
        const unit = unitKey(m[2]);
        if (n && unit) recurrence = `interval:${n * UNIT_MS[unit]}`;
      }
    }
  }

  // --- relative offsets: "in 10 minutes", "in an hour and a half" ---------
  m = new RegExp(`\\bin\\s+(?:(${NUMBER_RE.slice(1, -1)})\\s*${UNIT_RE}(?:\\s+and\\s+(?:a\\s+)?(half|${NUMBER_RE.slice(1, -1)})(?:\\s*${UNIT_RE})?)?|an hour and a half|half an hour|a few (minutes|hours|days))\\b`, 'i').exec(lower);
  if (m) {
    take(m);
    const whole = m[0].toLowerCase();
    if (whole.includes('hour and a half')) relative = 1.5 * UNIT_MS.hour;
    else if (whole.includes('half an hour')) relative = 0.5 * UNIT_MS.hour;
    else if (m[5]) relative = 3 * UNIT_MS[unitKey(m[5])];
    else {
      const n = parseNumber(m[1]);
      const unit = unitKey(m[2]);
      if (n != null && unit) {
        relative = n * UNIT_MS[unit];
        if (m[3]) {
          if (m[3].toLowerCase() === 'half') relative += 0.5 * UNIT_MS[unit];
          else {
            const n2 = parseNumber(m[3]);
            const unit2 = m[4] ? unitKey(m[4]) : unit;
            if (n2 != null) relative += n2 * UNIT_MS[unit2];
          }
        }
      }
    }
  }

  // --- explicit dates -----------------------------------------------------
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(lower);
  if (m) {
    take(m);
    dayBase = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    hasDate = true;
  }
  if (!dayBase) {
    m = new RegExp(`\\b(?:on\\s+)?${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(lower);
    if (m) {
      take(m);
      const year = m[3] ? Number(m[3]) : now.getFullYear();
      dayBase = new Date(year, MONTHS[m[1].toLowerCase()], Number(m[2]));
      if (!m[3] && dayBase < atTime(now, 0)) dayBase.setFullYear(year + 1);
      hasDate = true;
    }
  }
  if (!dayBase) {
    m = new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, 'i').exec(lower);
    if (m) {
      take(m);
      const year = m[3] ? Number(m[3]) : now.getFullYear();
      dayBase = new Date(year, MONTHS[m[2].toLowerCase()], Number(m[1]));
      if (!m[3] && dayBase < atTime(now, 0)) dayBase.setFullYear(year + 1);
      hasDate = true;
    }
  }
  if (!dayBase) {
    m = /\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(lower);
    if (m) {
      take(m);
      let year = m[3] ? Number(m[3]) : now.getFullYear();
      if (year < 100) year += 2000;
      dayBase = new Date(year, Number(m[1]) - 1, Number(m[2]));
      hasDate = true;
    }
  }

  // --- day words ----------------------------------------------------------
  m = /\b(day after tomorrow|tomorrow|today|tonight|next week|next month)\b(?:\s+(morning|afternoon|evening|night))?/i.exec(lower);
  if (m) {
    take(m);
    const word = m[1].toLowerCase();
    if (word === 'day after tomorrow') dayBase = addDays(atTime(now, 0), 2);
    else if (word === 'tomorrow') dayBase = addDays(atTime(now, 0), 1);
    else if (word === 'today') dayBase = atTime(now, 0);
    else if (word === 'tonight') { dayBase = atTime(now, 0); periodHour = PERIOD_HOURS.night; }
    else if (word === 'next week') dayBase = addDays(atTime(now, 0), 7);
    else if (word === 'next month') { dayBase = atTime(now, 0); dayBase.setMonth(dayBase.getMonth() + 1); }
    if (m[2]) periodHour = PERIOD_HOURS[m[2].toLowerCase()];
    hasDate = true;
  } else {
    m = /\b(?:this|in the)\s+(morning|afternoon|evening)\b/i.exec(lower);
    if (m) {
      take(m);
      periodHour = PERIOD_HOURS[m[1].toLowerCase()];
      if (!dayBase) {
        dayBase = atTime(now, 0);
        if (atTime(now, periodHour) <= now && /in the/i.test(m[0])) dayBase = addDays(dayBase, 1);
      }
      hasDate = true;
    }
  }

  // --- weekdays -----------------------------------------------------------
  if (!dayBase || recurrence?.startsWith('weekly:')) {
    m = new RegExp(`\\b(?:(next|this)\\s+)?(?:on\\s+)?${WEEKDAY_RE}\\b(?:\\s+(morning|afternoon|evening|night))?`, 'i').exec(lower);
    if (m && !matched.some((x) => x.index <= m.index && m.index < x.index + x.text.length)) {
      take(m);
      const wd = WEEKDAYS[m[2].toLowerCase()];
      dayBase = nextWeekday(now, wd, m[1]?.toLowerCase() === 'next');
      if (m[3]) periodHour = PERIOD_HOURS[m[3].toLowerCase()];
      hasDate = true;
    }
  }

  // --- clock times --------------------------------------------------------
  m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i.exec(lower);
  if (m) {
    take(m);
    hour = Number(m[1]) % 12 + (/^p/i.test(m[3]) ? 12 : 0);
    minute = m[2] ? Number(m[2]) : 0;
    meridiemKnown = true;
    hasTime = true;
  } else if ((m = /\b(\d{1,2}):(\d{2})\b/.exec(lower))) {
    take(m);
    hour = Number(m[1]);
    minute = Number(m[2]);
    meridiemKnown = hour > 12 || hour === 0;
    hasTime = true;
  } else if ((m = /\bat\s+(\d{1,2})\b(?!\s*(?:percent|%|degrees|°))/i.exec(lower)) || (m = /\b(\d{1,2})\s*o'?clock\b/i.exec(lower))) {
    take(m);
    hour = Number(m[1]);
    hasTime = true;
  } else if ((m = /\b(noon|midday|midnight)\b/i.exec(lower))) {
    take(m);
    hour = m[1].toLowerCase() === 'midnight' ? 0 : 12;
    meridiemKnown = true;
    hasTime = true;
  }

  if (!matched.length) return null;

  // --- assemble -----------------------------------------------------------
  let date;
  if (relative != null) {
    date = new Date(now.getTime() + relative);
    hasTime = true;
  } else {
    const base = dayBase ?? atTime(now, 0);
    if (hour != null) {
      let h = hour;
      if (!meridiemKnown && h <= 12) {
        const sameDay = base.getTime() === atTime(now, 0).getTime();
        if (preferMorning && h >= 1 && h <= 11) {
          h = h % 12;
        } else if (sameDay) {
          const am = atTime(base, h % 12, minute);
          h = am > now ? h % 12 : (h % 12) + 12;
        } else {
          h = h >= 1 && h <= 6 ? h + 12 : h % 12;
          if (h === 0 && hour === 12) h = 12;
        }
      }
      if (periodHour != null && periodHour >= 12 && h < 12 && !meridiemKnown) h += 12;
      date = atTime(base, h, minute);
    } else if (periodHour != null) {
      date = atTime(base, periodHour);
      hasTime = true;
    } else {
      date = atTime(base, defaultHour);
      if (!dayBase) date = atTime(now, defaultHour);
    }
    if (date <= now) {
      if (!dayBase) date = addDays(date, 1); // time-only or recurrence-only: next occurrence is tomorrow
      else if (!hasTime && periodHour == null) {
        date = new Date(now.getTime() + UNIT_MS.hour);
        date.setMinutes(0, 0, 0);
        date.setHours(date.getHours() + 1);
      }
    }
  }

  let remainder = source;
  for (const piece of matched.sort((a, b) => b.index - a.index)) {
    remainder = remainder.slice(0, piece.index) + ' ' + remainder.slice(piece.index + piece.text.length);
  }
  remainder = remainder
    .replace(/\s+/g, ' ')
    .replace(/\s+(at|on|for|by|in)\s*$/i, '')
    .replace(/^\s*(at|on|for|by|in|and)\s+/i, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*$/g, '')
    .trim();

  return {
    date,
    hasTime,
    hasDate: hasDate || relative != null,
    recurrence,
    matched: matched.map((x) => x.text),
    remainder,
  };
}

export function nextWeekday(now, weekday, forceNextWeek = false) {
  const base = atTime(now, 0);
  let diff = (weekday - base.getDay() + 7) % 7;
  if (diff === 0 && (forceNextWeek || now.getHours() >= 18)) diff = 7;
  return addDays(base, diff);
}

/** Compute the next occurrence of a recurring reminder after `after`. */
export function nextOccurrence(date, recurrence, after = new Date()) {
  if (!recurrence) return null;
  let next = new Date(date);
  const guard = 1000;
  for (let i = 0; i < guard && next <= after; i += 1) {
    if (recurrence === 'daily') next = addDays(next, 1);
    else if (recurrence === 'weekly' || recurrence.startsWith('weekly:')) next = addDays(next, 7);
    else if (recurrence === 'monthly') next.setMonth(next.getMonth() + 1);
    else if (recurrence === 'hourly') next = new Date(next.getTime() + UNIT_MS.hour);
    else if (recurrence === 'weekdays') {
      next = addDays(next, 1);
      while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
    } else if (recurrence.startsWith('interval:')) next = new Date(next.getTime() + Number(recurrence.slice(9)));
    else return null;
  }
  return next;
}

export function describeRecurrence(recurrence) {
  if (!recurrence) return '';
  if (recurrence === 'daily') return 'every day';
  if (recurrence === 'weekly') return 'every week';
  if (recurrence === 'monthly') return 'every month';
  if (recurrence === 'hourly') return 'every hour';
  if (recurrence === 'weekdays') return 'every weekday';
  if (recurrence.startsWith('weekly:')) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `every ${names[Number(recurrence.slice(7))]}`;
  }
  if (recurrence.startsWith('interval:')) {
    const ms = Number(recurrence.slice(9));
    if (ms % UNIT_MS.day === 0) return `every ${ms / UNIT_MS.day} days`;
    if (ms % UNIT_MS.hour === 0) return `every ${ms / UNIT_MS.hour} hours`;
    return `every ${Math.round(ms / UNIT_MS.minute)} minutes`;
  }
  return recurrence;
}

/** Human-friendly rendering: "today at 5:00 PM", "tomorrow at 9:00 AM", "Mon 10 Nov at 3:00 PM". */
export function formatDateTime(date, { now = new Date(), withTime = true } = {}) {
  const d = new Date(date);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const startToday = atTime(now, 0);
  const dayDiff = Math.round((atTime(d, 0) - startToday) / UNIT_MS.day);
  let day;
  if (dayDiff === 0) day = 'today';
  else if (dayDiff === 1) day = 'tomorrow';
  else if (dayDiff === -1) day = 'yesterday';
  else if (dayDiff > 1 && dayDiff < 7) day = d.toLocaleDateString('en-US', { weekday: 'long' });
  else day = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  return withTime ? `${day} at ${time}` : day;
}

/** Extract a temperature mention: "72 degrees", "21°C", "to 68" (when hinted). */
export function parseTemperature(text) {
  const m = /(-?\d{1,3})\s*(?:°|degrees?)?\s*(celsius|fahrenheit|c|f)?\b/i.exec(String(text));
  if (!m) return null;
  const value = Number(m[1]);
  let unit = m[2] ? m[2][0].toUpperCase() : null;
  if (!unit) unit = value > 45 ? 'F' : 'C';
  return { value, unit, matched: m[0] };
}

/** Extract a percentage or level word: "50%", "to 30 percent", "dim", "bright". */
export function parseLevel(text) {
  const m = /(\d{1,3})\s*(?:%|percent)/i.exec(String(text));
  if (m) return Math.max(0, Math.min(100, Number(m[1])));
  const t = String(text).toLowerCase();
  if (/\b(max|maximum|full|brightest|all the way up)\b/.test(t)) return 100;
  if (/\b(dim|low|night ?light)\b/.test(t)) return 20;
  if (/\b(half|medium)\b/.test(t)) return 50;
  if (/\b(bright|high)\b/.test(t)) return 90;
  return null;
}

export const COLORS = ['red', 'green', 'blue', 'white', 'warm white', 'cool white', 'yellow', 'orange', 'purple', 'pink', 'cyan', 'teal', 'magenta', 'amber'];

export function parseColor(text) {
  const t = String(text).toLowerCase();
  for (const color of COLORS.slice().sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${color}\\b`).test(t)) return color;
  }
  return null;
}
