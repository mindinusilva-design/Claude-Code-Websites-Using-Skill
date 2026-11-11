import { Jarvis } from '../src/core/jarvis.js';

export const quiet = { warn() {}, error() {}, log() {} };

/** In-memory JARVIS with a fixed clock and no network-dependent setup. */
export async function makeJarvis(options = {}) {
  let now = options.now ?? new Date(2026, 10, 11, 10, 0, 0); // Wed 11 Nov 2026, 10:00
  const jarvis = new Jarvis({ dataDir: null, logger: quiet, startScheduler: false, env: {}, now: () => new Date(now), ...options });
  await jarvis.ready();
  jarvis.setNow = (d) => { now = d; };
  return jarvis;
}

export async function say(jarvis, text, sessionId = 'test') {
  return jarvis.handle({ text, sessionId });
}
