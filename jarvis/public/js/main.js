// Bootstrap: wires chat, voice, dashboard, settings and live events together.
import { h, icon, $, clear, toast, debounce } from './dom.js';
import { api, withSession, openEvents, sessionId, getToken, fetchSpeech, transcribe } from './api.js';
import { Voice } from './voice.js';
import { createChat } from './chat.js';
import { renderDashboard, renderSuggestions, markStale } from './dashboard.js';
import { createSettings } from './settings.js';
import { createHud } from './hud.js';

const VOICE_KEY = 'jarvis.voice';
const THEME_KEY = 'jarvis.theme';

const els = {
  app: $('#app'), orb: $('#orb'), status: $('#status-line'), chips: $('#status-chips'), input: $('#input'), composer: $('#composer'),
  mic: $('#mic'), send: $('#send'), hint: $('#composer-hint'), voiceToggle: $('#voice-toggle'), themeToggle: $('#theme-toggle'),
};

const state = { busy: false, online: true, dashboard: null, orb: 'idle', greeting: 'Online' };

// JARVIS talks by default; every choice here can be changed in Settings, You, Voice.
const VOICE_DEFAULTS = { speak: true, rate: 1, handsFree: false, engine: 'auto', sttEngine: 'auto', voiceId: null, browserVoice: null };
function loadVoicePrefs() {
  try { return { ...VOICE_DEFAULTS, ...JSON.parse(localStorage.getItem(VOICE_KEY) ?? '{}') }; } catch { return { ...VOICE_DEFAULTS }; }
}
let voicePrefs = loadVoicePrefs();

function setOrb(next, line = null) {
  const lines = { idle: state.greeting, listening: 'Listening', standby: 'Hands-free: say "Jarvis"', thinking: 'Working on it', transcribing: 'Transcribing', speaking: 'Speaking', offline: 'Offline. Reconnecting' };
  els.status.textContent = line ?? lines[next] ?? state.greeting;
  const visual = next === 'transcribing' ? 'thinking' : next; // transcribing looks like thinking
  state.orb = visual;
  els.orb.dataset.state = visual;
  app.hud?.setState(visual, els.status.textContent);
}

const app = {
  voice: null,
  chat: null,
  settings: null,
  voicePrefs: () => ({ ...voicePrefs }),
  setVoicePrefs(patch) {
    voicePrefs = { ...voicePrefs, ...patch };
    try { localStorage.setItem(VOICE_KEY, JSON.stringify(voicePrefs)); } catch { /* storage unavailable */ }
    applyVoicePrefs();
  },
  openSettings: (tab) => app.settings.open(tab),
  refresh: debounce(() => loadDashboard(), 200),

  async send(text, { channel = 'text' } = {}) {
    const message = String(text ?? '').trim();
    if (!message || state.busy) return;
    state.busy = true;
    els.send.disabled = true;
    app.chat.addUser(message, { voice: channel === 'voice' });
    app.chat.showTyping();
    setOrb('thinking');
    const started = performance.now();
    try {
      const result = await api('/api/chat', { method: 'POST', body: { text: message, sessionId, channel } });
      app.hud?.setLatency(Math.round(performance.now() - started));
      app.chat.addJarvis(result, { utterance: message });
      renderSuggestions(result.suggestions, app);
      setOrb('idle');
      if (voicePrefs.speak || channel === 'voice') app.voice.speak(result.reply.speech || result.reply.text);
      app.refresh();
    } catch (error) {
      app.chat.hideTyping();
      app.chat.addJarvis({ reply: { text: error.message, cards: [] }, intents: [], source: null });
      setOrb(error.status === 0 ? 'offline' : 'idle');
    } finally {
      state.busy = false;
      els.send.disabled = false;
    }
  },

  async deviceCommand(id, command, params) {
    const { device } = await api(`/api/devices/${encodeURIComponent(id)}/command`, { method: 'POST', body: { command, params } });
    return device;
  },

  /** Download a protected file (keeps the access token in a header, not the URL). */
  async download(url, filename) {
    try {
      const headers = getToken() ? { authorization: `Bearer ${getToken()}` } : {};
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = h('a', { href: blobUrl, download: filename });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    } catch (error) { toast(error.message, { kind: 'error' }); }
  },
};

function applyVoicePrefs() {
  app.voice.configure({ settings: { engine: voicePrefs.engine, sttEngine: voicePrefs.sttEngine, voiceId: voicePrefs.voiceId, browserVoice: voicePrefs.browserVoice, rate: voicePrefs.rate } });
  els.mic.disabled = !app.voice.canListen;
  els.mic.title = app.voice.canListen ? `Speak to JARVIS (Alt+V)${app.voice.listenEngine === 'cloud' ? ', transcribed by ElevenLabs' : ''}` : 'Voice input is not supported in this browser. Connect ElevenLabs in Settings to enable it.';
  const speakOn = voicePrefs.speak && app.voice.canSpeak;
  els.voiceToggle.setAttribute('aria-pressed', String(speakOn));
  app.hud?.setVoicePressed(speakOn);
  clear(els.voiceToggle).append(icon(speakOn ? 'speaker' : 'speaker-off', { size: 20 }), h('span', { class: 'sr-only', text: 'Read replies aloud' }));
  els.voiceToggle.hidden = !app.voice.canSpeak;
  if (!speakOn) app.voice.cancelSpeech();
  if (app.voice.canListen) {
    const wake = state.dashboard?.profile?.wakeWord ?? 'jarvis';
    if (voicePrefs.handsFree !== app.voice.handsFree && !app.voice.setHandsFree(voicePrefs.handsFree, wake)) voicePrefs.handsFree = false;
  }
  updateHint();
}

function updateHint(live = null) {
  els.hint.classList.toggle('is-live', Boolean(live));
  if (live) els.hint.textContent = live;
  else if (!app.voice.canListen) els.hint.textContent = 'Voice input needs Chrome, Edge or Safari, or ElevenLabs connected in Settings. Typing works everywhere.';
  else if (voicePrefs.handsFree) els.hint.textContent = 'Hands-free is on. Say "Jarvis" followed by what you need.';
  else els.hint.textContent = `Press the microphone or Alt+V to talk${app.voice.listenEngine === 'cloud' ? ' (I stop listening when you pause)' : ''}. Esc stops me speaking.`;
}

function renderChips(data) {
  clear(els.chips);
  els.chips.append(data.llm.enabled
    ? h('span', { class: 'chip chip-accent', title: `Open-ended conversation is handled by ${data.llm.model}` }, icon('sparkle', { size: 14 }), h('span', { text: 'Claude connected' }))
    : h('button', { class: 'chip', type: 'button', title: 'Commands work offline. Connect Claude in Settings for open-ended conversation.', onclick: () => app.openSettings('integrations') }, icon('info', { size: 14 }), h('span', { text: 'Built-in understanding' })));
  const natural = app.voice.speakEngine === 'cloud';
  els.chips.append(h('button', {
    class: `chip ${natural ? 'chip-accent' : ''}`, type: 'button',
    title: natural ? 'JARVIS speaks with a natural ElevenLabs voice. Change it in Settings.' : 'JARVIS speaks with your browser voice. Connect ElevenLabs in Settings for a natural voice.',
    onclick: () => app.openSettings('profile'),
  }, icon('speaker', { size: 14 }), h('span', { text: natural ? 'Natural voice' : 'Browser voice' })));
  els.chips.append(h('span', { class: 'chip', title: `${data.security.encryption.algorithm}, key from ${data.security.encryption.keySource}` }, icon('lock', { size: 14 }), h('span', { text: 'Encrypted' })));
  if (data.security.incognito) els.chips.append(h('span', { class: 'chip chip-warm', title: 'Nothing is being saved or learned' }, icon('eye-off', { size: 14 }), h('span', { text: 'Incognito' })));
}

async function loadDashboard() {
  markStale(true);
  try {
    const data = await api(withSession('/api/dashboard'));
    state.dashboard = data;
    app.voice.configure({ server: { tts: Boolean(data.voice?.tts), stt: Boolean(data.voice?.stt) } });
    applyVoicePrefs();
    const hour = new Date(data.now).getHours();
    const part = hour < 5 ? 'evening' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    state.greeting = `Online. Good ${part}${data.profile.name ? `, ${data.profile.name}` : ''}`;
    if (!state.online || ['idle', 'offline'].includes(state.orb)) setOrb(app.voice.handsFree && app.voice.listening ? 'standby' : 'idle');
    state.online = true;
    renderChips(data);
    renderDashboard(data, app);
    app.hud?.render(data);
    renderSuggestions(data.suggestions, app);
  } catch (error) {
    if (error.status === 0) { state.online = false; setOrb('offline'); }
  } finally {
    markStale(false);
  }
}

function onReminder({ reminder }) {
  if (!reminder) return;
  const text = `Reminder: ${reminder.text}`;
  app.chat.addNotice(text, [
    { label: 'Snooze 10 minutes', run: async () => { await api(`/api/reminders/${reminder.id}/snooze`, { method: 'POST', body: { minutes: 10 } }); toast('Snoozed for 10 minutes.', { iconName: 'bell', kind: 'warm' }); app.refresh(); } },
    { label: 'Done', run: () => {} },
  ]);
  toast(text, { kind: 'warm', iconName: 'bell', timeout: 9000 });
  if (voicePrefs.speak) app.voice.speak(text);
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification('JARVIS', { body: text, tag: reminder.id }); } catch { /* notifications are optional */ }
  }
  app.refresh();
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage unavailable */ }
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  const effective = () => document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const paint = () => clear(els.themeToggle).append(icon(effective() === 'dark' ? 'sun' : 'moon', { size: 20 }), h('span', { class: 'sr-only', text: 'Switch between light and dark' }));
  paint();
  els.themeToggle.addEventListener('click', () => {
    const next = effective() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
    paint();
  });
}

async function start() {
  initTheme();
  app.voice = new Voice({
    fetchSpeech,
    transcribe,
    onTranscript: (text) => { updateHint(); els.input.value = ''; app.send(text, { channel: 'voice' }); },
    onInterim: (text) => updateHint(`Hearing: ${text}`),
    onLevel: (level) => { els.orb.style.setProperty('--level', level.toFixed(3)); app.hud?.setLevel(level); },
    onWake: () => { if (voicePrefs.speak) app.voice.speak('Yes?'); },
    onVoicesChanged: () => {},
    onState: (next, line) => {
      els.mic.setAttribute('aria-pressed', String(next === 'listening'));
      if (state.busy && next === 'idle') return;
      setOrb(next === 'standby' ? 'standby' : next, line);
      if (next === 'idle' || next === 'standby') updateHint();
      if (next === 'listening') updateHint(line ?? 'Listening. Speak now.');
      if (next === 'transcribing') updateHint('Transcribing what you said');
    },
    onError: (message, { soft = false } = {}) => {
      toast(message, { kind: soft ? 'info' : 'error' });
      if (!soft) { voicePrefs.handsFree = false; setOrb('idle'); }
      updateHint();
    },
  });
  app.chat = createChat(app);
  app.settings = createSettings(app);
  app.hud = createHud(app);

  const toggleMic = () => {
    if (app.voice.listening && !app.voice.handsFree) app.voice.stop();
    else app.voice.listenOnce(); // also interrupts JARVIS if it is speaking
  };
  els.mic.addEventListener('click', toggleMic);
  els.voiceToggle.addEventListener('click', () => app.setVoicePrefs({ speak: !voicePrefs.speak }));
  $('#open-settings').addEventListener('click', () => app.openSettings('profile'));

  els.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = els.input.value;
    els.input.value = '';
    app.send(text);
  });

  for (const tab of document.querySelectorAll('.tabbar .tab')) {
    tab.addEventListener('click', () => {
      els.app.dataset.view = tab.dataset.view;
      for (const other of document.querySelectorAll('.tabbar .tab')) other.setAttribute('aria-pressed', String(other === tab));
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.altKey && (event.code === 'KeyV') && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      if (!els.mic.disabled) toggleMic();
      return;
    }
    if (event.key === 'Escape' && app.voice.speaking) {
      app.voice.cancelSpeech();
      setOrb('idle');
      return;
    }
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      els.input.focus();
    }
  });

  try {
    const { turns } = await api(withSession('/api/history?limit=20'));
    app.chat.restore(turns);
  } catch {
    app.chat.welcome();
  }
  await loadDashboard();
  applyVoicePrefs();

  const refreshSoon = debounce(() => loadDashboard(), 400);
  openEvents({
    'reminder.due': onReminder,
    'reminder.changed': refreshSoon,
    'device.changed': refreshSoon,
    'task.changed': refreshSoon,
    'calendar.changed': refreshSoon,
    'learning.updated': refreshSoon,
    'integrations.changed': refreshSoon,
    'privacy.forgotten': refreshSoon,
    open: () => { if (!state.online) { state.online = true; loadDashboard(); } },
    error: () => { state.online = false; setOrb('offline'); },
  });
  setInterval(loadDashboard, 60_000);
  els.input.focus();
}

start();
