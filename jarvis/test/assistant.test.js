import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeJarvis, say } from './helpers.js';

const device = (jarvis, name) => jarvis.ctx.devices.all().find((d) => d.name === name);

test('understands compound smart home commands and follow-up pronouns', async () => {
  const j = await makeJarvis();
  const r = await say(j, 'Hey Jarvis, turn on the kitchen lights and set the thermostat to 22 degrees');
  assert.deepEqual(r.intents.map((i) => i.intent), ['smarthome.power', 'smarthome.thermostat']);
  assert.equal(device(j, 'Kitchen lights').state.on, true);
  assert.equal(device(j, 'Thermostat').state.target, 22);
  await say(j, 'turn them off');
  assert.equal(device(j, 'Kitchen lights').state.on, false, '"them" refers to the lights, not the thermostat');
  assert.equal(device(j, 'Thermostat').state.on, true);
});

test('unlocking needs confirmation; "no" leaves the door locked', async () => {
  const j = await makeJarvis();
  let r = await say(j, 'unlock the front door');
  assert.equal(r.awaiting, true);
  assert.equal(device(j, 'Front door').state.locked, true);
  await say(j, 'no');
  assert.equal(device(j, 'Front door').state.locked, true);
  await say(j, 'unlock the front door');
  r = await say(j, 'yes');
  assert.equal(r.source, 'clarification');
  assert.equal(device(j, 'Front door').state.locked, false);
});

test('scenes change several devices at once', async () => {
  const j = await makeJarvis();
  await say(j, 'good night');
  assert.ok(j.ctx.devices.all().filter((d) => d.type === 'light').every((d) => !d.state.on));
  assert.equal(device(j, 'Security system').state.mode, 'night');
});

test('tasks keep capitalization and are not mistaken for calendar events', async () => {
  const j = await makeJarvis();
  const r = await say(j, 'add a task to email Pepper about the Stark Expo by friday');
  assert.equal(r.intents[0].intent, 'tasks.add');
  const [task] = j.store.collection('tasks').all();
  assert.equal(task.title, 'Email Pepper about the Stark Expo');
  assert.equal(new Date(task.due).getDay(), 5);
  await say(j, 'I finished the email to Pepper');
  assert.equal(j.store.collection('tasks').all()[0].status, 'done');
});

test('reminders fire through the scheduler and recurring ones reschedule', async () => {
  const j = await makeJarvis();
  await say(j, 'remind me to take my vitamins every day at 8am');
  await say(j, 'remind me in 5 minutes to check the oven');
  const fired = [];
  j.events.on('reminder.due', (payload) => fired.push(payload.reminder.text));
  j.setNow(new Date(2026, 10, 11, 10, 6));
  j.scheduler.tick();
  assert.deepEqual(fired, ['Check the oven']);
  j.setNow(new Date(2026, 10, 12, 8, 1));
  j.scheduler.tick();
  assert.ok(fired.includes('Take my vitamins'));
  const vitamins = j.store.collection('reminders').all().find((r) => r.text === 'Take my vitamins');
  assert.equal(vitamins.status, 'scheduled');
  assert.equal(new Date(vitamins.due).getDate(), 13);
});

test('asks for a missing time, then uses the answer', async () => {
  const j = await makeJarvis();
  let r = await say(j, 'remind me to call the bank');
  assert.equal(r.awaiting, true);
  r = await say(j, 'tomorrow at 3pm');
  assert.equal(r.intents[0].intent, 'reminders.set');
  const [reminder] = j.store.collection('reminders').all();
  assert.equal(new Date(reminder.due).getHours(), 15);
});

test('calendar events, overlap warning and iCalendar export', async () => {
  const j = await makeJarvis();
  await say(j, 'schedule a meeting with Rhodey on monday at 3pm for 30 minutes');
  const r = await say(j, 'book a dentist appointment on monday at 3:15pm');
  assert.match(r.reply.text, /overlaps/);
  const route = j.registry.routes().find((x) => x.path === '/calendar.ics');
  const ics = route.handler({}, j.ctx).raw;
  assert.match(ics, /SUMMARY:Meeting with Rhodey/);
  assert.match(ics, /BEGIN:VCALENDAR/);
});

test('a correction is learned and reused (continuous learning)', async () => {
  const j = await makeJarvis();
  let r = await say(j, 'lights please');
  assert.equal(r.source, 'none');
  assert.ok(j.learning.report().misses.some((m) => m.utterance === 'lights please'));
  r = await say(j, 'no, I meant turn on the living room lights');
  assert.match(r.reply.text, /remember/);
  await say(j, 'turn off the living room lights');
  r = await say(j, 'lights please');
  assert.equal(r.source, 'learned');
  assert.equal(device(j, 'Living room lights').state.on, true);
  assert.equal(j.learning.report().aliasCount, 1);
});

test('habits become proactive suggestions', async () => {
  const j = await makeJarvis();
  for (let day = 0; day < 4; day += 1) {
    j.setNow(new Date(2026, 10, 11 + day, 19, 5));
    await say(j, 'turn on the porch light');
  }
  j.setNow(new Date(2026, 10, 15, 19, 0));
  const suggestions = await j.suggestions();
  const habit = suggestions.find((s) => s.kind === 'habit');
  assert.ok(habit, 'a habit suggestion appears at the usual time');
  assert.match(habit.utterance, /turn on the porch light/);
});

test('incognito mode stores and learns nothing', async () => {
  const j = await makeJarvis();
  await say(j, 'go incognito');
  const before = j.store.collection('conversations').all().length;
  await say(j, 'turn on the kitchen lights');
  assert.equal(j.store.collection('conversations').all().length, before);
  assert.equal(j.profile.data.habits.intents['smarthome.power'], undefined);
});

test('privacy: export and forget everything', async () => {
  const j = await makeJarvis();
  await say(j, 'my name is Tony');
  await say(j, 'add a task to build a suit');
  const exported = j.exportData();
  assert.equal(exported.profile.name, 'Tony');
  assert.equal(exported.tasks.length, 1);
  let r = await say(j, 'forget everything');
  assert.equal(r.awaiting, true);
  r = await say(j, 'yes');
  assert.match(r.reply.text, /deleted/i);
  assert.equal(j.store.collection('tasks').all().length, 0);
  assert.equal(j.profile.get('name'), null);
});

test('falls back to the language model with tools when rules cannot help', async () => {
  const calls = [];
  const llm = {
    enabled: true, model: 'fake', effort: 'low',
    async converse({ message, tools }) {
      calls.push(message);
      const control = tools.find((t) => t.name === 'smart_home_control');
      const result = await control.run({ target: 'office lights', action: 'off', value: null });
      return { text: `Done: ${result.result}`, calls: [{ name: 'smart_home_control', input: {}, result }] };
    },
  };
  const j = await makeJarvis({ llm });
  const r = await say(j, 'it is getting late, could you sort out the office for me');
  assert.equal(r.source, 'language-model');
  assert.equal(calls.length, 1);
  assert.equal(device(j, 'Office lights').state.on, false);
  assert.equal(r.intents[0].intent, 'tool.smart_home_control');
});

test('language-model tool cannot unlock without the user confirming', async () => {
  const llm = {
    enabled: true, model: 'fake', effort: 'low',
    async converse({ tools }) {
      const result = await tools.find((t) => t.name === 'smart_home_control').run({ target: 'front door', action: 'unlock', value: null });
      return { text: result.needs_confirmation ? 'Please confirm.' : 'Unlocked.', calls: [] };
    },
  };
  const j = await makeJarvis({ llm });
  const r = await say(j, 'let my friend in');
  assert.equal(r.reply.text, 'Please confirm.');
  assert.equal(device(j, 'Front door').state.locked, true);
  await say(j, 'yes');
  assert.equal(device(j, 'Front door').state.locked, false);
});
