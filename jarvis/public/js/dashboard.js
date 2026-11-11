// Dashboard panels: Today, Home, Weather, News and Learning.
import { h, icon, $, clear, toast, showTooltip, hideTooltip, externalLink, cap } from './dom.js';
import { api } from './api.js';
import { deviceTile } from './devices.js';
import { weatherView, headlineList } from './cards.js';

const stat = (label, value, note = '', tone = '') =>
  h('div', { class: 'stat' },
    h('div', { class: 'stat-label', text: label }),
    h('div', { class: 'stat-value', text: String(value) }),
    h('div', { class: `stat-note ${tone}` }, tone === 'is-critical' ? icon('alert', { size: 12 }) : null, note),
  );

const section = (title, ...children) => h('div', {}, h('div', { class: 'section-title', text: title }), ...children);

// ---------------------------------------------------------------- Today
function renderToday(data, app) {
  const body = clear($('#today-body'));
  const { tasks = [], reminders = [], events = [], stats = {} } = data.skills.tasks ?? {};
  $('#today-date').textContent = new Date(data.now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  body.append(h('div', { class: 'stats' },
    stat('Open tasks', stats.open ?? 0, stats.dueToday ? `${stats.dueToday} due today` : 'None due today'),
    stat('Overdue', stats.overdue ?? 0, stats.overdue ? 'Needs attention' : 'All on track', stats.overdue ? 'is-critical' : 'is-good'),
    stat('Reminders', reminders.length, reminders[0] ? `Next ${reminders[0].dueText}` : 'None scheduled'),
    stat('Events', events.length, events[0] ? cap(events[0].whenText.split(' to ')[0]) : 'Next 7 days'),
  ));

  const input = h('input', { type: 'text', placeholder: 'Add a task, for example: Call the bank tomorrow', 'aria-label': 'New task', maxlength: 300 });
  const form = h('form', { class: 'quick-add' }, input, h('button', { class: 'btn', type: 'submit' }, icon('plus', { size: 16 }), 'Add'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    try {
      await api('/api/tasks', { method: 'POST', body: { title } });
      input.value = '';
      app.refresh();
    } catch (error) { toast(error.message, { kind: 'error' }); }
  });
  body.append(form);

  if (tasks.length) {
    const rows = h('div', { class: 'rows' });
    for (const t of tasks.slice(0, 8)) {
      const box = h('input', { type: 'checkbox', class: 'checkbox', 'aria-label': `Mark "${t.title}" as done` });
      box.addEventListener('change', async () => {
        try {
          await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
          app.refresh();
        } catch (error) { toast(error.message, { kind: 'error' }); box.checked = false; }
      });
      rows.append(h('div', { class: 'row' },
        box,
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: t.title, title: t.title }),
          t.dueText ? h('div', { class: `row-sub ${t.overdue ? 'is-critical' : ''}` }, t.overdue ? icon('alert', { size: 13 }) : null, `${t.overdue ? 'Overdue: ' : 'Due '}${t.dueText}`) : null,
        ),
        t.priority === 'high' ? h('span', { class: 'badge badge-high', text: 'High' }) : null,
        h('div', { class: 'row-actions' }, h('button', {
          class: 'icon-btn icon-btn-sm', type: 'button', title: 'Delete task',
          onclick: async () => { await api(`/api/tasks/${t.id}`, { method: 'DELETE' }); app.refresh(); },
        }, icon('trash', { size: 15 }), h('span', { class: 'sr-only', text: `Delete ${t.title}` }))),
      ));
    }
    body.append(section(tasks.length > 8 ? `Tasks (showing 8 of ${tasks.length})` : 'Tasks', rows));
  } else {
    body.append(h('p', { class: 'empty', text: 'No open tasks. Add one above, or say "add a task to..."' }));
  }

  if (reminders.length) {
    const rows = h('div', { class: 'rows' });
    for (const r of reminders.slice(0, 5)) {
      rows.append(h('div', { class: 'row' },
        h('span', { class: 'row-icon' }, icon('bell', { size: 16 })),
        h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: r.text }), h('div', { class: 'row-sub', text: `${cap(r.dueText)}${r.recurrenceText ? ` · ${r.recurrenceText}` : ''}` })),
        h('div', { class: 'row-actions' }, h('button', {
          class: 'icon-btn icon-btn-sm', type: 'button', title: 'Cancel reminder',
          onclick: async () => { await api(`/api/reminders/${r.id}`, { method: 'DELETE' }); app.refresh(); },
        }, icon('x', { size: 15 }), h('span', { class: 'sr-only', text: `Cancel reminder ${r.text}` }))),
      ));
    }
    body.append(section('Reminders', rows));
  }

  if (events.length) {
    const rows = h('div', { class: 'rows' });
    for (const e of events.slice(0, 5)) {
      rows.append(h('div', { class: 'row' },
        h('span', { class: 'row-icon' }, icon('calendar', { size: 16 })),
        h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: e.title }), h('div', { class: 'row-sub', text: cap(e.whenText) })),
        e.source === 'local' ? h('div', { class: 'row-actions' }, h('button', {
          class: 'icon-btn icon-btn-sm', type: 'button', title: 'Delete event',
          onclick: async () => { await api(`/api/calendar/${e.id}`, { method: 'DELETE' }); app.refresh(); },
        }, icon('trash', { size: 15 }), h('span', { class: 'sr-only', text: `Delete ${e.title}` }))) : null,
      ));
    }
    body.append(section('Coming up', rows));
  }
}

// ---------------------------------------------------------------- Home
function renderHome(data, app) {
  const body = clear($('#home-body'));
  const home = data.skills.smarthome ?? {};
  const devices = home.devices ?? [];
  $('#home-note').textContent = home.adapter ?? '';
  if (!devices.length) {
    body.append(h('p', { class: 'empty', text: 'No devices found yet. Connect Home Assistant or Philips Hue in Settings.' }));
    return;
  }
  const scenes = h('div', { class: 'scenes', role: 'group', 'aria-label': 'Scenes' });
  for (const scene of home.scenes ?? []) {
    scenes.append(h('button', {
      class: 'btn btn-sm', type: 'button',
      onclick: async () => {
        try {
          const result = await api(`/api/scenes/${scene.id}`, { method: 'POST' });
          toast(result.text, { iconName: 'home' });
          app.refresh();
        } catch (error) { toast(error.message, { kind: 'error' }); }
      },
    }, scene.label));
  }
  body.append(section('Scenes', scenes));

  const rooms = new Map();
  for (const device of devices) {
    if (!rooms.has(device.room)) rooms.set(device.room, []);
    rooms.get(device.room).push(device);
  }
  for (const [room, list] of [...rooms.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const grid = h('div', { class: 'devices' });
    for (const device of list) grid.append(deviceTile(device, app.deviceCommand));
    body.append(h('div', { class: 'room' }, h('div', { class: 'section-title', text: room }), grid));
  }
}

// ---------------------------------------------------------------- Weather
function renderWeather(data, app) {
  const body = clear($('#weather-body'));
  const weather = data.skills.weather ?? {};
  const note = $('#weather-note');
  if (!weather.configured) {
    note.textContent = '';
    const input = h('input', { type: 'text', placeholder: 'Your city, for example Lisbon', 'aria-label': 'Home city', maxlength: 80 });
    const form = h('form', { class: 'quick-add' }, input, h('button', { class: 'btn', type: 'submit' }, 'Save'));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      try {
        await api('/api/profile', { method: 'PUT', body: { location: input.value.trim() } });
        app.refresh();
      } catch (error) { toast(error.message, { kind: 'error' }); }
    });
    body.append(h('p', { class: 'empty', text: 'Tell me where you live to see the local forecast here.' }), form);
    return;
  }
  if (weather.error || !weather.current) {
    note.textContent = data.profile.location ?? '';
    body.append(h('p', { class: 'empty', text: `The forecast is unavailable right now${weather.error ? ` (${weather.error})` : ''}.` }));
    return;
  }
  note.textContent = weather.location;
  body.append(weatherView(weather));
}

// ---------------------------------------------------------------- News
function renderNews(data) {
  const body = clear($('#news-body'));
  const news = data.skills.news ?? {};
  $('#news-note').textContent = news.topic ? `Following ${news.topic}` : 'Top stories';
  if (!news.items?.length) {
    body.append(h('p', { class: 'empty', text: `Headlines are unavailable right now${news.error ? ` (${news.error})` : ''}.` }));
    return;
  }
  body.append(headlineList(news.items));
}

// ---------------------------------------------------------------- Learning
const hourLabel = (hour) => `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? ' AM' : ' PM'}`;

function niceMax(value) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (value <= step * magnitude) return step * magnitude;
  return value;
}

/** Column chart of interactions by hour of day: one series, one hue, hover and keyboard tooltips. */
function activityChart(values, nowHour) {
  const total = values.reduce((a, b) => a + b, 0);
  const wrap = h('div', { class: 'chart-wrap' });
  const head = h('div', { class: 'chart-head' },
    h('div', {}, h('div', { class: 'chart-title', text: 'When you use JARVIS' }), h('div', { class: 'chart-sub', text: 'Interactions by hour of day' })),
  );
  wrap.append(head);
  if (!total) {
    wrap.append(h('p', { class: 'empty', text: 'No activity yet. As you use JARVIS, your daily rhythm appears here and powers time-aware suggestions.' }));
    return wrap;
  }
  const host = h('div', {});
  const toggle = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-pressed': 'false' }, 'View as table');
  head.append(toggle);
  wrap.append(host);

  const draw = () => {
    const width = Math.max(280, Math.floor(host.clientWidth || 520));
    const height = 170;
    const m = { top: 18, right: 6, bottom: 22, left: 28 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const band = plotW / 24;
    const barW = Math.max(3, Math.min(24, band - 2));
    const max = niceMax(Math.max(...values));
    const y = (v) => m.top + plotH - (v / max) * plotH;
    const svg = h('svg', { class: 'chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': `Interactions by hour of day. ${total} in total, busiest at ${hourLabel(values.indexOf(Math.max(...values)))}.` });
    for (const tick of [0, max / 2, max]) {
      svg.append(h('line', { class: tick === 0 ? 'axis' : 'grid', x1: m.left, x2: width - m.right, y1: y(tick), y2: y(tick) }));
      svg.append(h('text', { class: 'tick', x: m.left - 6, y: y(tick) + 4, 'text-anchor': 'end' }, String(Number.isInteger(tick) ? tick : tick.toFixed(1))));
    }
    const peak = values.indexOf(Math.max(...values));
    values.forEach((value, hour) => {
      const x = m.left + hour * band + (band - barW) / 2;
      const col = h('g', { class: 'col' });
      if (value > 0) {
        const top = y(value);
        const bottom = y(0);
        const r = Math.min(4, barW / 2, bottom - top);
        col.append(h('path', { class: 'bar', d: `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${bottom} Z` }));
        if (hour === peak) col.append(h('text', { class: 'value-label', x: x + barW / 2, y: top - 5 }, String(value)));
      }
      const label = `${value} ${value === 1 ? 'interaction' : 'interactions'} at ${hourLabel(hour)}`;
      const hit = h('rect', { class: 'bar-hit', x: m.left + hour * band, y: m.top, width: band, height: plotH, tabindex: 0, role: 'img', 'aria-label': label });
      const show = () => showTooltip(hit, String(value), `${value === 1 ? 'interaction' : 'interactions'} at ${hourLabel(hour)}`);
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('focus', show);
      hit.addEventListener('blur', hideTooltip);
      col.append(hit);
      svg.append(col);
      if (hour % 3 === 0) {
        svg.append(h('text', { class: `tick ${hour === nowHour ? 'is-now' : ''}`, x: m.left + hour * band + band / 2, y: height - 6, 'text-anchor': 'middle' }, hourLabel(hour).replace(' ', '').toLowerCase().replace('m', '')));
      }
    });
    clear(host).append(svg);
  };

  const table = () => {
    const t = h('table', { class: 'table-view' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Hour' }), h('th', { scope: 'col', text: 'Interactions' }))));
    const tbody = h('tbody', {});
    values.forEach((value, hour) => tbody.append(h('tr', {}, h('td', { text: hourLabel(hour) }), h('td', { text: String(value) }))));
    t.append(tbody);
    clear(host).append(h('div', { class: 'table-scroll', tabindex: 0 }, t));
  };

  let asTable = false;
  toggle.addEventListener('click', () => {
    asTable = !asTable;
    toggle.setAttribute('aria-pressed', String(asTable));
    toggle.textContent = asTable ? 'View as chart' : 'View as table';
    if (asTable) table(); else draw();
  });
  requestAnimationFrame(draw);
  const observer = new ResizeObserver(() => { if (!asTable && host.isConnected) draw(); });
  observer.observe(host);
  return wrap;
}

function renderInsights(data, app) {
  const body = clear($('#insights-body'));
  const learning = data.learning;
  const satisfaction = learning.feedback.satisfaction;
  body.append(h('div', { class: 'stats' },
    stat('Interactions', learning.interactions, 'Since you started'),
    stat('Phrases learned', learning.aliasCount, 'From your corrections'),
    stat('Satisfaction', satisfaction == null ? '–' : `${Math.round(satisfaction * 100)}%`, learning.feedback.total ? `${learning.feedback.up} up, ${learning.feedback.down} down` : 'Rate replies to track this'),
    stat('Training samples', Math.round(learning.samples), 'Phrases the classifier knows'),
  ));

  const left = h('div', { class: 'insight-col' }, activityChart(data.activity, new Date(data.now).getHours()));
  const right = h('div', { class: 'insight-col' });

  if (learning.aliases.length) {
    const rows = h('div', {});
    for (const alias of learning.aliases) rows.append(h('div', { class: 'pair' }, h('q', { text: alias.phrase }), h('span', { class: 'arrow', text: 'means' }), h('span', { class: 'means', text: alias.means })));
    right.append(section('Phrases you taught me', rows));
  }

  if (learning.misses.length) {
    const rows = h('div', {});
    for (const miss of learning.misses.slice(0, 5)) {
      const row = h('div', { class: 'pair' }, h('q', { text: miss.utterance }));
      row.append(h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => {
          const input = h('input', { type: 'text', placeholder: 'It means...', 'aria-label': `What does "${miss.utterance}" mean?`, maxlength: 300 });
          const form = h('form', { class: 'teach' }, input, h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Save'));
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!input.value.trim()) return;
            try {
              const { feedback } = await api('/api/feedback', { method: 'POST', body: { utterance: miss.utterance, rating: 'down', comment: input.value.trim() } });
              toast(feedback.learned?.alias ? `Learned: "${miss.utterance}" means "${feedback.learned.alias}".` : "I couldn't map that to a command. Try phrasing it like an example from Help.", { iconName: 'sparkle' });
              app.refresh();
            } catch (error) { toast(error.message, { kind: 'error' }); }
          });
          row.replaceWith(form);
          input.focus();
        },
      }, 'Teach'));
      rows.append(row);
    }
    right.append(section("Phrases I didn't understand", rows));
  }

  if (data.interests.length) {
    const chips = h('div', { class: 'interests' });
    for (const interest of data.interests) chips.append(h('span', { class: 'chip', text: interest.topic }));
    right.append(section('Topics you ask about', chips));
  }

  if (!right.childElementCount) {
    right.append(h('p', { class: 'empty', text: 'When I misread something, tap the thumbs-down on my reply or say "no, I meant..." and I will remember what you meant. Learned phrases and topics you care about show up here.' }));
  }
  body.append(h('div', { class: 'insight-grid' }, left, right));
}

export function renderDashboard(data, app) {
  renderToday(data, app);
  renderHome(data, app);
  renderWeather(data, app);
  renderNews(data);
  renderInsights(data, app);
}

export function renderSuggestions(suggestions, app) {
  const host = clear($('#suggestions'));
  for (const s of (suggestions ?? []).slice(0, 3)) {
    const chip = h('div', { class: 'suggestion' });
    chip.append(
      h('button', { class: 'suggestion-run', type: 'button', title: s.utterance ? `Say: ${s.utterance}` : s.text, onclick: () => s.utterance && app.send(s.utterance) }, icon('sparkle', { size: 15 }), h('span', { text: s.text })),
      h('button', {
        class: 'suggestion-dismiss', type: 'button', title: 'Dismiss',
        onclick: async () => {
          chip.remove();
          try { await api('/api/suggestions/dismiss', { method: 'POST', body: { id: s.id } }); } catch { /* dismissing is best effort */ }
        },
      }, icon('x', { size: 13 }), h('span', { class: 'sr-only', text: 'Dismiss suggestion' })),
    );
    host.append(chip);
  }
}

export function markStale(stale) {
  for (const id of ['today-body', 'home-body', 'weather-body', 'news-body', 'insights-body']) $(`#${id}`).classList.toggle('is-stale', stale);
}

export { externalLink };
