// Settings dialog: profile and voice, privacy controls, integrations, skills.
import { h, icon, $, clear, toast, confirmDialog } from './dom.js';
import { api } from './api.js';

export function createSettings(app) {
  const dialog = $('#settings');
  const body = $('#settings-body');
  const tabs = [...dialog.querySelectorAll('.tab-btn')];
  let current = 'profile';

  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  for (const tab of tabs) tab.addEventListener('click', () => show(tab.dataset.tab));

  const field = (label, control, hint = null) => h('label', { class: 'field' }, h('span', { text: label }), control, hint ? h('small', { text: hint }) : null);
  const toggleRow = (title, hint, checked, onChange) => {
    const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(Boolean(checked)), 'aria-label': title });
    sw.addEventListener('click', async () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(next));
      try { await onChange(next); } catch (error) { sw.setAttribute('aria-checked', String(!next)); toast(error.message, { kind: 'error' }); }
    });
    return h('div', { class: 'toggle-row' }, h('div', {}, h('b', { text: title }), h('small', { text: hint })), sw);
  };

  // ------------------------------------------------------------- You
  async function profileTab() {
    const { profile } = await api('/api/profile');
    const name = h('input', { type: 'text', value: profile.name ?? '', maxlength: 60, placeholder: 'What should I call you?' });
    const location = h('input', { type: 'text', value: profile.location ?? '', maxlength: 80, placeholder: 'City for weather and local info' });
    const units = h('select', {}, h('option', { value: 'metric', selected: profile.units === 'metric' }, 'Metric (°C, km/h)'), h('option', { value: 'imperial', selected: profile.units === 'imperial' }, 'Imperial (°F, mph)'));
    const topics = h('input', { type: 'text', value: (profile.newsTopics ?? []).join(', '), maxlength: 200, placeholder: 'technology, science, football' });
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');
    const form = h('form', { class: 'stack' },
      h('div', { class: 'field-row' }, field('Name', name), field('Home city', location)),
      h('div', { class: 'field-row' }, field('Units', units), field('News topics', topics, 'Comma-separated. Used for your briefing and the News panel.')),
      h('div', {}, save),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        await api('/api/profile', { method: 'PUT', body: { name: name.value, location: location.value, units: units.value, newsTopics: topics.value.split(',') } });
        toast('Saved your preferences.', { iconName: 'check' });
        app.refresh();
      } catch (error) { toast(error.message, { kind: 'error' }); }
      save.disabled = false;
    });

    const voiceGroup = h('div', { class: 'group' }, h('h3', { text: 'Voice' }));
    await voiceSection(voiceGroup, profile);
    if ('Notification' in window) {
      const granted = Notification.permission === 'granted';
      voiceGroup.append(h('div', { class: 'toggle-row' },
        h('div', {}, h('b', { text: 'Desktop notifications' }), h('small', { text: granted ? 'Reminders appear as system notifications.' : 'Show reminders as system notifications, even when this tab is in the background.' })),
        granted ? h('span', { class: 'integration-state' }, h('span', { class: 'status-dot is-on' }), 'On') : h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { await Notification.requestPermission(); show('profile'); } }, 'Enable'),
      ));
    }
    const layout = h('select', { 'aria-label': 'Interface style' },
      h('option', { value: 'hud', selected: app.hud.layout() === 'hud' }, 'HUD (holographic control center)'),
      h('option', { value: 'classic', selected: app.hud.layout() === 'classic' }, 'Classic (light or dark dashboard)'),
    );
    layout.addEventListener('change', () => { app.hud.setLayout(layout.value); app.refresh(); });
    const interfaceGroup = h('div', { class: 'group' }, h('h3', { text: 'Interface' }), field('Style', layout, 'The HUD shows the live core, diagnostics and dock. Classic is a calmer dashboard with a light theme option.'));
    return [h('div', { class: 'group' }, h('h3', { text: 'About you' }), form), interfaceGroup, voiceGroup];
  }

  // ------------------------------------------------------------- Voice
  async function voiceSection(group, profile) {
    const prefs = app.voicePrefs();
    const v = app.voice;
    let server = { tts: null, stt: null, voices: [], error: null };
    try { server = await api('/api/voice'); } catch { /* the browser voice still works */ }

    group.append(toggleRow('Speak replies', 'JARVIS reads its answers aloud. It always answers out loud when you speak to it.', prefs.speak, (on) => app.setVoicePrefs({ speak: on })));

    // Which voice engine.
    const engine = h('select', { 'aria-label': 'Voice engine' },
      h('option', { value: 'cloud', disabled: !server.tts, selected: prefs.engine !== 'browser' && Boolean(server.tts) }, server.tts ? 'Natural voice (ElevenLabs)' : 'Natural voice (connect ElevenLabs first)'),
      h('option', { value: 'browser', selected: prefs.engine === 'browser' || !server.tts, disabled: !v.canBrowserSpeak }, 'Browser voice (offline, built in)'),
    );
    const voicePicker = h('div', { class: 'stack' });
    const renderPicker = () => {
      clear(voicePicker);
      const useCloud = engine.value === 'cloud';
      const select = h('select', { 'aria-label': 'Voice' });
      if (useCloud) {
        const current = app.voicePrefs().voiceId ?? server.tts?.voiceId;
        const voices = server.voices.length ? server.voices : [{ id: server.tts?.voiceId, name: 'Default voice', description: '' }];
        for (const voice of voices) select.append(h('option', { value: voice.id, selected: voice.id === current }, voice.description ? `${voice.name} (${voice.description})` : voice.name));
        select.addEventListener('change', () => app.setVoicePrefs({ voiceId: select.value }));
      } else {
        const current = app.voicePrefs().browserVoice;
        select.append(h('option', { value: '' }, 'Automatic (prefers a British voice)'));
        for (const voice of v.browserVoices()) select.append(h('option', { value: voice.voiceURI, selected: voice.voiceURI === current }, `${voice.name} (${voice.lang})`));
        select.addEventListener('change', () => app.setVoicePrefs({ browserVoice: select.value || null }));
      }
      const preview = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => v.speak(`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}${profile.name ? `, ${profile.name}` : ''}. All systems are online and ready when you are.`) }, icon('speaker', { size: 15 }), 'Preview');
      voicePicker.append(h('label', { class: 'field' }, h('span', { text: 'Voice' }), h('div', { class: 'quick-add' }, select, preview)));
      if (useCloud && server.error) voicePicker.append(h('small', { class: 'field', text: `Could not load your ElevenLabs voices (${server.error}). The configured voice is used.` }));
    };
    engine.addEventListener('change', () => { app.setVoicePrefs({ engine: engine.value }); renderPicker(); });
    renderPicker();
    group.append(field('Voice engine', engine, server.tts ? 'The natural voice sends reply text to ElevenLabs. The browser voice keeps everything on this device.' : 'Add an ElevenLabs API key under Integrations for a natural, expressive voice.'), voicePicker);

    const rate = h('input', { type: 'range', min: 70, max: 140, step: 5, value: String(Math.round(prefs.rate * 100)), 'aria-label': 'Speech rate' });
    const paint = () => rate.style.setProperty('--fill', `${((rate.value - 70) / 70) * 100}%`);
    paint();
    rate.addEventListener('input', paint);
    rate.addEventListener('change', () => { app.setVoicePrefs({ rate: Number(rate.value) / 100 }); v.speak('This is how I sound at this speed.'); });
    group.append(field('Speech rate', rate));

    // How JARVIS listens.
    const hasBrowserStt = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    const stt = h('select', { 'aria-label': 'Speech recognition' },
      h('option', { value: 'browser', disabled: !hasBrowserStt, selected: prefs.sttEngine !== 'cloud' && hasBrowserStt }, hasBrowserStt ? 'Browser recognition (supports hands-free)' : 'Browser recognition (not supported here)'),
      h('option', { value: 'cloud', disabled: !(server.stt && v.canRecord), selected: prefs.sttEngine === 'cloud' || (!hasBrowserStt && Boolean(server.stt)) }, server.stt ? 'ElevenLabs Scribe (works in every browser)' : 'ElevenLabs Scribe (connect ElevenLabs first)'),
    );
    stt.addEventListener('change', () => { app.setVoicePrefs({ sttEngine: stt.value, handsFree: stt.value === 'cloud' ? false : app.voicePrefs().handsFree }); show('profile'); });
    group.append(field('Speech recognition', stt, 'Shortcut: Alt+V starts and stops listening. Esc stops JARVIS speaking.'));

    if (v.canHandsFree) {
      group.append(toggleRow('Hands-free', `Keep listening and act when you say "${profile.wakeWord ?? 'jarvis'}". Uses the microphone continuously.`, prefs.handsFree, (on) => app.setVoicePrefs({ handsFree: on })));
    }
    group.append(h('div', { class: 'callout' }, icon('info'), h('span', {
      text: v.listenEngine === 'cloud'
        ? 'JARVIS records only while the microphone button is lit and stops when you pause. The clip goes to ElevenLabs for transcription and is not stored by JARVIS.'
        : v.listenEngine === 'browser'
          ? 'Browser recognition is provided by your browser. Some browsers send audio to their own speech service; JARVIS only receives the text.'
          : 'This browser has no speech recognition. Connect ElevenLabs under Integrations to talk to JARVIS here.',
    })));
  }

  // ------------------------------------------------------------- Privacy
  async function privacyTab() {
    const [report, audit, { profile }] = await Promise.all([api('/api/privacy'), api('/api/privacy/audit?limit=15'), api('/api/profile')]);
    const kv = h('dl', { class: 'kv' });
    const add = (k, v) => kv.append(h('dt', { text: k }), h('dd', { text: v }));
    add('Where it lives', report.storage);
    add('Encryption', `${report.encryption.algorithm}, key from ${report.encryption.keySource}`);
    add('Language model', report.languageModel);
    if (report.voice) add('Voice', report.voice);
    add('What is stored', Object.entries(report.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${n === 1 ? k.replace(/ies$/, 'y').replace(/s$/, '') : k}`).join(', ') || 'Nothing yet');
    if (report.thirdParties.length) add('Outside services', report.thirdParties.map((t) => `${t.name} (${t.sends})`).join('; '));

    const days = h('input', { type: 'number', min: 1, max: 3650, value: String(profile.retentionDays ?? 30) });
    days.addEventListener('change', async () => {
      try {
        await api('/api/profile', { method: 'PUT', body: { retentionDays: Number(days.value) } });
        toast(`Conversation history is now kept for ${days.value} days.`, { iconName: 'check' });
      } catch (error) { toast(error.message, { kind: 'error' }); }
    });

    const wipe = (scope, label, text) => h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        if (!(await confirmDialog({ title: label, text, confirmLabel: 'Delete permanently' }))) return;
        try {
          await api(`/api/privacy/data?scope=${scope}`, { method: 'DELETE', headers: { 'x-confirm': 'delete' } });
          toast('Deleted.', { iconName: 'check' });
          if (scope !== 'learning') app.chat.clearAll();
          app.refresh();
          show('privacy');
        } catch (error) { toast(error.message, { kind: 'error' }); }
      },
    }, icon('trash', { size: 15 }), label);

    const log = h('div', { class: 'audit' });
    for (const entry of audit.entries) {
      log.append(h('div', {}, h('time', { text: new Date(entry.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }), `${entry.action} (${entry.actor})`));
    }

    return [
      h('div', { class: 'group' }, h('h3', { text: 'What JARVIS holds' }), kv),
      h('div', { class: 'group' }, h('h3', { text: 'Controls' }),
        toggleRow('Incognito mode', 'Nothing from the conversation is saved or learned from while this is on.', profile.incognito, async (on) => { await api('/api/profile', { method: 'PUT', body: { incognito: on } }); app.refresh(); }),
        field('Keep conversation history for (days)', days),
        h('div', {}, h('button', { class: 'btn', type: 'button', onclick: () => app.download('/api/privacy/export', 'jarvis-export.json') }, icon('download', { size: 15 }), 'Export all my data')),
      ),
      report.passphrase?.supported ? passphraseGroup(report.passphrase.enabled) : null,
      h('div', { class: 'group' }, h('h3', { text: 'Delete data' }),
        h('div', { class: 'callout is-danger' }, icon('alert'), h('span', { text: 'Deleting is permanent. Export first if you want a copy.' })),
        h('div', { class: 'danger-actions' },
          wipe('history', 'Delete conversation history', 'This removes every saved conversation turn.'),
          wipe('learning', 'Reset what JARVIS learned', 'This removes learned phrases, habits, interests and feedback.'),
          wipe('all', 'Delete everything', 'This removes all conversations, tasks, reminders, events, preferences, learning and saved credentials.'),
        ),
      ),
      h('div', { class: 'group' }, h('h3', { text: 'Recent activity log' }), audit.entries.length ? log : h('p', { class: 'empty', text: 'No activity recorded yet.' })),
    ];
  }

  // Standalone page only: encrypt the data kept in this browser.
  function passphraseGroup(enabled) {
    const pass = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, placeholder: 'At least 8 characters' });
    const again = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Type it again' });
    const note = h('small', { class: 'field' });
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, enabled ? 'Change passphrase' : 'Encrypt my data');
    const form = h('form', { class: 'stack' }, h('div', { class: 'field-row' }, h('label', { class: 'field' }, h('span', { text: enabled ? 'New passphrase' : 'Passphrase' }), pass), h('label', { class: 'field' }, h('span', { text: 'Confirm' }), again)), note, h('div', { class: 'danger-actions' }, save,
      enabled ? h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          if (!(await confirmDialog({ title: 'Remove the passphrase?', text: 'Your data will be stored in this browser without encryption.', confirmLabel: 'Remove' }))) return;
          await api('/api/privacy/passphrase', { method: 'POST', body: { passphrase: null } });
          toast('Passphrase removed.', { iconName: 'unlock' });
          app.refresh();
          show('privacy');
        },
      }, 'Remove passphrase') : null));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (pass.value.length < 8) { note.textContent = 'Use at least 8 characters.'; return; }
      if (pass.value !== again.value) { note.textContent = 'The two passphrases do not match.'; return; }
      save.disabled = true;
      note.textContent = 'Encrypting';
      try {
        await api('/api/privacy/passphrase', { method: 'POST', body: { passphrase: pass.value } });
        toast('Your data is now encrypted. You will need the passphrase to open JARVIS.', { iconName: 'lock', timeout: 7000 });
        app.refresh();
        show('privacy');
      } catch (error) {
        note.textContent = error.message;
        save.disabled = false;
      }
    });
    return h('div', { class: 'group' }, h('h3', { text: 'Passphrase lock' }),
      h('div', { class: 'callout' }, icon('lock'), h('span', { text: enabled
        ? 'Everything JARVIS keeps in this browser is encrypted with AES-256. You are asked for the passphrase each time the page opens.'
        : 'This page keeps your data in this browser. Set a passphrase to encrypt it with AES-256. There is no way to recover a forgotten passphrase.' })),
      form);
  }

  // ------------------------------------------------------------- Integrations
  async function integrationsTab() {
    const { integrations } = await api('/api/integrations');
    const out = [h('div', { class: 'callout' }, icon('lock'), h('span', { text: 'Credentials you enter here are encrypted on this machine and are never sent back to the browser.' }))];
    const categories = [...new Set(integrations.map((i) => i.category))];
    for (const category of categories) {
      const group = h('div', { class: 'group' }, h('h3', { text: category }));
      for (const item of integrations.filter((i) => i.category === category)) {
        const result = h('div', { class: 'integration-result' });
        const inputs = new Map();
        const fields = h('div', { class: 'stack' });
        for (const f of item.fields) {
          const input = h('input', {
            type: f.secret ? 'password' : 'text', autocomplete: 'off', maxlength: 2000,
            value: f.secret ? '' : f.value ?? '',
            placeholder: f.secret && f.set ? `Saved (from ${f.source})` : f.placeholder,
          });
          inputs.set(f.key, input);
          fields.append(field(`${f.label}${f.required ? '' : ' (optional)'}`, input));
        }
        const test = h('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: async () => {
            test.disabled = true;
            clear(result).append('Testing');
            result.className = 'integration-result';
            try {
              const outcome = await api(`/api/integrations/${item.id}/test`, { method: 'POST' });
              result.className = `integration-result ${outcome.ok ? 'is-ok' : 'is-bad'}`;
              clear(result).append(icon(outcome.ok ? 'check' : 'alert', { size: 14 }), `${outcome.message}${outcome.ms != null ? ` (${outcome.ms} ms)` : ''}`);
            } catch (error) {
              result.className = 'integration-result is-bad';
              clear(result).append(icon('alert', { size: 14 }), error.message);
            }
            test.disabled = false;
          },
        }, 'Test connection');
        const actions = h('div', { class: 'device-controls' });
        if (item.fields.length) {
          actions.append(h('button', {
            class: 'btn btn-sm btn-primary', type: 'button',
            onclick: async () => {
              const values = {};
              for (const [key, input] of inputs) {
                const f = item.fields.find((x) => x.key === key);
                if (f.secret && !input.value) continue; // leave saved secrets untouched
                values[key] = input.value;
              }
              try {
                await api(`/api/integrations/${item.id}`, { method: 'PUT', body: { values } });
                toast(`${item.name} saved.`, { iconName: 'check' });
                app.refresh();
                show('integrations');
              } catch (error) { toast(error.message, { kind: 'error' }); }
            },
          }, 'Save'));
        }
        actions.append(test);
        group.append(h('div', { class: 'integration' },
          h('div', { class: 'integration-head' },
            h('h4', { text: item.name }),
            h('span', { class: 'integration-state' }, h('span', { class: `status-dot ${item.configured ? 'is-on' : ''}` }), item.configured ? (item.builtIn ? 'Built in' : 'Connected') : 'Not connected'),
          ),
          h('p', { text: item.description }),
          item.fields.length ? fields : null,
          actions,
          result,
        ));
      }
      out.push(group);
    }
    return out;
  }

  // ------------------------------------------------------------- Skills
  async function skillsTab() {
    const { skills } = await api('/api/skills');
    const out = [];
    for (const skill of skills) {
      const examples = h('div', { class: 'examples' });
      for (const example of skill.examples) examples.append(h('button', { class: 'example', type: 'button', text: example, onclick: () => { dialog.close(); app.send(example); } }));
      out.push(h('div', { class: 'integration' },
        h('div', { class: 'integration-head' }, h('h4', { text: skill.name }), h('span', { class: 'integration-state', text: `${skill.intents.length} intents${skill.tools.length ? `, ${skill.tools.length} tools` : ''}` })),
        h('p', { text: skill.description }),
        examples,
      ));
    }
    return out;
  }

  const renderers = { profile: profileTab, privacy: privacyTab, integrations: integrationsTab, skills: skillsTab };

  async function show(tab = current) {
    current = renderers[tab] ? tab : 'profile';
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === current));
    clear(body).append(h('p', { class: 'empty', text: 'Loading' }));
    try {
      const content = await renderers[current]();
      clear(body).append(...content);
    } catch (error) {
      clear(body).append(h('p', { class: 'empty', text: error.message }));
    }
  }

  return {
    open(tab = 'profile') {
      if (!dialog.open) dialog.showModal();
      show(tab);
    },
  };
}
