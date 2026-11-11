// Tiny DOM helpers. Everything that comes from the server or the user is
// inserted with textContent / attributes, never as HTML.
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'use', 'g', 'rect', 'line', 'path', 'text', 'circle', 'title']);

export function h(tag, props = {}, ...children) {
  const isSvg = SVG_TAGS.has(tag);
  const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (!isSvg && ['checked', 'disabled', 'value', 'hidden', 'required', 'selected', 'open'].includes(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function icon(name, { size = 18, label = null, cls = '' } = {}) {
  const svg = h('svg', { class: `icon ${cls}`.trim(), width: size, height: size, 'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label });
  svg.append(h('use', { href: `#i-${name}` }));
  return svg;
}

export const clear = (el) => { el.replaceChildren(); return el; };
export const $ = (selector, root = document) => root.querySelector(selector);

/** Only http(s) and same-site paths are ever used as link targets. */
export function safeUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function externalLink(url, props = {}, ...children) {
  const href = safeUrl(url);
  if (!href) return h('span', props, ...children);
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', ...props }, ...children);
}

export function toast(message, { kind = 'info', iconName = 'info', timeout = 4500, actions = [] } = {}) {
  const host = $('#toasts');
  const el = h('div', { class: `toast ${kind === 'warm' ? 'is-warm' : kind === 'error' ? 'is-error' : ''}` }, icon(kind === 'error' ? 'alert' : iconName), h('span', { text: message }));
  for (const action of actions) {
    el.append(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { action.run(); el.remove(); } }, action.label));
  }
  host.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

/** Promise-based confirmation dialog for destructive or sensitive actions. */
export function confirmDialog({ title, text, confirmLabel = 'Confirm', danger = true }) {
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const ok = $('#confirm-ok');
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  return new Promise((resolve) => {
    const finish = (value) => {
      ok.removeEventListener('click', onOk);
      $('#confirm-cancel').removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onClose = () => finish(false);
    ok.addEventListener('click', onOk);
    $('#confirm-cancel').addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

const tooltipEl = () => $('#tooltip');
export function showTooltip(target, value, label) {
  const tip = tooltipEl();
  clear(tip).append(h('b', { text: value }), label);
  tip.hidden = false;
  const rect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - tipRect.width - 8, Math.max(8, rect.left + rect.width / 2 - tipRect.width / 2));
  const top = rect.top - tipRect.height - 8 < 8 ? rect.bottom + 8 : rect.top - tipRect.height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
export function hideTooltip() {
  tooltipEl().hidden = true;
}

export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const DEVICE_ICONS = { light: 'light', switch: 'switch', fan: 'fan', thermostat: 'thermostat', lock: 'lock', security: 'security', speaker: 'speaker-tv', blind: 'blind' };
export const cap = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
