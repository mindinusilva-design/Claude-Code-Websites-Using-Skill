# JARVIS framework

This document turns the ten JARVIS requirements into one architecture. Each
feature lists what it means, how this codebase implements it, how to verify
it, and what comes next. Paths are relative to the `jarvis/` folder.

## 1. Architecture at a glance

```
 Browser dashboard (public/)          REST + SSE (src/server/app.js)
 text · voice · cards · settings  ──▶ auth · rate limit · host/origin checks
                                              │
                                              ▼
                               Kernel  (src/core/jarvis.js)
       ┌──────────────────────────────┼──────────────────────────────┐
       ▼                              ▼                              ▼
  Understanding                   Skills (plugins)              Memory & privacy
  rules → learned phrases →       smart home · tasks/calendar · encrypted store ·
  classifier → Claude + tools     weather · news · search ·     profile & habits ·
  (src/core/nlu/)                 social · system · feedback    learning · audit log
                                       │
                                       ▼
                    Integrations registry (src/integrations/)
          Home Assistant · Hue · Google Calendar · Mastodon · webhooks · ElevenLabs ·
          Open-Meteo · Wikipedia · DuckDuckGo · RSS · Anthropic API
```

**One turn, end to end.** `Jarvis.handle()` validates the text, asks the NLU
for ranked intents, resolves pronouns from conversation context, dispatches to
the skill handler (or to Claude with every skill's tools), records the turn,
updates habits and the classifier, and returns the reply with speech text,
rich cards, an explanation of how it understood the request, and proactive
suggestions.

**The plugin contract.** A skill is one object (`src/core/registry.js`):

| Field | Purpose |
|---|---|
| `intents` | Patterns, slot extractors, example utterances and a handler |
| `tools` | JSON-schema tools the language model may call |
| `routes` | REST endpoints for the dashboard |
| `snapshot` | Data for the dashboard panels |
| `suggestions` | Context-aware nudges, such as overdue tasks or unlocked doors |

One definition feeds the rule engine, the classifier's seed data, the model's
tool list, the HTTP API and the dashboard. A new capability is added in one place.

## 2. The ten features

### 2.1 Natural language processing

- **Definition.** Understand free-form requests, multi-step sentences and follow-ups.
- **Design.** A layered pipeline that is fast and explainable first, generative last.
  1. *Rules* (`nlu/rules.js`): normalized regular-expression intents with slot
     extractors. Compound sentences ("turn on the lights and set the heat to 21")
     are split only when every part parses.
  2. *Learned phrases*: corrections become exact aliases.
  3. *Classifier* (`nlu/classifier.js`): online Naive Bayes over unigrams and
     bigrams that generalizes from feedback.
  4. *Claude* (`nlu/llm.js`): open-ended or uncertain requests go to
     `claude-opus-5-5` through the SDK tool runner, with every skill's tools.
  - *Entities* (`nlu/entities.js`): dates, times, durations, recurrence,
    temperatures, levels, colors.
  - *Context* (`core/context.js`): "turn them off", "and the bedroom", pending
    questions ("When should I remind you?") and yes/no confirmations.
- **Acceptance.** `test/assistant.test.js`: compound commands, pronouns,
  clarification answers. `test/entities.test.js`: date parsing.
- **Next.** Multilingual patterns; entity linking for contacts.

### 2.2 Task management

- **Definition.** Tasks, reminders and appointments that integrate with calendars.
- **Design.** `skills/tasks/`: to-dos with due dates and priority, one-off and
  recurring reminders (daily, weekdays, weekly, monthly, every N units),
  timers, alarms, and calendar events with overlap warnings.
  `core/scheduler.js` fires due reminders as `reminder.due` events, which the
  dashboard shows as notices, toasts, speech and system notifications, with
  snooze. Calendar integration has two paths: a subscribable iCalendar feed at
  `/calendar.ics` for Apple, Google and Outlook calendars, and a Google
  Calendar adapter for two-way sync.
- **Acceptance.** Reminder firing and rescheduling, missing-time clarification,
  overlap warnings and ICS output are all tested.
- **Next.** CalDAV and Microsoft Graph adapters; location-based reminders.

### 2.3 Smart home integration

- **Definition.** Control lights, thermostats, locks and security on popular platforms.
- **Design.** `skills/smarthome/`: one adapter interface (`discover`, `execute`,
  `refresh`) with three implementations: a simulated home for demos, Home
  Assistant over REST (which covers Zigbee, Z-Wave, Matter, Nest, Ecobee and
  more through HA), and Philips Hue. Devices resolve by name, room, type or
  pronoun. Eight scenes cover good night, morning, movie, away, home, relax,
  focus and party. Unlocking a door or disarming the alarm always needs
  confirmation, including when Claude initiates it.
- **Acceptance.** Scene, confirmation and tool-confirmation tests.
- **Next.** Native Matter controller; SmartThings adapter; presence-based automations.

### 2.4 Information retrieval

- **Definition.** Search the web, summarize articles and answer factual questions.
- **Design.** `skills/search/` queries DuckDuckGo Instant Answers and Wikipedia
  in parallel. With Claude connected, answers are composed strictly from the
  retrieved sources. Summaries come from Claude, or from an offline extractive
  summarizer when no key is set. User-supplied URLs pass a guard that refuses
  private network addresses.
- **Acceptance.** `test/integrations.test.js` (stubbed network).
- **Next.** Pluggable search providers such as Brave or SearXNG; citations in the UI.

### 2.5 Personalization

- **Definition.** Learn preferences over time and adapt responses.
- **Design.** `core/profile.js` keeps explicit preferences (name, home city,
  units, news topics) and implicit habits: per-intent counts by hour and
  weekday, device usage and topics of interest. Habits become time-aware
  suggestions ("Turn on the porch light, like you usually do around now?") that
  run with one tap and can be dismissed. The profile summary is sent to Claude
  so replies use the right city and units.
- **Acceptance.** "habits become proactive suggestions" test.
- **Next.** Routine detection across intents ("every weekday at 7 you…") offered as automations.

### 2.6 Multimodal interaction

- **Definition.** Voice, text and visual interfaces with a dashboard.
- **Design.** `public/`: chat with rich cards (devices with live controls,
  tasks, events, weather, news, search results, summaries), push-to-talk and
  hands-free wake-word listening through the Web Speech API, spoken replies
  with a British voice where available, and dashboard panels for Today, Home,
  Weather, News and Learning. It works in light and dark themes, on phones,
  with keyboard navigation and screen readers, and with reduced motion.
- **Voice pipeline** (`src/voice/`, `public/js/voice.js`). Speaking uses an
  ElevenLabs voice through `POST /api/voice/speak` when configured, and falls
  back to the browser's speech synthesis if not, or if a request fails. Short
  phrases are cached. Listening uses browser recognition, or records the
  microphone with automatic end-of-speech detection and transcribes it with
  ElevenLabs Scribe through `POST /api/voice/transcribe`. The API key never
  leaves the server. JARVIS speaks by default and always answers aloud when
  spoken to. The orb follows the live audio level. Alt+V toggles the
  microphone, and Esc interrupts speech.
- **Acceptance.** `test/voice.test.js` covers the ElevenLabs request shapes,
  caching, error messages and the voice routes.
- **Next.** Streaming speech for lower latency; a mobile app shell.

### 2.7 Security and privacy

- **Definition.** Encrypt sensitive data and give users control over it.
- **Design.**
  - *At rest*: every collection is AES-256-GCM encrypted, with the key derived
    by scrypt from `JARVIS_SECRET` or a 0600 key file.
  - *In transit and at the edge*: localhost binding by default, a refusal to
    bind publicly without `JARVIS_API_TOKEN`, constant-time token checks,
    rate limiting, DNS-rebinding and cross-origin checks, a strict CSP, and a
    100 KB body limit.
  - *User control*: a privacy report ("what do you know about me"), full JSON
    export, deletion by scope with confirmation, incognito mode, configurable
    retention, and an audit log with secrets redacted.
  - *Least sharing*: the report lists every outside service and what it
    receives. Credentials are never returned to the browser. Posting publicly
    always needs confirmation.
- **Acceptance.** `test/core.test.js` and `test/server.test.js`.
- **Next.** OS keychain for the key; per-device sessions; optional end-to-end sync.

### 2.8 Continuous learning

- **Definition.** Improve from interactions and feedback.
- **Design.** `core/learning.js`. High-confidence rule matches lightly
  reinforce the classifier (self-training). Thumbs-up reinforces. Thumbs-down
  with "I meant…" retrains the classifier and stores an exact alias, so the
  next attempt works. Unhandled phrases are kept as "phrases I didn't
  understand", each with a one-click Teach action.
- **Acceptance.** "a correction is learned and reused" test.
- **Next.** Periodic offline evaluation of the classifier against held-out feedback.

### 2.9 Third-party services

- **Definition.** Connect APIs such as weather, news and social media.
- **Design.** `src/integrations/`: one catalog with each service's fields,
  environment variables, secret flags and a live connection test. It ships
  with Open-Meteo, Wikipedia, DuckDuckGo, RSS news, Home Assistant, Hue,
  Google Calendar, Mastodon, a Slack or Discord webhook, and the Anthropic API.
  Everything is configurable from the dashboard without a restart.
- **Next.** OAuth flows for Google and Microsoft; email; music playback.

### 2.10 User feedback

- **Definition.** Users rate performance; feedback refines the assistant.
- **Design.** Each reply shows how it was understood (intent, layer and
  confidence) with thumbs-up and thumbs-down. Feedback also works by voice
  ("that's wrong", "no, I meant…", "good job"). The Learning panel reports
  satisfaction, learned phrases, misses and an hourly activity chart.
  `GET /api/feedback/report` exposes the same data.

## 3. Claude integration details

- Model `claude-opus-5-5`, configurable with `JARVIS_LLM_MODEL`. Effort is
  `low` by default for conversational latency (`JARVIS_LLM_EFFORT`).
- Tools are generated from the skill registry, sent with `strict: true` and
  validated before they run.
- The tool runner is capped at 8 iterations. The system prompt is cached.
- Refusal fallbacks are enabled (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`), and a `refusal` stop reason is handled
  before content is read.
- Errors are classified with the SDK's typed exceptions. If the model is
  unavailable, JARVIS keeps working on rules.

## 4. Roadmap

| Phase | Scope |
|---|---|
| Now (v0.1) | Everything above: local-first, one user, browser client |
| Next | Multi-user profiles, OAuth calendar sync, Matter, routines as automations |
| Later | Mobile apps, on-device speech, federated multi-device sync |
