# JARVIS

A private, local-first personal assistant. Talk or type to manage tasks,
reminders and your calendar, control your smart home, check the weather and
news, look things up and summarize articles. JARVIS learns your phrasing and
habits as you use it.

It runs on Node.js with one dependency, the official Anthropic SDK. Commands
work offline with the built-in understanding. Add an Anthropic API key for
open-ended conversation.

## Standalone HTML version

`standalone/jarvis.html` is the complete JARVIS in one file: the HUD, chat,
voice, tasks, reminders, calendar, smart home, weather, news, search,
learning, privacy controls and integrations. No server and no install are
needed. Double-click it, or put it on any static host.

- **Storage.** Your data stays in that browser's local storage. You can encrypt it with a passphrase in Settings, Privacy (AES-256-GCM, key derived with PBKDF2). There is no way to recover a forgotten passphrase.
- **Keys.** Claude and ElevenLabs keys are entered in Settings, Integrations. They are kept in this browser and sent only to Anthropic and ElevenLabs. Set a passphrase if others use the computer.
- **Limits.** A web page can only reach services that allow it (CORS):
  - Open-Meteo, Wikipedia, Mastodon, Google Calendar, Anthropic and ElevenLabs work.
  - Google News blocks pages, so headlines come from Hacker News instead.
  - Summarizing a link fails on most sites. Paste the text after "summarize" instead.
  - Home Assistant needs your page's origin in `http: cors_allowed_origins`. Philips Hue bridges and Slack webhooks don't allow pages at all.
  - Reminders only fire while the page is open.
- **Microphone.** Allow it when asked. If the browser blocks it on a `file://` page, serve the folder with any static server, such as `npx serve standalone`.

Rebuild it after changing the sources:

```bash
npm run build:standalone
```

## Quick start

```bash
cd jarvis
```

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. A simulated home with 13 devices is ready to try.

## The interface

JARVIS opens in a holographic HUD:

- **Core.** An arc-reactor core in the center shows the time and how far the day has gone. It changes color and pulses with the voice while JARVIS listens and speaks.
- **Wings.** One shows live system diagnostics: host CPU, memory, home load, learning and satisfaction. The other holds one-click commands.
- **Left column.** The date, agenda meters, home load, AI and voice link status, scenes and web search.
- **Right column.** Weather, host system stats, upcoming events and reminders, and news.
- **Console.** The conversation sits under the core, with a live voice waveform.
- **Dock.** The circular buttons open the full Today, Home, Weather, News and Learning panels, and control listening, voice and settings.

Every value on screen is live. To switch to the calmer Classic dashboard, which also has a light theme, go to Settings, You, Interface.

To enable Claude for open-ended conversation, set a key before starting, or
add it later in Settings, Integrations:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Voice

JARVIS speaks its replies and listens when you press the microphone or Alt+V.
Esc stops it mid-sentence. Out of the box it uses the browser's built-in
speech. For a natural voice, add an ElevenLabs key, here or in Settings,
Integrations:

```bash
export ELEVENLABS_API_KEY=sk_...
```

With ElevenLabs connected:

- Replies are spoken by an ElevenLabs voice. The default is George, a warm British voice. Pick any voice on your account in Settings, You, Voice.
- Speech recognition works in every browser, including Firefox. JARVIS records while the microphone is lit and stops when you pause.
- The API key stays on the server. The browser only receives audio.

Hands-free mode ("Jarvis, …") uses the browser's recognition, so it needs
Chrome, Edge or Safari.

All options are listed in `.env.example`.

## Things to say

- "Turn on the kitchen lights and set the thermostat to 21 degrees"
- "Turn them off", "I'm cold", "Good night", "Unlock the front door"
- "Remind me to call mom tomorrow at 9am", "Set a timer for 10 minutes"
- "Add a task to renew my passport by Friday", "What are my tasks?"
- "Schedule lunch with Sam on Monday at noon", "What's on my calendar this week?"
- "Will it rain tomorrow?", "News about electric cars", "Who is Ada Lovelace?"
- "Summarize https://…", "What do you know about me?", "Go incognito"
- "No, I meant turn on the living room lights" teaches JARVIS a phrase.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Runs the server and dashboard |
| `npm test` | Runs the test suite |
| `npm run demo` | Prints a scripted conversation, no browser needed |
| `npm run build:standalone` | Rebuilds `standalone/jarvis.html` |

## Connecting real devices and services

Settings, Integrations has a form and a connection test for each service.
Environment variables work too.

- **Home Assistant:** `JARVIS_SMARTHOME_ADAPTER=homeassistant`, `HOMEASSISTANT_URL`, `HOMEASSISTANT_TOKEN`
- **Philips Hue:** `JARVIS_SMARTHOME_ADAPTER=hue`, `HUE_BRIDGE_URL`, `HUE_USERNAME`
- **Google Calendar:** `JARVIS_CALENDAR_ADAPTER=google`, `GOOGLE_CALENDAR_ACCESS_TOKEN`
- **Any calendar app:** subscribe to `http://localhost:3000/calendar.ics`
- **Mastodon or Slack/Discord:** `MASTODON_URL` with `MASTODON_TOKEN`, or `WEBHOOK_URL`

## Security

- Data is encrypted at rest with AES-256-GCM.
- The server binds to localhost. It refuses a public address unless `JARVIS_API_TOKEN` is set.
- Unlocking, disarming, posting publicly and deleting data always ask first.
- Export or delete your data from Settings, Privacy, or by voice.

## Documentation

`docs/FRAMEWORK.md` maps each of the ten requirements to its design, code,
tests and roadmap.

## Layout

```
jarvis/
  server.js              entry point
  src/core/              kernel, NLU, memory, learning, security, scheduler
  src/skills/            smart home, tasks, weather, news, search, social, system
  src/integrations/      service catalog and credential registry
  src/server/            HTTP API and server-sent events
  src/browser/           standalone build: browser store, in-page router, shims
  public/                dashboard (no build step)
  standalone/jarvis.html the whole app in one HTML file (generated)
  test/                  node:test suites
```
