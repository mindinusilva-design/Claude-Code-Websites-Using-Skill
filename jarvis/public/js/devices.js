// Device tile: one component used by the Home panel and by chat cards.
import { h, icon, confirmDialog, DEVICE_ICONS, toast } from './dom.js';

const SWITCHABLE = new Set(['light', 'switch', 'fan', 'speaker']);

function stateLine(device) {
  const s = device.state ?? {};
  if (device.type === 'lock') {
    return s.locked
      ? h('span', { class: 'device-state is-good' }, icon('lock', { size: 14 }), 'Locked')
      : h('span', { class: 'device-state is-warning' }, icon('unlock', { size: 14 }), 'Unlocked');
  }
  if (device.type === 'security') {
    return s.armed
      ? h('span', { class: 'device-state is-good' }, icon('security', { size: 14 }), `Armed (${s.mode})`)
      : h('span', { class: 'device-state' }, icon('info', { size: 14 }), 'Disarmed');
  }
  return h('span', { class: 'device-state', text: device.summary ? device.summary.charAt(0).toUpperCase() + device.summary.slice(1) : '' });
}

function range({ value, label, onCommit }) {
  const input = h('input', { type: 'range', min: 0, max: 100, step: 5, value: String(value ?? 0), 'aria-label': label });
  const paint = () => input.style.setProperty('--fill', `${input.value}%`);
  paint();
  input.addEventListener('input', paint);
  input.addEventListener('change', () => onCommit(Number(input.value)));
  return input;
}

/**
 * @param {object} device  { id, name, room, type, state, summary }
 * @param {(id, command, params) => Promise<object>} command  performs the action, resolves with the updated device
 */
export function deviceTile(device, command) {
  const s = device.state ?? {};
  const tile = h('div', { class: 'device', dataset: { id: device.id } });

  const run = async (name, params = {}) => {
    tile.setAttribute('aria-busy', 'true');
    try {
      const updated = await command(device.id, name, params);
      if (updated) tile.replaceWith(deviceTile(updated, command));
    } catch (error) {
      toast(error.message, { kind: 'error' });
    } finally {
      tile.removeAttribute('aria-busy');
    }
  };

  const on = Boolean(s.on) && device.type !== 'thermostat';
  if (on) tile.classList.add('is-on');
  if (device.type === 'lock' && !s.locked) tile.classList.add('is-alert');

  const top = h('div', { class: 'device-top' }, h('span', { class: 'device-icon' }, icon(device.type === 'lock' && !s.locked ? 'unlock' : DEVICE_ICONS[device.type] ?? 'switch')));
  if (SWITCHABLE.has(device.type)) {
    top.append(h('button', {
      class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(Boolean(s.on)),
      'aria-label': `${device.name} power`, onclick: () => run(s.on ? 'off' : 'on'),
    }));
  }
  tile.append(top, h('div', { class: 'device-name', text: device.name, title: `${device.name} (${device.room})` }), stateLine(device));

  const controls = h('div', { class: 'device-controls' });
  if (device.type === 'light' && s.on) {
    controls.append(range({ value: s.brightness ?? 100, label: `${device.name} brightness`, onCommit: (value) => run('set_brightness', { value }) }));
  } else if (device.type === 'fan' && s.on) {
    controls.append(range({ value: s.level ?? 50, label: `${device.name} speed`, onCommit: (value) => run('set_level', { value }) }));
  } else if (device.type === 'blind') {
    controls.append(range({ value: s.level ?? 0, label: `${device.name} position`, onCommit: (value) => run('set_level', { value }) }));
  } else if (device.type === 'thermostat') {
    const target = /set to ([^,]+)/.exec(device.summary ?? '')?.[1] ?? `${s.target}°`;
    controls.append(h('div', { class: 'stepper' },
      h('button', { class: 'icon-btn icon-btn-sm', type: 'button', 'aria-label': 'Lower temperature', onclick: () => run('adjust_temperature', { delta: -0.5 }) }, icon('minus', { size: 16 })),
      h('span', { class: 'stepper-value', text: target, 'aria-live': 'polite' }),
      h('button', { class: 'icon-btn icon-btn-sm', type: 'button', 'aria-label': 'Raise temperature', onclick: () => run('adjust_temperature', { delta: 0.5 }) }, icon('plus', { size: 16 })),
    ));
  } else if (device.type === 'lock') {
    controls.append(h('button', {
      class: 'btn btn-sm', type: 'button',
      onclick: async () => {
        if (s.locked && !(await confirmDialog({ title: `Unlock the ${device.name.toLowerCase()}?`, text: 'Anyone at the door will be able to open it.', confirmLabel: 'Unlock' }))) return;
        run(s.locked ? 'unlock' : 'lock');
      },
    }, s.locked ? 'Unlock' : 'Lock'));
  } else if (device.type === 'security') {
    if (s.armed) {
      controls.append(h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async () => {
          if (await confirmDialog({ title: 'Disarm the security system?', text: 'Sensors will stop triggering the alarm.', confirmLabel: 'Disarm' })) run('disarm');
        },
      }, 'Disarm'));
    } else {
      controls.append(
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => run('arm', { mode: 'away' }) }, 'Arm away'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => run('arm', { mode: 'home' }) }, 'Arm home'),
      );
    }
  }
  if (controls.childElementCount) tile.append(controls);
  return tile;
}
