// Phrases people type on a recurring ticket, and the words the card shows back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSchedule, canonicalCron, cronToText, isCron } from '../../src/ui/schedule.js'

test('phrases become cron and cron comes back as words', () => {
  assert.equal(parseSchedule('daily at 9'), '0 9 * * *')
  assert.equal(cronToText('0 9 * * *'), 'Every day at 9am')
  assert.equal(parseSchedule('Daily at 9:30pm'), '30 21 * * *')
  assert.equal(cronToText('30 21 * * *'), 'Every day at 9:30pm')
  assert.equal(parseSchedule('weekdays at 9'), '0 9 * * 1-5')
  assert.equal(cronToText('0 9 * * 1-5'), 'Weekdays at 9am')
  assert.equal(parseSchedule('every monday at 9am'), '0 9 * * 1')
  assert.equal(cronToText('0 9 * * 1'), 'Every Monday at 9am')
  assert.equal(parseSchedule('every 15 minutes'), '*/15 * * * *')
  assert.equal(cronToText('*/15 * * * *'), 'Every 15 minutes')
  assert.equal(parseSchedule('hourly'), '0 * * * *')
  assert.equal(cronToText('0 * * * *'), 'Every hour')
  assert.equal(parseSchedule('monthly'), '0 0 1 * *')
  assert.equal(cronToText('0 0 1 * *'), 'Monthly on the 1st at 12am')
  assert.equal(parseSchedule(''), '')
  assert.equal(cronToText(''), '')
  assert.equal(parseSchedule('0 15 * * 1-5'), '0 15 * * 1-5')
  assert.equal(cronToText('0 15 * * 1-5'), 'Weekdays at 3pm')
  assert.equal(cronToText('15 4 1 1 *'), '15 4 1 1 *')
})

test('junk schedules are refused and phrases are not stored as-is', () => {
  assert.equal(isCron('0 9 * * *'), true)
  assert.equal(isCron('* * *'), false)
  assert.equal(isCron('60 9 * * *'), false)
  assert.equal(canonicalCron('0 9 * * *'), '0 9 * * *')
  assert.equal(canonicalCron('daily at 9'), null)
  assert.equal(canonicalCron('0  9 * * *'), null)
  assert.equal(canonicalCron(''), '')
  assert.equal(canonicalCron(undefined), '')
  assert.throws(() => parseSchedule('not a schedule'), /5-field cron/)
  assert.throws(() => parseSchedule('daily at 99'), /5-field cron/)
  assert.throws(() => parseSchedule('x'.repeat(81)), /too long/)
})
