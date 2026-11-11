// Runs a scripted conversation against an in-memory JARVIS (no network needed
// for most turns) and prints what it understood. Usage: npm run demo
import { createJarvis } from '../src/core/jarvis.js';

const script = process.argv.slice(2).length ? process.argv.slice(2) : [
  'hello',
  'my name is Tony',
  'turn on the kitchen lights and set the thermostat to 22 degrees',
  'turn them off',
  'dim the living room lights to 30%',
  'add a task to review the quarterly report by friday',
  'remind me to call Pepper tomorrow at 9am',
  'schedule a meeting with Rhodey on monday at 3pm for 30 minutes',
  "what's on my calendar this week",
  'what are my tasks',
  'unlock the front door',
  'yes',
  'good night',
  'lights please',
  'no, I meant turn on the living room lights',
  'lights please',
  'what do you know about me',
];

const jarvis = await createJarvis({ dataDir: null, logger: { warn() {}, error: console.error }, startScheduler: false, env: {} });
for (const text of script) {
  const result = await jarvis.handle({ text, sessionId: 'demo' });
  const intents = result.intents.map((i) => `${i.intent}@${i.confidence}`).join(', ') || '-';
  console.log(`\n> ${text}\n  [${result.source}] ${intents}\n  JARVIS: ${result.reply.text}`);
}
jarvis.stop();
