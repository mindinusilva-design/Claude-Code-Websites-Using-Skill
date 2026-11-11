// HUD interface: reactor core, side widgets, dock and panel sheets.
// All values shown are live: clock, host CPU and memory, tasks, devices,
// weather, news, learning and the voice level.
import { h, $, clear, externalLink, cap } from './dom.js';
import { api } from './api.js';

const LAYOUT_KEY = 'jarvis.layout';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');
const pct = (v) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;

// -------------------------------------------------------------- SVG helpers
function polar(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [r * Math.cos(a), r * Math.sin(a)];
}
function arc(r, from, to) {
  const [x0, y0] = polar(r, from);
  const [x1, y1] = polar(r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}
function ticks(rOuter, count, length, every = 0, majorLength = length * 2) {
  const g = h('g', {});
  for (let i = 0; i < count; i += 1) {
    const major = every && i % every === 0;
    const [x0, y0] = polar(rOuter, (360 / count) * i);
    const [x1, y1] = polar(rOuter - (major ? majorLength : length), (360 / count) * i);
    g.append(h('line', { class: `tick ${major ? 'major' : ''}`, x1: x0.toFixed(2), y1: y0.toFixed(2), x2: x1.toFixed(2), y2: y1.toFixed(2) }));
  }
  return g;
}

/** A circular gauge: track, value arc (0..1), optional spinning tick ring and centered text. */
function ringGauge({ size = 120, r = 46, width = 6, value = 0, warm = false, big = '', bigClass = 'mid', cap: caption = '', spin = true }) {
  const svg = h('svg', { class: 'hud-ring-svg', width: size, height: size, viewBox: `-${size / 2} -${size / 2} ${size} ${size}`, 'aria-hidden': 'true' });
  if (spin) {
    svg.append(h('circle', { class: 'ticks spin', r: r + 10, 'stroke-width': 3, 'stroke-dasharray': '2 5', opacity: 0.8 }));
    svg.append(h('circle', { class: 'ticks spin-rev', r: r - 10, 'stroke-width': 1, 'stroke-dasharray': '18 8 4 8', opacity: 0.7 }));
  }
  svg.append(h('circle', { class: 'track', r, 'stroke-width': width }));
  const valueArc = h('circle', { class: `value ${warm ? 'is-warm' : ''}`, r, 'stroke-width': width, pathLength: 100, 'stroke-dasharray': `${Math.round(value * 100)} 100`, transform: 'rotate(-90)' });
  svg.append(valueArc);
  const bigText = h('text', { class: bigClass, y: caption ? 6 : 8, text: big });
  const capText = h('text', { class: 'cap', y: 26, text: caption });
  svg.append(bigText, capText);
  return {
    el: svg,
    set({ value: v, big: b, cap: c, warm: w }) {
      if (v != null) valueArc.setAttribute('stroke-dasharray', `${Math.round(Math.max(0, Math.min(1, v)) * 100)} 100`);
      if (b != null) bigText.textContent = b;
      if (c != null) capText.textContent = c;
      if (w != null) valueArc.classList.toggle('is-warm', w);
    },
  };
}

const meter = (label) => {
  const name = h('span', { text: label });
  const value = h('b', { text: '–' });
  const fill = h('i', { style: 'width:0%' });
  const el = h('div', { class: 'hud-meter' }, h('div', { class: 'hud-kv' }, name, value), h('div', { class: 'hud-meter-bar' }, fill));
  return {
    el,
    label(text) { name.textContent = text; },
    set(text, ratio, tone = '') {
      value.textContent = text;
      value.className = tone;
      fill.style.width = pct(ratio);
      fill.classList.toggle('is-warm', tone === 'is-warm' || tone === 'is-critical');
    },
  };
};

const kv = (label) => {
  const name = h('span', { text: label });
  const value = h('b', { text: '–' });
  return { el: h('div', { class: 'hud-kv' }, name, value), label(text) { name.textContent = text; }, set(text, tone = '') { value.textContent = text; value.className = tone; } };
};

const widget = (title, ...children) => h('div', { class: 'hud-widget hud-frame' }, h('div', { class: 'hud-widget-title' }, title), ...children);

function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const hrs = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${hrs}h` : hrs ? `${hrs}h ${m}m` : `${m}m`;
}

// -------------------------------------------------------------- the HUD
export function createHud(app) {
  const root = $('#app');
  const refs = {};
  const levels = new Array(120).fill(0);
  let liveLevel = 0;
  let systemTimer = null;
  let data = null;

  // ---- layout switching
  function savedLayout() {
    try { return localStorage.getItem(LAYOUT_KEY) === 'classic' ? 'classic' : 'hud'; } catch { return 'hud'; }
  }
  function applyLayout(mode) {
    root.dataset.layout = mode;
    if (mode === 'hud') {
      document.documentElement.dataset.hud = '';
      document.documentElement.dataset.theme = 'dark';
    } else {
      delete document.documentElement.dataset.hud;
      closeSheet();
      let theme = null;
      try { theme = localStorage.getItem('jarvis.theme'); } catch { /* ignore */ }
      if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
      else delete document.documentElement.dataset.theme;
    }
    window.dispatchEvent(new Event('resize'));
  }
  function setLayout(mode) {
    try { localStorage.setItem(LAYOUT_KEY, mode); } catch { /* ignore */ }
    applyLayout(mode);
    if (mode === 'hud') startPolling(); else stopPolling();
  }
  const active = () => root.dataset.layout === 'hud';

  // ---- ruler of the month's days
  function buildRuler() {
    const ruler = clear($('#hud-ruler'));
    const now = new Date();
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= days; d += 1) ruler.append(h('span', { class: d === now.getDate() ? 'is-today' : d < now.getDate() ? 'is-past' : '', text: pad(d) }));
    refs.rulerDay = now.getDate();
  }

  // ---- reactor
  function buildReactor() {
    const svg = h('svg', { class: 'reactor', viewBox: '-300 -300 600 600', role: 'img', 'aria-label': 'JARVIS core' });
    const defs = h('defs', {},
      h('radialGradient', { id: 'core-glow' }, h('stop', { offset: '0%', 'stop-color': '#7fdcff', 'stop-opacity': '0.65' }), h('stop', { offset: '55%', 'stop-color': '#1a8fd6', 'stop-opacity': '0.25' }), h('stop', { offset: '100%', 'stop-color': '#01060c', 'stop-opacity': '0' })),
      h('radialGradient', { id: 'core-glow-warm' }, h('stop', { offset: '0%', 'stop-color': '#ffd59a', 'stop-opacity': '0.7' }), h('stop', { offset: '55%', 'stop-color': '#d9822b', 'stop-opacity': '0.25' }), h('stop', { offset: '100%', 'stop-color': '#01060c', 'stop-opacity': '0' })),
      h('radialGradient', { id: 'core-center' }, h('stop', { offset: '0%', 'stop-color': '#ffffff' }), h('stop', { offset: '45%', 'stop-color': '#bdf0ff' }), h('stop', { offset: '100%', 'stop-color': '#2ec5ff' })),
    );
    svg.append(defs);

    // Outer scale and rings.
    const a = h('g', { class: 'rot-a' }, ticks(292, 180, 6, 15, 16));
    svg.append(a, h('circle', { class: 'faint', r: 274, 'stroke-width': 1 }));
    svg.append(h('g', { class: 'rot-b' }, h('circle', { class: 'line', r: 262, 'stroke-width': 3, 'stroke-dasharray': '2 7' }), h('path', { class: 'bright', d: arc(262, 20, 70), 'stroke-width': 3 }), h('path', { class: 'bright', d: arc(262, 200, 250), 'stroke-width': 3 })));

    // Day progress arc.
    svg.append(h('circle', { class: 'faint', r: 246, 'stroke-width': 6 }));
    refs.dayArc = h('path', { class: 'bright', d: arc(246, 0, 1), 'stroke-width': 6 });
    svg.append(refs.dayArc);

    // Segmented band with a gap at the top for the clock.
    const segs = h('g', {});
    const from = 42; const to = 318; const n = 12; const step = (to - from) / n;
    for (let i = 0; i < n; i += 1) segs.append(h('path', { class: 'seg', d: arc(212, from + i * step + 1.5, from + (i + 1) * step - 1.5), style: `animation-delay:${(i * 0.33).toFixed(2)}s` }));
    svg.append(segs, h('path', { class: 'line', d: arc(226, from, to), 'stroke-width': 1 }), h('path', { class: 'line', d: arc(198, from, to), 'stroke-width': 1 }));
    svg.append(h('path', { class: 'line', d: arc(234, from + 6, to - 6), 'stroke-width': 2, 'stroke-dasharray': '48 10 6 10', opacity: 0.8 }));

    // Clock in the top gap.
    refs.clock = h('text', { class: 'clock', x: -10, y: -204, text: '00:00' });
    refs.clockSec = h('text', { class: 'clock-sec', x: 68, y: -204, text: '00' });
    refs.date = h('text', { class: 'date', x: 0, y: -180, text: '' });
    svg.append(refs.clock, refs.clockSec, refs.date);

    // Rotating ring between the seconds and the housing, kept below the date text.
    svg.append(h('g', { class: 'rot-c' }, h('circle', { class: 'line', r: 150, 'stroke-width': 1.5, 'stroke-dasharray': '30 12 4 12' })));

    // Seconds ring.
    refs.secs = [];
    const secs = h('g', {});
    for (let i = 0; i < 60; i += 1) {
      const [x0, y0] = polar(170, i * 6);
      const [x1, y1] = polar(i % 5 === 0 ? 156 : 161, i * 6);
      const line = h('line', { class: 'sec', x1: x0.toFixed(2), y1: y0.toFixed(2), x2: x1.toFixed(2), y2: y1.toFixed(2) });
      refs.secs.push(line);
      secs.append(line);
    }
    svg.append(secs);

    // Thick inner ring with three gaps, like an arc reactor housing.
    svg.append(h('g', { class: 'rot-d' }, h('path', { class: 'bright', d: arc(140, 8, 112), 'stroke-width': 9 }), h('path', { class: 'bright', d: arc(140, 128, 232), 'stroke-width': 9 }), h('path', { class: 'bright', d: arc(140, 248, 352), 'stroke-width': 9 })));
    svg.append(h('circle', { class: 'faint', r: 126, 'stroke-width': 1 }));

    // Core: glow, three blades, ring, bright center and state text.
    const core = h('g', { class: 'core' });
    core.append(h('circle', { class: 'core-glow', r: 124 }));
    for (const start of [0, 120, 240]) {
      const [ax, ay] = polar(110, start + 12);
      const [bx, by] = polar(110, start + 108);
      const [cx, cy] = polar(62, start + 96);
      const [dx, dy] = polar(62, start + 24);
      core.append(h('polygon', { class: 'blade', points: `${ax.toFixed(1)},${ay.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)} ${cx.toFixed(1)},${cy.toFixed(1)} ${dx.toFixed(1)},${dy.toFixed(1)}` }));
    }
    core.append(h('circle', { class: 'core-ring', r: 52 }), h('circle', { class: 'core-center', r: 42 }));
    refs.coreText = h('text', { class: 'core-text', y: 5, text: 'ONLINE' });
    core.append(refs.coreText);
    svg.append(core);

    clear($('#hud-reactor')).append(svg);
  }

  // ---- wings
  function buildWings() {
    const left = clear($('#hud-wing-left'));
    left.classList.add('hud-frame');
    refs.bars = {};
    const bars = h('div', { class: 'hud-bars' });
    for (const [key, label] of [['cpu', 'CPU'], ['mem', 'MEM'], ['home', 'HOME'], ['learn', 'LRN'], ['sat', 'SAT']]) {
      const value = h('b', { text: '–' });
      const fill = h('i', { style: 'height:0%' });
      const titles = { cpu: 'Host CPU, percent', mem: 'Host memory, percent', home: 'Devices switched on, percent', learn: 'Phrases the classifier has learned', sat: 'Satisfaction from your ratings, percent' };
      bars.append(h('div', { class: 'hud-bar', title: titles[key] }, value, h('div', { class: 'col' }, fill), h('span', { text: label })));
      refs.bars[key] = { value, fill };
    }
    refs.tagLeft = h('span', { class: 'hud-tag', text: '–' });
    left.append(h('div', { class: 'hud-widget-title' }, 'System diagnostics'), bars, h('div', { class: 'hud-tags' }, refs.tagLeft));

    const right = clear($('#hud-wing-right'));
    right.classList.add('hud-frame');
    const list = h('div', { class: 'hud-list' });
    for (const [label, utterance] of [['Status report', 'list devices'], ['Lights on', 'turn on the living room lights'], ['Good night', 'good night'], ['Weather', "what's the weather"], ['Briefing', 'news briefing'], ['My agenda', "what's on my calendar today"], ['Help', 'help']]) {
      list.append(h('button', { type: 'button', onclick: () => app.send(utterance), title: `Say: ${utterance}` }, label));
    }
    right.append(h('div', { class: 'hud-widget-title' }, 'Quick commands'), list);
  }

  // ---- left column
  function buildLeft() {
    const col = clear($('#hud-left'));
    // Date ring.
    refs.clockTab = h('div', { class: 'hud-clock-tab' });
    refs.dateRing = ringGauge({ size: 150, r: 54, width: 5, big: '', bigClass: 'big', cap: '' });
    refs.dateRing.el.querySelector('.big').setAttribute('y', '20');
    refs.dateRing.el.querySelector('.cap').setAttribute('y', '-22');
    col.append(h('div', { class: 'hud-clock' }, refs.clockTab, refs.dateRing.el));

    // Agenda meters.
    refs.mTasks = meter('Open tasks');
    refs.mOverdue = meter('Overdue');
    refs.mReminders = meter('Reminders');
    refs.mEvents = meter('Events, 7 days');
    col.append(widget('Agenda', refs.mTasks.el, refs.mOverdue.el, refs.mReminders.el, refs.mEvents.el));

    // Home load ring.
    refs.homeRing = ringGauge({ size: 112, r: 38, width: 6, big: '0%', cap: 'on' });
    refs.homeLines = { lights: kv('Lights'), locks: kv('Doors'), alarm: kv('Alarm'), climate: kv('Climate') };
    col.append(widget('Home load', h('div', { class: 'hud-ring-row' }, refs.homeRing.el, h('div', { class: 'hud-lines' }, ...Object.values(refs.homeLines).map((x) => x.el)))));

    // Uplink.
    refs.uplink = { ai: kv('Language'), voice: kv('Voice'), ear: kv('Listening'), latency: kv('Latency') };
    col.append(widget('Uplink', ...Object.values(refs.uplink).map((x) => x.el)));

    // Scenes.
    refs.scenes = h('div', { class: 'hud-list' });
    col.append(widget('Scenes', refs.scenes));

    // Search.
    const input = h('input', { type: 'search', placeholder: 'Search the web', 'aria-label': 'Search the web', maxlength: 200 });
    const form = h('form', { class: 'hud-search' }, input, h('button', { class: 'btn btn-sm', type: 'submit' }, 'Go'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      app.send(`search for ${input.value.trim()}`);
      input.value = '';
    });
    col.append(widget('Search', form));
  }

  // ---- right column
  function buildRight() {
    const col = clear($('#hud-right'));
    refs.weatherPlace = h('b', { text: '' });
    refs.weatherRing = ringGauge({ size: 150, r: 54, width: 6, big: '--', bigClass: 'big', cap: '' });
    refs.weatherRing.el.querySelector('.big').setAttribute('y', '14');
    refs.weatherRing.el.querySelector('.cap').setAttribute('y', '38');
    refs.weatherText = h('div', { class: 'hud-lines' });
    col.append(h('div', { class: 'hud-widget hud-frame' }, h('div', { class: 'hud-widget-title' }, 'Weather', refs.weatherPlace), h('div', { class: 'hud-ring-row' }, refs.weatherRing.el, refs.weatherText)));

    refs.sys = { cpu: meter('CPU'), mem: meter('Memory'), load: kv('Load average'), up: kv('Host uptime'), jarvis: kv('JARVIS memory') };
    col.append(widget('System', refs.sys.cpu.el, refs.sys.mem.el, refs.sys.load.el, refs.sys.up.el, refs.sys.jarvis.el));

    refs.upcoming = h('div', {});
    col.append(widget('Upcoming', refs.upcoming));

    refs.newsTitle = h('b', { text: '' });
    refs.news = h('div', { class: 'hud-list' });
    col.append(h('div', { class: 'hud-widget hud-frame' }, h('div', { class: 'hud-widget-title' }, 'News', refs.newsTitle), refs.news));
  }

  // ---- dock
  const DOCK = [
    { id: 'comms', label: 'Comms', icon: 'chat', dash: '3 6', run: () => { closeSheet(); $('#input').focus(); } },
    { id: 'today', label: 'Today', icon: 'task', dash: '40 10', sheet: 'today' },
    { id: 'home', label: 'Home', icon: 'home', dash: '60 8 6 8', sheet: 'home' },
    { id: 'weather', label: 'Weather', icon: 'w-partly', dash: '22 6', sheet: 'weather' },
    { id: 'news', label: 'News', icon: 'news', dash: '90 20', sheet: 'news' },
    { id: 'insights', label: 'Learning', icon: 'chart', dash: '12 4 2 4', sheet: 'insights' },
    { id: 'listen', label: 'Listen', icon: 'mic', dash: '30 4', run: () => $('#mic').click() },
    { id: 'voice', label: 'Voice', icon: 'speaker', dash: '6 6', run: () => $('#voice-toggle').click() },
    { id: 'settings', label: 'Settings', icon: 'settings', dash: '50 12 4 12', run: () => app.openSettings('profile') },
  ];
  function buildDock() {
    const dock = clear($('#hud-dock'));
    refs.dock = {};
    for (const item of DOCK) {
      const svg = h('svg', { viewBox: '-40 -40 80 80', 'aria-hidden': 'true' },
        h('g', { class: 'd-spin' }, h('circle', { class: 'd-outer', r: 36, 'stroke-dasharray': item.dash })),
        h('circle', { class: 'd-inner', r: 27 }),
      );
      const inner = h('svg', { class: 'd-icon', x: -13, y: -13, width: 26, height: 26, viewBox: '0 0 24 24' });
      inner.append(h('use', { href: `#i-${item.icon}` }));
      svg.append(inner);
      const btn = h('button', { class: 'dock-btn', type: 'button', 'aria-pressed': item.sheet ? 'false' : null, title: item.label }, svg, h('span', { text: item.label }));
      btn.addEventListener('click', () => (item.sheet ? toggleSheet(item.sheet) : item.run()));
      refs.dock[item.id] = btn;
      dock.append(btn);
    }
  }

  function openSheet(name) {
    root.dataset.sheet = name;
    $('#hud-scrim').hidden = false;
    for (const item of DOCK) if (item.sheet) refs.dock[item.id].setAttribute('aria-pressed', String(item.sheet === name));
    window.dispatchEvent(new Event('resize')); // let the chart size itself
    $('#sheet-close').focus();
  }
  function closeSheet() {
    if (!root.dataset.sheet) return;
    delete root.dataset.sheet;
    $('#hud-scrim').hidden = true;
    for (const item of DOCK) if (item.sheet) refs.dock[item.id]?.setAttribute('aria-pressed', 'false');
  }
  function toggleSheet(name) {
    if (root.dataset.sheet === name) closeSheet(); else openSheet(name);
  }

  // ---- clock, every second
  function tick() {
    const now = new Date();
    const hh = pad(now.getHours());
    const mm = pad(now.getMinutes());
    const ss = now.getSeconds();
    refs.clock.textContent = `${hh}:${mm}`;
    refs.clockSec.textContent = pad(ss);
    const dayPct = Math.round(((now.getHours() * 3600 + now.getMinutes() * 60 + ss) / 86400) * 100);
    refs.date.textContent = `${DAYS[now.getDay()].slice(0, 3)} ${pad(now.getDate())} ${MONTHS[now.getMonth()].slice(0, 3)} · DAY ${dayPct}%`.toUpperCase();
    refs.secs.forEach((line, i) => line.setAttribute('class', `sec${i < ss ? ' on' : ''}${i === ss ? ' now' : ''}`));
    const dayFrac = (now.getHours() * 3600 + now.getMinutes() * 60 + ss) / 86400;
    refs.dayArc.setAttribute('d', arc(246, 0, Math.max(0.5, dayFrac * 359.9)));
    refs.clockTab.replaceChildren(`${DAYS[now.getDay()]}  ${hh}:${mm}`, h('small', { text: pad(ss) }));
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    refs.dateRing.set({ value: now.getDate() / daysInMonth, big: pad(now.getDate()), cap: MONTHS[now.getMonth()] });
    if (refs.rulerDay !== now.getDate()) buildRuler();
  }

  // ---- voice waveform
  function drawWave() {
    const canvas = $('#hud-wave');
    if (!canvas || !active()) return requestAnimationFrame(drawWave);
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (canvas.width !== Math.round(w * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(hgt * ratio); }
    levels.push(liveLevel * 0.85 + Math.random() * 0.03);
    levels.shift();
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2ec5ff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    const bar = w / levels.length;
    ctx.beginPath();
    levels.forEach((v, i) => {
      const amp = Math.max(1, v * (hgt / 2 - 2));
      const x = i * bar + bar / 2;
      ctx.moveTo(x, hgt / 2 - amp);
      ctx.lineTo(x, hgt / 2 + amp);
    });
    ctx.stroke();
    requestAnimationFrame(drawWave);
  }

  // ---- host metrics
  async function pollSystem() {
    if (!active() || document.hidden) return;
    try {
      const s = await api('/api/system');
      const browser = s.source === 'browser';
      refs.sys.cpu.label(browser ? 'Main thread' : 'CPU');
      refs.sys.mem.label(browser ? 'JS heap' : 'Memory');
      refs.sys.load.label(browser ? 'Processor' : 'Load average');
      refs.sys.up.label(browser ? 'Session' : 'Host uptime');
      refs.sys.jarvis.label(browser ? 'Device memory' : 'JARVIS memory');
      const memPct = s.memory?.usedPct;
      refs.sys.cpu.set(`${s.cpu}%`, s.cpu / 100, s.cpu > 85 ? 'is-warm' : '');
      refs.sys.mem.set(memPct == null ? 'n/a' : `${memPct}%`, (memPct ?? 0) / 100, memPct > 90 ? 'is-warm' : '');
      refs.sys.load.set(browser ? `${s.cores} cores` : `${s.load} on ${s.cores} cores`);
      refs.sys.up.set(duration(s.uptime));
      refs.sys.jarvis.set(browser ? (s.memory?.totalGb ? `${s.memory.totalGb} GB` : 'n/a') : `${s.jarvis.rssMb} MB`);
      setBar('cpu', s.cpu / 100, `${s.cpu}`);
      setBar('mem', (memPct ?? 0) / 100, memPct == null ? '–' : `${memPct}`);
    } catch { /* metrics are optional */ }
  }
  function startPolling() {
    if (systemTimer) return;
    pollSystem();
    systemTimer = setInterval(pollSystem, 3000);
  }
  function stopPolling() {
    clearInterval(systemTimer);
    systemTimer = null;
  }
  function setBar(key, ratio, text) {
    const bar = refs.bars?.[key];
    if (!bar) return;
    bar.value.textContent = text;
    bar.fill.style.height = pct(ratio);
  }

  // ---- render dashboard data
  function render(d) {
    data = d;
    const tasks = d.skills.tasks ?? {};
    const stats = tasks.stats ?? {};
    const open = stats.open ?? 0;
    const doneToday = stats.doneToday ?? 0;
    refs.mTasks.set(String(open), open + doneToday ? open / (open + doneToday) : 0);
    refs.mOverdue.set(String(stats.overdue ?? 0), open ? (stats.overdue ?? 0) / open : 0, stats.overdue ? 'is-critical' : 'is-good');
    refs.mReminders.set(String(tasks.reminders?.length ?? 0), Math.min(1, (tasks.reminders?.length ?? 0) / 6));
    refs.mEvents.set(String(tasks.events?.length ?? 0), Math.min(1, (tasks.events?.length ?? 0) / 8));

    // Home.
    const devices = d.skills.smarthome?.devices ?? [];
    const switchable = devices.filter((x) => ['light', 'switch', 'fan', 'speaker'].includes(x.type));
    const on = switchable.filter((x) => x.state?.on).length;
    const lights = devices.filter((x) => x.type === 'light');
    const locks = devices.filter((x) => x.type === 'lock');
    const unlocked = locks.filter((x) => !x.state?.locked).length;
    const alarm = devices.find((x) => x.type === 'security');
    const climate = devices.find((x) => x.type === 'thermostat');
    const ratio = switchable.length ? on / switchable.length : 0;
    refs.homeRing.set({ value: ratio, big: pct(ratio), cap: 'on' });
    refs.homeLines.lights.set(`${lights.filter((x) => x.state?.on).length} of ${lights.length} on`);
    refs.homeLines.locks.set(locks.length ? (unlocked ? `${unlocked} unlocked` : 'All locked') : 'None', unlocked ? 'is-warm' : 'is-good');
    refs.homeLines.alarm.set(alarm ? (alarm.state?.armed ? `Armed, ${alarm.state.mode}` : 'Disarmed') : 'None', alarm?.state?.armed ? 'is-good' : '');
    refs.homeLines.climate.set(climate ? (/set to ([^,]+)/.exec(climate.summary ?? '')?.[1] ?? '–') : 'None');
    setBar('home', ratio, `${Math.round(ratio * 100)}`);
    refs.tagLeft.textContent = `${on}/${switchable.length} DEVICES ON`;

    // Scenes.
    clear(refs.scenes);
    for (const scene of (d.skills.smarthome?.scenes ?? []).slice(0, 6)) {
      refs.scenes.append(h('button', { type: 'button', onclick: () => app.send(`activate ${scene.id === 'goodnight' ? 'good night' : scene.id === 'morning' ? 'good morning' : scene.id} mode`) }, scene.label));
    }

    // Learning and satisfaction.
    const learning = d.learning ?? {};
    setBar('learn', Math.min(1, (learning.samples ?? 0) / 600), `${Math.round(learning.samples ?? 0)}`);
    const sat = learning.feedback?.satisfaction;
    setBar('sat', sat ?? 0, sat == null ? '–' : `${Math.round(sat * 100)}`);

    // Uplink.
    refs.uplink.ai.set(d.llm?.enabled ? 'Claude online' : 'Built in', d.llm?.enabled ? 'is-good' : '');
    refs.uplink.voice.set(app.voice.speakEngine === 'cloud' ? 'Natural' : app.voice.speakEngine ? 'Browser' : 'Off', app.voice.speakEngine === 'cloud' ? 'is-good' : '');
    refs.uplink.ear.set(app.voice.listenEngine === 'cloud' ? 'Cloud' : app.voice.listenEngine ? 'Browser' : 'Unavailable', app.voice.listenEngine ? '' : 'is-warm');

    // Weather.
    const weather = d.skills.weather ?? {};
    clear(refs.weatherText);
    if (weather.current) {
      refs.weatherPlace.textContent = weather.place ?? '';
      const today = weather.daily?.[0];
      refs.weatherRing.set({ value: (today?.precipChance ?? 0) / 100, big: `${weather.current.temperature}°`, cap: weather.current.text });
      refs.weatherText.append(
        kv('Feels like').el, kv('High / low').el, kv('Rain').el, kv('Wind').el,
      );
      const rows = refs.weatherText.querySelectorAll('.hud-kv b');
      rows[0].textContent = `${weather.current.feelsLike}°`;
      rows[1].textContent = today ? `${today.max}° / ${today.min}°` : '–';
      rows[2].textContent = today?.precipChance != null ? `${today.precipChance}%` : '–';
      rows[3].textContent = `${weather.current.wind} ${weather.units?.wind ?? ''}`;
    } else {
      refs.weatherPlace.textContent = d.profile?.location ?? '';
      refs.weatherRing.set({ value: 0, big: '--', cap: weather.configured ? 'offline' : 'no city' });
      refs.weatherText.append(h('p', { class: 'hud-empty', text: weather.configured ? 'Forecast unavailable right now.' : 'Tell me your city to see the local forecast.' }));
      if (!weather.configured) refs.weatherText.append(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => app.openSettings('profile') }, 'Set city'));
    }

    // Upcoming: events, reminders and dated tasks, soonest first.
    const items = [
      ...(tasks.events ?? []).map((e) => ({ at: e.start, title: e.title })),
      ...(tasks.reminders ?? []).map((r) => ({ at: r.due, title: r.text })),
      ...(tasks.tasks ?? []).filter((t) => t.due).map((t) => ({ at: t.due, title: t.title, overdue: t.overdue })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(0, 6);
    clear(refs.upcoming);
    if (!items.length) refs.upcoming.append(h('p', { class: 'hud-empty', text: 'Nothing scheduled. Say "remind me to…" or "schedule…".' }));
    for (const item of items) {
      const when = new Date(item.at);
      const sameDay = when.toDateString() === new Date().toDateString();
      const label = sameDay ? `${pad(when.getHours())}:${pad(when.getMinutes())}` : `${DAYS[when.getDay()].slice(0, 3)} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
      refs.upcoming.append(h('div', { class: 'hud-agenda-row', title: item.title }, h('time', { datetime: item.at, class: item.overdue ? 'is-critical' : '', text: item.overdue ? 'OVERDUE' : label.toUpperCase() }), h('span', { text: item.title })));
    }

    // News.
    const news = d.skills.news ?? {};
    refs.newsTitle.textContent = news.topic ? cap(news.topic) : 'Top stories';
    clear(refs.news);
    if (!news.items?.length) refs.news.append(h('p', { class: 'hud-empty', text: 'Headlines unavailable right now.' }));
    for (const item of (news.items ?? []).slice(0, 5)) {
      refs.news.append(externalLink(item.link, {}, h('span', { text: item.title }), h('small', { text: [item.source, item.ago].filter(Boolean).join(' · ') })));
    }
  }

  // ---- state from the voice and the kernel
  function setState(state, text) {
    $('#hud-reactor').dataset.state = state;
    $('#hud-status').textContent = text;
    const labels = { idle: 'ONLINE', listening: 'LISTENING', standby: 'STANDBY', thinking: 'PROCESSING', speaking: 'SPEAKING', offline: 'OFFLINE' };
    refs.coreText.textContent = labels[state] ?? 'ONLINE';
    refs.dock.listen?.classList.toggle('is-live', state === 'listening');
  }
  function setLevel(level) {
    liveLevel = level;
    root.style.setProperty('--app-level', level.toFixed(3));
  }
  function setLatency(ms) {
    const text = ms == null ? 'Link ready' : `Reply in ${ms} ms`;
    $('#hud-latency').textContent = text;
    refs.uplink.latency.set(ms == null ? '–' : `${ms} ms`, ms != null && ms > 4000 ? 'is-warm' : '');
  }
  function setVoicePressed(on) {
    refs.dock.voice?.setAttribute('aria-pressed', String(on));
  }

  // ---- init
  buildRuler();
  buildReactor();
  buildWings();
  buildLeft();
  buildRight();
  buildDock();
  applyLayout(savedLayout());
  tick();
  setInterval(tick, 1000);
  requestAnimationFrame(drawWave);
  if (active()) startPolling();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollSystem(); });
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#hud-scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.dataset.sheet && !document.querySelector('dialog[open]')) closeSheet();
  });

  return { render, setState, setLevel, setLatency, setVoicePressed, setLayout, layout: () => root.dataset.layout, closeSheet, get data() { return data; } };
}
