// Repeat schedules for task cards. Phrases become 5-field cron; the card shows
// the phrase back in words. No DOM, so the session server can import it too.

const INVISIBLE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const DOW = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6
}

function pieceOk (part, min, max) {
  const m = /^(?:(\*)|(\d+)|(\d+-\d+))(?:\/(\d+))?$/.exec(part)
  if (!m) return false
  if (m[4] != null) {
    const step = Number(m[4])
    if (!Number.isInteger(step) || step < 1 || step > max) return false
  }
  if (m[1]) return true
  if (m[2]) {
    const n = Number(m[2])
    return n >= min && n <= max
  }
  const [a, b] = m[3].split('-').map(Number)
  return a >= min && b <= max && a <= b
}

function fieldOk (field, min, max) {
  if (!field || field.length > 40) return false
  return field.split(',').every((part) => pieceOk(part, min, max))
}

/** True for a 5-field cron expression (numbers, lists, ranges, stars). */
export function isCron (value) {
  const parts = String(value ?? '').trim().split(/\s+/)
  if (parts.length !== 5) return false
  return parts.every((field, i) => fieldOk(field, RANGES[i][0], RANGES[i][1]))
}

function clock (hour, minute, ampm) {
  let h = Number(hour)
  const m = minute == null || minute === '' ? 0 : Number(minute)
  if (!Number.isInteger(h) || !Number.isInteger(m) || m < 0 || m > 59) return null
  if (ampm) {
    const ap = ampm.toLowerCase()
    if (h > 12 || h < 1) return null
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
  } else if (h > 23 || h < 0) return null
  return { h, m }
}

function phraseToCron (raw) {
  const s = raw.toLowerCase()
  if (s === 'every minute' || s === 'minutely') return '* * * * *'
  if (s === 'hourly' || s === 'every hour') return '0 * * * *'
  if (s === 'daily' || s === 'every day') return '0 0 * * *'
  if (s === 'weekly' || s === 'every week') return '0 0 * * 1'
  if (s === 'monthly' || s === 'every month') return '0 0 1 * *'
  if (s === 'weekdays' || s === 'every weekday') return '0 0 * * 1-5'
  if (s === 'weekends' || s === 'every weekend') return '0 0 * * 0,6'

  let m = s.match(/^every (\d{1,2}) minutes?$/)
  if (m) {
    const n = Number(m[1])
    if (n < 1 || n > 59) return null
    return n === 1 ? '* * * * *' : `*/${n} * * * *`
  }
  m = s.match(/^every (\d{1,2}) hours?$/)
  if (m) {
    const n = Number(m[1])
    if (n < 1 || n > 23) return null
    return n === 1 ? '0 * * * *' : `0 */${n} * * *`
  }

  m = s.match(/^(every day|daily|weekdays|every weekday|weekends|every weekend|weekly|every week|monthly|every month) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (m) {
    const c = clock(m[2], m[3], m[4])
    if (!c) return null
    const kind = m[1]
    if (kind === 'monthly' || kind === 'every month') return `${c.m} ${c.h} 1 * *`
    const dow = kind === 'weekdays' || kind === 'every weekday' ? '1-5'
      : kind === 'weekends' || kind === 'every weekend' ? '0,6'
        : kind === 'weekly' || kind === 'every week' ? '1'
          : '*'
    return `${c.m} ${c.h} * * ${dow}`
  }

  m = s.match(/^(?:every|on)\s+(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)(?: at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/)
  if (m) {
    const c = m[2] != null ? clock(m[2], m[3], m[4]) : { h: 0, m: 0 }
    if (!c) return null
    return `${c.m} ${c.h} * * ${DOW[m[1]]}`
  }
  return null
}

/**
 * A stored schedule or a phrase ("daily at 9", "weekdays at 9:30", "every monday").
 * Empty clears it. Throws when it is neither a phrase nor 5-field cron.
 */
export function parseSchedule (input) {
  const raw = String(input ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  if (raw.length > 80) throw new Error('schedule is too long')
  const phrase = phraseToCron(raw)
  if (phrase) return phrase
  if (!isCron(raw)) throw new Error('use 5-field cron, or a phrase like "daily at 9" or "weekdays at 9:30"')
  return raw
}

/** The cron as stored, or null when it is not already in canonical form. Missing is empty. */
export function canonicalCron (value) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string' || value.length > 80) return null
  try {
    const parsed = parseSchedule(value)
    return parsed === value ? value : null
  } catch {
    return null
  }
}

function clockLabel (hour, minute) {
  const h = Number(hour)
  const m = Number(minute)
  const ap = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return m === 0 ? `${h12}${ap}` : `${h12}:${String(m).padStart(2, '0')}${ap}`
}

/** English for the schedules the card knows. Anything else is the cron itself. */
export function cronToText (cron) {
  const c = String(cron || '').trim()
  if (!c) return ''
  const parts = c.split(/\s+/)
  if (parts.length !== 5 || !isCron(c)) return c
  const [min, hour, dom, mon, dow] = parts
  if (mon !== '*') return c
  if (c === '* * * * *') return 'Every minute'
  const everyMin = /^\*\/(\d+)$/.exec(min)
  if (everyMin && hour === '*' && dom === '*' && dow === '*') return `Every ${everyMin[1]} minutes`
  if (min === '0' && hour === '*' && dom === '*' && dow === '*') return 'Every hour'
  const everyHour = /^\*\/(\d+)$/.exec(hour)
  if (min === '0' && everyHour && dom === '*' && dow === '*') return `Every ${everyHour[1]} hours`
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return c
  const when = clockLabel(hour, min)
  if (dom === '*' && dow === '*') return `Every day at ${when}`
  if (dom === '*' && dow === '1-5') return `Weekdays at ${when}`
  if (dom === '*' && dow === '0,6') return `Weekends at ${when}`
  if (dom === '1' && dow === '*') return `Monthly on the 1st at ${when}`
  if (dom === '*' && /^\d$/.test(dow)) return `Every ${DAYS[Number(dow)]} at ${when}`
  return c
}

