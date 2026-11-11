import { existsSync, readFileSync } from 'node:fs';
import { createJarvis, VERSION } from './src/core/jarvis.js';
import { createApp } from './src/server/app.js';

// Minimal .env loader (no dependency): KEY=VALUE lines, existing variables win.
function loadEnvFile(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

loadEnvFile();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

if (!loopback && !process.env.JARVIS_API_TOKEN) {
  console.error(`Refusing to listen on ${host} without JARVIS_API_TOKEN.\nSet JARVIS_API_TOKEN to a long random string before exposing JARVIS beyond this machine.`);
  process.exit(1);
}

const jarvis = await createJarvis();
const app = createApp(jarvis, { allowedHosts: (process.env.JARVIS_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean) });
await app.listen(port, host);

const model = jarvis.llm.enabled ? `on (${jarvis.llm.model}, effort ${jarvis.llm.effort})` : 'off (set ANTHROPIC_API_KEY to enable open-ended conversation)';
console.log(`
  JARVIS ${VERSION} is online
  Dashboard       http://${loopback ? 'localhost' : host}:${port}
  Language model  ${model}
  Encryption      ${jarvis.encryption.algorithm}, key from ${jarvis.encryption.keySource}
  API auth        ${jarvis.security.authRequired ? 'bearer token required' : 'open on localhost only'}
  Data            ${jarvis.config.dataDir}
`);

const shutdown = async () => {
  jarvis.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
