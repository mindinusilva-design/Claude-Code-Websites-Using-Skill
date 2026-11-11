// Conversation panel: messages, explainability line, feedback and teaching.
import { h, icon, $, clear, toast } from './dom.js';
import { api, sessionId } from './api.js';
import { renderCard } from './cards.js';

const SOURCE_LABEL = {
  rules: 'matched a command',
  learned: 'a phrase you taught me',
  classifier: 'a learned pattern',
  clarification: 'your answer',
  'language-model': 'Claude',
  none: 'not understood',
};

const STARTERS = [
  { icon: 'light', text: 'Turn on the living room lights' },
  { icon: 'bell', text: 'Remind me to stretch in 20 minutes' },
  { icon: 'w-partly', text: "What's the weather tomorrow?" },
  { icon: 'task', text: 'Add a task to book flights by Friday' },
  { icon: 'news', text: 'Give me the latest headlines' },
  { icon: 'sparkle', text: 'What can you do?' },
];

export function createChat(app) {
  const list = $('#messages');
  let typing = null;

  const scrollDown = () => { list.scrollTop = list.scrollHeight; };

  function welcome() {
    if (list.childElementCount) return;
    const grid = h('div', { class: 'starter-grid' });
    for (const starter of STARTERS) {
      grid.append(h('button', { class: 'starter', type: 'button', onclick: () => app.send(starter.text) }, icon(starter.icon), h('span', { text: starter.text })));
    }
    list.append(h('div', { class: 'welcome', id: 'welcome' },
      h('h2', { text: 'At your service.' }),
      h('p', { text: 'Type or speak. I can run your home, keep your day in order, and look things up. Here are a few things to try.' }),
      grid,
    ));
  }

  function addUser(text, { voice = false } = {}) {
    $('#welcome')?.remove();
    list.append(h('article', { class: `msg msg-user ${voice ? 'msg-voice' : ''}`, 'aria-label': 'You said' }, h('div', { class: 'bubble', text })));
    scrollDown();
  }

  function showTyping() {
    hideTyping();
    typing = h('article', { class: 'msg msg-jarvis', 'aria-label': 'JARVIS is working' }, h('div', { class: 'bubble' }, h('span', { class: 'typing' }, h('i'), h('i'), h('i'))));
    list.append(typing);
    scrollDown();
  }
  function hideTyping() {
    typing?.remove();
    typing = null;
  }

  function teachForm(message, context) {
    const input = h('input', { type: 'text', placeholder: 'What did you mean? For example: turn on the kitchen lights', 'aria-label': 'What did you mean?', maxlength: 300 });
    const note = h('div', { class: 'teach-note' });
    const form = h('form', { class: 'teach' }, input, h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Teach'), note);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const comment = input.value.trim();
      if (!comment) return;
      try {
        const { feedback } = await api('/api/feedback', { method: 'POST', body: { ...context, rating: 'down', comment, sessionId } });
        clear(form);
        if (feedback.learned?.alias) {
          form.append(
            h('span', { class: 'teach-note', text: `Learned. "${context.utterance}" now means "${feedback.learned.alias}".` }),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => app.send(feedback.learned.alias) }, 'Run it now'),
          );
        } else if (feedback.learned) {
          form.append(h('span', { class: 'teach-note', text: 'Thanks. I have adjusted how I read that phrase.' }));
        } else {
          form.append(h('span', { class: 'teach-note', text: "Thanks. I couldn't map that to a command yet, but I've recorded it." }));
        }
        app.refresh();
      } catch (error) {
        note.textContent = error.message;
      }
    });
    message.append(form);
    input.focus();
  }

  function meta(message, result, utterance) {
    const top = result.intents?.[0];
    const footer = h('footer', { class: 'msg-meta' });
    if (result.source) {
      const label = SOURCE_LABEL[result.source] ?? result.source;
      const why = h('span', { class: 'why', title: 'How JARVIS understood this' });
      if (top && result.source !== 'none') why.append(h('b', { text: top.intent }), ` · ${label}${result.source !== 'language-model' ? ` · ${Math.round((top.confidence ?? 0) * 100)}%` : ''}`);
      else why.append(label);
      footer.append(why);
    }
    if (result.turnId || utterance) {
      const context = { turnId: result.turnId ?? null, utterance: utterance ?? null, intent: top?.intent ?? null };
      const up = h('button', { class: 'icon-btn', type: 'button', 'aria-pressed': 'false', title: 'Good answer' }, icon('thumb-up', { size: 15 }), h('span', { class: 'sr-only', text: 'Good answer' }));
      const down = h('button', { class: 'icon-btn is-down', type: 'button', 'aria-pressed': 'false', title: 'Wrong, let me correct it' }, icon('thumb-down', { size: 15 }), h('span', { class: 'sr-only', text: 'Wrong, let me correct it' }));
      up.addEventListener('click', async () => {
        if (up.getAttribute('aria-pressed') === 'true') return;
        try {
          await api('/api/feedback', { method: 'POST', body: { ...context, rating: 'up', sessionId } });
          up.setAttribute('aria-pressed', 'true');
          down.disabled = true;
          app.refresh();
        } catch (error) { toast(error.message, { kind: 'error' }); }
      });
      down.addEventListener('click', () => {
        if (down.getAttribute('aria-pressed') === 'true') return;
        down.setAttribute('aria-pressed', 'true');
        up.disabled = true;
        teachForm(message, context);
      });
      footer.append(up, down);
    }
    if (app.voice.canSpeak) {
      footer.append(h('button', { class: 'icon-btn', type: 'button', title: 'Read aloud', onclick: () => app.voice.speak(result.reply.speech || result.reply.text) }, icon('speaker', { size: 15 }), h('span', { class: 'sr-only', text: 'Read aloud' })));
    }
    return footer;
  }

  function addJarvis(result, { utterance = null } = {}) {
    hideTyping();
    $('#welcome')?.remove();
    const message = h('article', { class: 'msg msg-jarvis', 'aria-label': 'JARVIS replied' }, h('div', { class: 'bubble', text: result.reply.text }));
    if (result.reply.cards?.length) {
      const cards = h('div', { class: 'cards' });
      for (const card of result.reply.cards) cards.append(renderCard(card, app));
      message.append(cards);
    }
    message.append(meta(message, result, utterance));
    list.append(message);
    scrollDown();
    return message;
  }

  /** A proactive message from JARVIS, e.g. a reminder that just came due. */
  function addNotice(text, actions = []) {
    $('#welcome')?.remove();
    const message = h('article', { class: 'msg msg-jarvis msg-notice', 'aria-label': 'JARVIS notice' }, h('div', { class: 'bubble' }, icon('bell', { size: 16 }), ' ', text));
    if (actions.length) {
      const row = h('div', { class: 'device-controls' });
      for (const action of actions) row.append(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { action.run(); row.remove(); } }, action.label));
      message.append(row);
    }
    list.append(message);
    scrollDown();
  }

  function restore(turns) {
    for (const turn of turns) {
      addUser(turn.utterance);
      addJarvis({ turnId: turn.turnId, reply: { text: turn.reply, cards: [] }, intents: turn.intents, source: turn.source }, { utterance: turn.utterance });
    }
    welcome();
  }

  return { welcome, addUser, addJarvis, addNotice, showTyping, hideTyping, restore, clearAll: () => { clear(list); welcome(); } };
}
