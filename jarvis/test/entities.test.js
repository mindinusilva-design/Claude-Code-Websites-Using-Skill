import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateTime, parseDuration, nextOccurrence, describeRecurrence } from '../src/core/nlu/entities.js';

const now = new Date(2026, 10, 11, 10, 0, 0); // Wednesday 10:00
const at = (text, opts = {}) => parseDateTime(text, { now, ...opts });

test('relative times', () => {
  assert.equal(at('remind me in 10 minutes to stretch').date.getTime(), now.getTime() + 10 * 60_000);
  assert.equal(at('in an hour and a half check the oven').date.getTime(), now.getTime() + 90 * 60_000);
});

test('day words and clock times', () => {
  const r = at('call mom tomorrow at 9am');
  assert.equal(r.date.getDate(), 12);
  assert.equal(r.date.getHours(), 9);
  assert.equal(r.remainder, 'call mom');
  assert.equal(at('pick up the kids at 5').date.getHours(), 17, 'ambiguous afternoon hour resolves to pm');
  assert.equal(at('lock the door tonight').date.getHours(), 20);
});

test('explicit dates and weekdays', () => {
  const r = at('dentist on november 20th at 2pm');
  assert.deepEqual([r.date.getMonth(), r.date.getDate(), r.date.getHours()], [10, 20, 14]);
  assert.equal(at('pay rent on the 1st of december').date.getMonth(), 11);
  assert.equal(at('meeting friday at 3').date.getDay(), 5);
  assert.equal(at('call the bank on 11/20 at noon').date.getHours(), 12);
});

test('recurrence', () => {
  assert.equal(at('take vitamins every day at 8am').recurrence, 'daily');
  assert.equal(at('water the plants every 3 days').recurrence, `interval:${3 * 86_400_000}`);
  assert.equal(describeRecurrence('weekdays'), 'every weekday');
  const next = nextOccurrence(new Date(2026, 10, 13, 9), 'weekdays', new Date(2026, 10, 13, 10)); // Friday
  assert.equal(next.getDay(), 1, 'weekday recurrence skips the weekend');
});

test('no temporal reference returns null', () => {
  assert.equal(at('buy 2 apples'), null);
});

test('durations', () => {
  assert.equal(parseDuration('for 2 hours and 30 minutes').ms, 9_000_000);
  assert.equal(parseDuration('half an hour').ms, 1_800_000);
});
