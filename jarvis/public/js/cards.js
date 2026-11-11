// Rich result cards shown under a JARVIS reply.
import { h, icon, externalLink, safeUrl, cap } from './dom.js';
import { deviceTile } from './devices.js';

const WEATHER_ICON = { sun: 'w-sun', partly: 'w-partly', cloud: 'w-cloud', rain: 'w-rain', snow: 'w-snow', storm: 'w-storm', fog: 'w-fog' };

export function weatherView(card, { days = 5 } = {}) {
  const deg = card.units?.temperature ?? '°';
  const wrap = h('div', { class: 'stack' });
  wrap.append(h('div', { class: 'weather-now' },
    icon(WEATHER_ICON[card.current.icon] ?? 'w-cloud', { size: 44 }),
    h('div', { class: 'weather-temp', text: `${card.current.temperature}°` }),
    h('div', { class: 'weather-desc' }, h('b', { text: card.current.text }), `Feels like ${card.current.feelsLike}${deg} · wind ${card.current.wind} ${card.units?.wind ?? ''}`),
  ));
  const strip = h('div', { class: 'forecast' });
  for (const day of card.daily.slice(0, days)) {
    strip.append(h('div', { class: 'day', title: cap(day.text) },
      h('span', { class: 'day-name', text: day.label }),
      icon(WEATHER_ICON[day.icon] ?? 'w-cloud', { size: 22, label: day.text }),
      h('span', { class: 'day-temps' }, h('b', { text: `${day.max}°` }), ' ', h('span', { text: `${day.min}°` })),
      h('span', { class: 'day-rain', text: day.precipChance != null ? `${day.precipChance}% rain` : '' }),
    ));
  }
  wrap.append(strip);
  return wrap;
}

export function headlineList(items) {
  const list = h('div', { class: 'rows' });
  for (const item of items) {
    const meta = [item.source, item.ago].filter(Boolean).join(' · ');
    list.append(externalLink(item.link ?? item.url, { class: 'headline' },
      h('span', { class: 'headline-title', text: item.title }),
      meta ? h('span', { class: 'headline-meta', text: meta }) : null,
    ));
  }
  return list;
}

function taskRows(items) {
  const list = h('div', { class: 'rows' });
  for (const t of items) {
    list.append(h('div', { class: `row ${t.status === 'done' ? 'is-done' : ''}` },
      h('span', { class: 'row-icon' }, icon(t.status === 'done' ? 'check' : 'task', { size: 16 })),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title', text: t.title }),
        t.dueText ? h('div', { class: `row-sub ${t.overdue ? 'is-critical' : ''}` }, t.overdue ? icon('alert', { size: 13 }) : null, `${t.overdue ? 'Overdue: ' : 'Due '}${t.dueText}`) : null,
      ),
      t.priority === 'high' ? h('span', { class: 'badge badge-high', text: 'High' }) : null,
    ));
  }
  return list;
}

function simpleRows(items, iconName, titleKey, subOf) {
  const list = h('div', { class: 'rows' });
  for (const item of items) {
    list.append(h('div', { class: 'row' },
      h('span', { class: 'row-icon' }, icon(iconName, { size: 16 })),
      h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: item[titleKey] }), h('div', { class: 'row-sub', text: subOf(item) })),
    ));
  }
  return list;
}

/** @param {object} card  @param {object} app  { send, deviceCommand } */
export function renderCard(card, app) {
  const el = h('div', { class: 'card' });
  if (card.title && card.type !== 'weather') el.append(h('div', { class: 'card-title', text: card.title }));
  switch (card.type) {
    case 'devices': {
      const grid = h('div', { class: 'devices' });
      for (const device of card.devices.slice(0, 12)) grid.append(deviceTile(device, app.deviceCommand));
      el.append(grid);
      break;
    }
    case 'tasks':
      el.append(taskRows(card.items));
      break;
    case 'reminders':
      el.append(simpleRows(card.items, 'bell', 'text', (r) => `${cap(r.dueText)}${r.recurrenceText ? ` · ${r.recurrenceText}` : ''}`));
      break;
    case 'events':
      el.append(simpleRows(card.items, 'calendar', 'title', (e) => cap(e.whenText)));
      break;
    case 'weather':
      el.append(h('div', { class: 'card-title', text: card.location }), weatherView(card));
      break;
    case 'news':
      el.append(headlineList(card.items));
      break;
    case 'search': {
      const list = h('div', { class: 'rows' });
      for (const item of card.items) {
        list.append(externalLink(item.url, { class: 'headline' },
          h('span', { class: 'headline-title' }, h('b', { text: item.title })),
          h('span', { class: 'card-text', text: item.snippet }),
          h('span', { class: 'headline-meta', text: item.source ?? '' }),
        ));
      }
      el.append(list);
      break;
    }
    case 'summary': {
      el.append(h('p', { class: 'card-text', text: card.summary }));
      const facts = [`${card.stats.words.toLocaleString()} words`, `${card.stats.readingMinutes} min read`, card.method === 'language-model' ? 'Summarized by Claude' : 'Extractive summary'];
      el.append(h('div', { class: 'headline-meta', text: facts.join(' · ') }));
      if (safeUrl(card.url)) el.append(externalLink(card.url, { class: 'btn btn-sm' }, icon('external', { size: 14 }), 'Open the page'));
      break;
    }
    case 'help':
      for (const section of card.sections) {
        const examples = h('div', { class: 'examples' });
        for (const example of section.examples) examples.append(h('button', { class: 'example', type: 'button', onclick: () => app.send(example), text: example }));
        el.append(h('div', { class: 'help-section' }, h('h4', { text: section.name }), examples));
      }
      break;
    case 'privacy': {
      const r = card.report;
      const kv = h('dl', { class: 'kv' });
      const add = (k, v) => kv.append(h('dt', { text: k }), h('dd', { text: v }));
      add('Storage', r.storage);
      add('Encryption', `${r.encryption.algorithm}, key from ${r.encryption.keySource}`);
      add('History', `Kept for ${r.retentionDays} days${r.incognito ? ' (incognito is on)' : ''}`);
      add('Language model', r.languageModel);
      add('Stored', Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'Nothing yet');
      if (r.thirdParties.length) add('Services used', r.thirdParties.map((t) => `${t.name}: ${t.sends}`).join('; '));
      el.append(kv);
      break;
    }
    case 'link':
      el.append(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => app.download(card.url, 'jarvis-export.json') }, icon('download', { size: 16 }), card.label));
      break;
    case 'integrations': {
      const list = h('div', { class: 'rows' });
      for (const item of card.items) {
        list.append(h('div', { class: 'row' },
          h('span', { class: `status-dot ${item.configured ? 'is-on' : ''}` }),
          h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: item.name }), h('div', { class: 'row-sub', text: item.configured ? (item.builtIn ? 'Built in' : 'Connected') : 'Not connected' })),
        ));
      }
      el.append(list, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => app.openSettings('integrations') }, 'Manage integrations'));
      break;
    }
    default:
      if (card.body) el.append(h('p', { class: 'card-text', text: card.body }));
  }
  return el;
}
