import { createAdapter } from './adapters.js';
import { parseLevel, parseColor, COLORS } from '../../core/nlu/entities.js';

const TYPE_WORDS = {
  light: ['lights', 'light', 'lamps', 'lamp', 'bulbs', 'bulb', 'lighting'],
  switch: ['switches', 'switch', 'plugs', 'plug', 'outlets', 'outlet'],
  fan: ['fans', 'fan'],
  thermostat: ['thermostat', 'heating', 'heater', 'heat', 'air conditioning', 'air conditioner', 'ac', 'climate'],
  lock: ['locks', 'lock', 'doors', 'door'],
  security: ['security system', 'alarm system', 'security', 'alarm'],
  speaker: ['television', 'tv', 'speakers', 'speaker'],
  blind: ['blinds', 'blind', 'curtains', 'shades', 'shutters'],
};

const SCENES = {
  goodnight: {
    label: 'Good night',
    steps: [
      { type: 'light', command: 'off' },
      { type: 'speaker', command: 'off' },
      { type: 'switch', command: 'off' },
      { type: 'lock', command: 'lock' },
      { type: 'security', command: 'arm', params: { mode: 'night' } },
      { type: 'thermostat', command: 'set_temperature', params: { value: 18, unit: 'C' } },
    ],
    say: 'Good night. The lights are off, the doors are locked, the alarm is armed in night mode and the thermostat is set to {t18}.',
  },
  morning: {
    label: 'Good morning',
    steps: [
      { type: 'security', command: 'disarm' },
      { type: 'light', rooms: ['kitchen', 'bedroom'], command: 'set_brightness', params: { value: 70 } },
      { type: 'switch', rooms: ['kitchen'], command: 'on' },
      { type: 'blind', command: 'set_level', params: { value: 100 } },
      { type: 'thermostat', command: 'set_temperature', params: { value: 21, unit: 'C' } },
    ],
    say: 'Good morning. The kitchen and bedroom lights are on, the alarm is off, the coffee maker is running and the thermostat is set to {t21}.',
  },
  movie: {
    label: 'Movie',
    steps: [
      { type: 'light', rooms: ['living room'], command: 'set_brightness', params: { value: 15 } },
      { type: 'light', exceptRooms: ['living room'], command: 'off' },
      { type: 'blind', command: 'set_level', params: { value: 0 } },
      { type: 'speaker', rooms: ['living room'], command: 'on' },
    ],
    say: 'Movie mode is on. The living room lights are dimmed, the blinds are closed and the TV is on.',
  },
  away: {
    label: 'Away',
    steps: [
      { type: 'light', command: 'off' },
      { type: 'switch', command: 'off' },
      { type: 'speaker', command: 'off' },
      { type: 'fan', command: 'off' },
      { type: 'lock', command: 'lock' },
      { type: 'security', command: 'arm', params: { mode: 'away' } },
      { type: 'thermostat', command: 'set_temperature', params: { value: 16, unit: 'C' } },
    ],
    say: 'Away mode is on. Everything is switched off, the doors are locked and the alarm is armed.',
  },
  home: {
    label: 'Welcome home',
    steps: [
      { type: 'security', command: 'disarm' },
      { type: 'light', rooms: ['living room', 'kitchen'], command: 'on' },
      { type: 'thermostat', command: 'set_temperature', params: { value: 21, unit: 'C' } },
    ],
    say: 'Welcome home. The alarm is off, the living room and kitchen lights are on and the thermostat is set to {t21}.',
  },
  relax: {
    label: 'Relax',
    steps: [
      { type: 'light', rooms: ['living room'], command: 'set_brightness', params: { value: 40 } },
      { type: 'light', rooms: ['living room'], command: 'set_color', params: { value: 'warm white' } },
    ],
    say: 'Relax mode is on. The living room lights are warm and dimmed to 40%.',
  },
  focus: {
    label: 'Focus',
    steps: [
      { type: 'light', rooms: ['office'], command: 'set_brightness', params: { value: 100 } },
      { type: 'light', rooms: ['office'], command: 'set_color', params: { value: 'cool white' } },
      { type: 'speaker', command: 'off' },
    ],
    say: 'Focus mode is on. The office lights are bright and cool, and the TV is off.',
  },
  party: {
    label: 'Party',
    steps: [
      { type: 'light', rooms: ['living room'], command: 'set_color', params: { value: 'purple' } },
      { type: 'light', rooms: ['living room'], command: 'set_brightness', params: { value: 100 } },
      { type: 'speaker', rooms: ['living room'], command: 'on' },
    ],
    say: 'Party mode is on. The living room lights are purple at full brightness.',
  },
};

const SCENE_ALIASES = {
  'good night': 'goodnight', goodnight: 'goodnight', night: 'goodnight', bedtime: 'goodnight', sleep: 'goodnight',
  'good morning': 'morning', goodmorning: 'morning', morning: 'morning',
  movie: 'movie', cinema: 'movie', away: 'away', leaving: 'away', home: 'home', back: 'home',
  relax: 'relax', reading: 'relax', chill: 'relax', focus: 'focus', work: 'focus', party: 'party',
};

const PRONOUNS = /^(it|them|that|those|this|these|that one|the same|same)$/;

const list = (items) => {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
};
const lc = (name) => name.charAt(0).toLowerCase() + name.slice(1);
const singular = (t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
const uniqueById = (devices) => [...new Map(devices.map((d) => [d.id, d])).values()];

export function formatTemperature(value, fromUnit, units) {
  if (value == null) return 'unknown';
  const wantF = units === 'imperial';
  let v = Number(value);
  if (fromUnit === 'C' && wantF) v = (v * 9) / 5 + 32;
  if (fromUnit === 'F' && !wantF) v = ((v - 32) * 5) / 9;
  return `${Number(v.toFixed(1))}°${wantF ? 'F' : 'C'}`;
}

export function describeState(device, units = 'metric') {
  const s = device.state ?? {};
  switch (device.type) {
    case 'light':
      return s.on ? `on at ${s.brightness ?? 100}%${s.color ? ` (${s.color})` : ''}` : 'off';
    case 'thermostat':
      return `${s.on === false ? 'off' : `set to ${formatTemperature(s.target, s.unit ?? 'C', units)}`}${s.current != null ? `, currently ${formatTemperature(s.current, s.unit ?? 'C', units)}` : ''}`;
    case 'lock':
      return s.locked ? 'locked' : 'unlocked';
    case 'security':
      return s.armed ? `armed (${s.mode})` : 'disarmed';
    case 'fan':
      return s.on ? `on at ${s.level ?? 100}%` : 'off';
    case 'blind':
      return s.level >= 100 ? 'open' : s.level <= 0 ? 'closed' : `${s.level}% open`;
    default:
      return s.on ? 'on' : 'off';
  }
}

/** Device registry: persistence, name resolution and command execution. */
export class DeviceRegistry {
  constructor({ store, events, adapter, security }) {
    this.collection = store.collection('devices');
    this.events = events;
    this.adapter = adapter;
    this.security = security;
  }

  all() {
    return this.collection.all();
  }

  get(id) {
    return this.collection.get(id);
  }

  rooms() {
    return [...new Set(this.all().map((d) => d.room))].sort((a, b) => b.length - a.length);
  }

  /** Pull devices from the adapter and merge them into the local registry. */
  async discover() {
    const found = await this.adapter.discover();
    const existing = this.all();
    const merged = found.map((device) => {
      const prior = existing.find((d) => d.externalId === device.externalId && d.adapter === device.adapter);
      if (!prior) return null;
      const preferLocal = this.adapter.id === 'simulated';
      return { ...prior, name: device.name, room: device.room, type: device.type, state: preferLocal ? prior.state : device.state };
    });
    const fresh = [];
    found.forEach((device, i) => {
      if (!merged[i]) fresh.push(this.collection.insert(device));
    });
    const kept = merged.filter(Boolean);
    if (kept.length) {
      const byId = new Map(kept.map((d) => [d.id, d]));
      this.collection.replace(this.collection.all().map((d) => byId.get(d.id) ?? d));
    }
    // Drop devices from other adapters so switching adapters gives a clean registry.
    const stale = this.collection.all().filter((d) => d.adapter !== this.adapter.id);
    if (stale.length) this.collection.replace(this.collection.all().filter((d) => d.adapter === this.adapter.id));
    return { added: fresh.length, total: this.all().length };
  }

  typeOf(piece) {
    for (const [type, words] of Object.entries(TYPE_WORDS)) {
      for (const word of words) {
        if (new RegExp(`\\b${word}\\b`).test(piece)) return { type, word };
      }
    }
    return null;
  }

  #fuzzy(piece, pool) {
    const tokens = piece.split(/\s+/).map(singular).filter((t) => t && !['all', 'every', 'in', 'on', 'of'].includes(t));
    if (!tokens.length) return [];
    return pool.filter((d) => {
      const hay = `${d.name} ${d.room}`.toLowerCase().split(/\s+/).map(singular);
      return tokens.every((t) => hay.includes(t));
    });
  }

  #resolvePiece(piece, all, preferType) {
    const exact = all.filter((d) => d.name.toLowerCase() === piece);
    if (exact.length) return exact;
    const room = this.rooms().find((r) => new RegExp(`\\b${r}\\b`).test(piece));
    const typed = this.typeOf(piece);
    let pool = all;
    if (room) pool = pool.filter((d) => d.room === room);
    if (/^(everything|all devices|all)\b/.test(piece) && room) return pool;
    if (typed) pool = pool.filter((d) => d.type === typed.type);
    let remaining = piece;
    if (room) remaining = remaining.replace(new RegExp(`\\b${room}\\b`), ' ');
    if (typed) remaining = remaining.replace(new RegExp(`\\b${typed.word}\\b`), ' ');
    remaining = remaining.replace(/\b(in|on|of|all|every)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!remaining) {
      if (room && !typed) {
        const wanted = pool.filter((d) => d.type === (preferType ?? 'light'));
        return wanted.length ? wanted : pool;
      }
      return pool;
    }
    const narrowed = this.#fuzzy(remaining, pool);
    if (narrowed.length) return narrowed;
    return this.#fuzzy(piece, all);
  }

  /** "kitchen lights and the fan" -> { devices, unresolved } */
  resolve(target, { preferType = null } = {}) {
    const all = this.all();
    const text = String(target ?? '')
      .toLowerCase()
      .replace(/[.?!]/g, '')
      .replace(/\b(the|my|our|please|all of the|all the)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return { devices: [], unresolved: [] };
    if (/^(everything|all devices|every device|all|the house|whole house)$/.test(text)) {
      return { devices: all.filter((d) => !['lock', 'security', 'thermostat'].includes(d.type)), unresolved: [] };
    }
    const devices = [];
    const unresolved = [];
    for (const piece of text.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean)) {
      const found = this.#resolvePiece(piece, all, preferType);
      if (found.length) devices.push(...found);
      else unresolved.push(piece);
    }
    return { devices: uniqueById(devices), unresolved };
  }

  async command(device, command, params = {}, { actor = 'user' } = {}) {
    const state = await this.adapter.execute(device, command, params);
    const updated = this.collection.update(device.id, { state });
    this.security?.audit('device.command', { device: device.name, command, params }, actor);
    this.events.publish('device.changed', { device: updated, command });
    return updated;
  }
}

/** Factory: the skill closes over its device registry. */
export function createSmartHomeSkill() {
  let registry = null;

  const targetSlots = (raw) => {
    const target = String(raw ?? '').replace(/\bplease\b/g, '').trim();
    if (!target || PRONOUNS.test(target)) return { pronoun: true };
    return { target };
  };

  const resolveTargets = (slots, ctx, preferType) => {
    if (slots.devices?.length) {
      const devices = registry.all().filter((d) => slots.devices.includes(d.name));
      if (devices.length) return { devices, unresolved: [] };
    }
    if (slots.target) return registry.resolve(slots.target, { preferType });
    if (slots.room) return registry.resolve(slots.room, { preferType });
    return { devices: [], unresolved: [] };
  };

  const notFound = (slots, unresolved) => {
    const what = unresolved?.length ? `"${unresolved.join('", "')}"` : slots.pronoun ? 'the device you mean' : 'that device';
    const rooms = registry.rooms().slice().sort();
    return {
      text: `I couldn't find ${what}. I know about devices in the ${list(rooms)}. Try "turn on the kitchen lights" or ask me to "list devices".`,
      unresolved: true,
    };
  };

  const track = (devices) => {
    const names = devices.map((d) => d.name);
    const switchable = devices.filter((d) => ['light', 'switch', 'fan', 'speaker', 'blind'].includes(d.type)).map((d) => d.name);
    return {
      lastDevices: names,
      lastSwitchable: switchable.length ? switchable : undefined,
      lastRoom: devices.length && devices.every((d) => d.room === devices[0].room) ? devices[0].room : undefined,
    };
  };

  const card = (devices, units) => ({
    type: 'devices',
    title: 'Devices',
    devices: devices.map((d) => ({ id: d.id, name: d.name, room: d.room, type: d.type, state: d.state, summary: describeState(d, units) })),
  });

  async function run(devices, command, params, ctx) {
    const done = [];
    const failed = [];
    for (const device of devices) {
      try {
        done.push(await registry.command(device, command, params, { actor: ctx.actor ?? 'user' }));
      } catch (error) {
        failed.push({ device, error: error.message });
      }
    }
    return { done, failed };
  }

  const failureText = (failed) => (failed.length ? ` I couldn't reach ${list(failed.map((f) => lc(f.device.name)))}.` : '');

  // -- intent handlers ------------------------------------------------------
  async function power(slots, ctx) {
    const { devices, unresolved } = resolveTargets(slots, ctx, 'light');
    if (!devices.length) return notFound(slots, unresolved);
    const controllable = devices.filter((d) => !['lock', 'security'].includes(d.type));
    if (!controllable.length) return { text: `${devices[0].name} can't be turned ${slots.state}. Try "lock" or "arm" instead.` };
    const { done, failed } = await run(controllable, slots.state === 'off' ? 'off' : 'on', {}, ctx);
    const names = done.map((d) => lc(d.name));
    const text = done.length
      ? `Turned ${slots.state} ${done.length > 3 ? `${done.length} devices: ${list(names)}` : `the ${list(names)}`}.${failureText(failed)}`
      : `Sorry, I couldn't do that.${failureText(failed)}`;
    return { text, cards: [card(done, ctx.profile.get('units'))], track: track(done), slots: { ...slots, devices: done.map((d) => d.name) } };
  }

  async function level(slots, ctx) {
    const { devices, unresolved } = resolveTargets(slots, ctx, 'light');
    const dimmable = devices.filter((d) => ['light', 'fan', 'blind'].includes(d.type));
    if (!dimmable.length) return devices.length ? { text: `${devices[0].name} doesn't have a level I can set.` } : notFound(slots, unresolved);
    const done = [];
    for (const device of dimmable) {
      const isLight = device.type === 'light';
      if (slots.delta != null) {
        done.push(await registry.command(device, isLight ? 'adjust_brightness' : 'set_level', isLight ? { delta: slots.delta } : { value: (device.state.level ?? 50) + slots.delta }, { actor: ctx.actor }));
      } else {
        done.push(await registry.command(device, isLight ? 'set_brightness' : 'set_level', { value: slots.value }, { actor: ctx.actor }));
      }
    }
    const first = done[0];
    const value = first.type === 'light' ? first.state.brightness : first.state.level;
    return {
      text: `Set the ${list(done.map((d) => lc(d.name)))} to ${value}%.`,
      cards: [card(done, ctx.profile.get('units'))],
      track: track(done),
      slots: { ...slots, devices: done.map((d) => d.name) },
    };
  }

  async function color(slots, ctx) {
    const { devices, unresolved } = resolveTargets(slots, ctx, 'light');
    const lights = devices.filter((d) => d.type === 'light');
    if (!lights.length) return devices.length ? { text: `${devices[0].name} can't change color.` } : notFound(slots, unresolved);
    const { done, failed } = await run(lights, 'set_color', { value: slots.color }, ctx);
    return {
      text: `Changed the ${list(done.map((d) => lc(d.name)))} to ${slots.color}.${failureText(failed)}`,
      cards: [card(done, ctx.profile.get('units'))],
      track: track(done),
      slots: { ...slots, devices: done.map((d) => d.name) },
    };
  }

  async function thermostat(slots, ctx) {
    const units = ctx.profile.get('units');
    const all = registry.all().filter((d) => d.type === 'thermostat');
    let devices = all;
    if (slots.target) {
      const scoped = registry.resolve(`${slots.target} thermostat`).devices.filter((d) => d.type === 'thermostat');
      if (scoped.length) devices = scoped;
    }
    if (!devices.length) return { text: "I don't see a thermostat in your home yet." };
    const device = devices[0];
    if (slots.query) {
      return { text: `The ${lc(device.name)} is ${describeState(device, units)}.`, cards: [card([device], units)], track: track([device]) };
    }
    let updated;
    if (slots.delta != null) {
      updated = await registry.command(device, 'adjust_temperature', { delta: slots.delta }, { actor: ctx.actor });
    } else {
      let value = Number(slots.value);
      const given = slots.unit ?? (value > 45 ? 'F' : units === 'imperial' && value > 45 ? 'F' : 'C');
      const deviceUnit = device.state.unit ?? 'C';
      if (given === 'F' && deviceUnit === 'C') value = Number((((value - 32) * 5) / 9).toFixed(1));
      if (given === 'C' && deviceUnit === 'F') value = Number(((value * 9) / 5 + 32).toFixed(1));
      if ((deviceUnit === 'C' && (value < 5 || value > 35)) || (deviceUnit === 'F' && (value < 41 || value > 95))) {
        return { text: `That temperature is outside the safe range for the ${lc(device.name)}. Pick something between ${formatTemperature(5, 'C', units)} and ${formatTemperature(35, 'C', units)}.` };
      }
      updated = await registry.command(device, 'set_temperature', { value, unit: deviceUnit }, { actor: ctx.actor });
    }
    const reason = slots.feeling ? ` since you're feeling ${slots.feeling}` : '';
    return {
      text: `The ${lc(updated.name)} is now set to ${formatTemperature(updated.state.target, updated.state.unit ?? 'C', units)}${reason}.`,
      cards: [card([updated], units)],
      track: track([updated]),
    };
  }

  async function lock(slots, ctx) {
    const units = ctx.profile.get('units');
    const target = slots.target && !/^(door|doors|all doors|everything|the doors|up|house|the house)$/.test(slots.target) ? slots.target : 'doors';
    const { devices, unresolved } = slots.devices?.length ? resolveTargets(slots, ctx, 'lock') : registry.resolve(target, { preferType: 'lock' });
    const locks = devices.filter((d) => d.type === 'lock');
    if (!locks.length) return notFound(slots, unresolved.length ? unresolved : [target]);
    if (slots.query) {
      return { text: locks.map((d) => `The ${lc(d.name)} is ${describeState(d)}.`).join(' '), cards: [card(locks, units)], track: track(locks) };
    }
    if (slots.action === 'unlock') {
      if (slots.confirm === undefined) {
        return {
          text: `Unlock the ${list(locks.map((d) => lc(d.name)))}? Say "yes" to confirm.`,
          pending: { intent: 'smarthome.lock', slots: { ...slots, devices: locks.map((d) => d.name) }, slot: 'confirm' },
        };
      }
      if (slots.confirm !== 'yes') return { text: 'Okay, the door stays locked.' };
    }
    const { done, failed } = await run(locks, slots.action, {}, ctx);
    return {
      text: `${slots.action === 'lock' ? 'Locked' : 'Unlocked'} the ${list(done.map((d) => lc(d.name)))}.${failureText(failed)}`,
      cards: [card(done, units)],
      track: track(done),
    };
  }

  async function securitySystem(slots, ctx) {
    const units = ctx.profile.get('units');
    const systems = registry.all().filter((d) => d.type === 'security');
    if (!systems.length) return { text: "I don't see a security system in your home yet." };
    const system = systems[0];
    if (slots.query) return { text: `The ${lc(system.name)} is ${describeState(system)}.`, cards: [card([system], units)] };
    if (slots.action === 'disarm') {
      if (slots.confirm === undefined) {
        return { text: `Disarm the ${lc(system.name)}? Say "yes" to confirm.`, pending: { intent: 'smarthome.security', slots, slot: 'confirm' } };
      }
      if (slots.confirm !== 'yes') return { text: 'Okay, the alarm stays armed.' };
      const updated = await registry.command(system, 'disarm', {}, { actor: ctx.actor });
      return { text: `The ${lc(updated.name)} is disarmed.`, cards: [card([updated], units)], track: track([updated]) };
    }
    const updated = await registry.command(system, 'arm', { mode: slots.mode ?? 'away' }, { actor: ctx.actor });
    return { text: `The ${lc(updated.name)} is armed in ${updated.state.mode} mode.`, cards: [card([updated], units)], track: track([updated]) };
  }

  async function status(slots, ctx) {
    const units = ctx.profile.get('units');
    let devices;
    if (slots.filter === 'on' || slots.filter === 'off') {
      const wantOn = slots.filter === 'on';
      devices = registry.all().filter((d) => (slots.type ? d.type === slots.type : 'on' in (d.state ?? {})) && Boolean(d.state.on) === wantOn);
      if (!devices.length) return { text: `Nothing is ${slots.filter} right now.` };
      return { text: `${devices.length === 1 ? 'One device is' : `${devices.length} devices are`} ${slots.filter}: ${list(devices.map((d) => lc(d.name)))}.`, cards: [card(devices, units)] };
    }
    if (slots.target || slots.pronoun || slots.devices?.length) {
      const resolved = resolveTargets(slots, ctx, null);
      if (!resolved.devices.length) return notFound(slots, resolved.unresolved);
      devices = resolved.devices;
      const text = devices.map((d) => `The ${lc(d.name)} is ${describeState(d, units)}.`).join(' ');
      return { text, cards: [card(devices, units)], track: track(devices) };
    }
    devices = registry.all();
    const on = devices.filter((d) => d.state?.on).length;
    return {
      text: `You have ${devices.length} devices across ${registry.rooms().length} rooms; ${on} ${on === 1 ? 'is' : 'are'} on.`,
      cards: [card(devices, units)],
    };
  }

  async function scene(slots, ctx) {
    const key = SCENE_ALIASES[String(slots.scene ?? '').toLowerCase().replace(/\s+mode$/, '')] ?? slots.scene;
    const definition = SCENES[key];
    if (!definition) return { text: `I don't have a "${slots.scene}" scene. Available scenes: ${list(Object.values(SCENES).map((s) => s.label.toLowerCase()))}.` };
    const units = ctx.profile.get('units');
    const touched = [];
    for (const step of definition.steps) {
      const targets = registry.all().filter((d) =>
        d.type === step.type
        && (!step.rooms || step.rooms.includes(d.room))
        && (!step.exceptRooms || !step.exceptRooms.includes(d.room)));
      for (const device of targets) {
        try {
          touched.push(await registry.command(device, step.command, step.params ?? {}, { actor: ctx.actor ?? 'scene' }));
        } catch { /* a single unreachable device never aborts a scene */ }
      }
    }
    const latest = uniqueById(touched.reverse()).reverse().map((d) => registry.get(d.id));
    const text = definition.say.replace('{t18}', formatTemperature(18, 'C', units)).replace('{t21}', formatTemperature(21, 'C', units));
    return { text, cards: [card(latest, units)], slots: { scene: key } };
  }

  // -- tool used by the language model --------------------------------------
  async function controlTool(input, ctx) {
    const { target, action, value } = input;
    const base = targetSlots(target);
    switch (action) {
      case 'on':
      case 'off': return power({ ...base, state: action }, ctx);
      case 'set_brightness': return level({ ...base, value: Number(value) }, ctx);
      case 'set_color': return color({ ...base, color: String(value) }, ctx);
      case 'set_temperature': return thermostat({ value: Number(value) }, ctx);
      case 'lock': return lock({ ...base, action: 'lock' }, ctx);
      case 'unlock': {
        const result = await lock({ ...base, action: 'unlock' }, ctx);
        if (result.pending) ctx.session?.setPending(result.pending);
        return result.pending ? { needs_confirmation: true, message: 'Ask the user to confirm by saying "yes". Do not claim the door is unlocked.' } : result;
      }
      case 'arm': return securitySystem({ action: 'arm', mode: typeof value === 'string' ? value : 'away' }, ctx);
      case 'disarm': {
        const result = await securitySystem({ action: 'disarm' }, ctx);
        if (result.pending) ctx.session?.setPending(result.pending);
        return result.pending ? { needs_confirmation: true, message: 'Ask the user to confirm by saying "yes". Do not claim the alarm is disarmed.' } : result;
      }
      default: return { error: `unknown action ${action}` };
    }
  }

  const colorRe = COLORS.slice().sort((a, b) => b.length - a.length).join('|');
  const sceneRe = 'movie|cinema|night|good ?night|bedtime|sleep|morning|good ?morning|away|home|party|relax|reading|chill|focus|work';

  return {
    id: 'smarthome',
    name: 'Smart Home',
    description: 'Controls lights, switches, fans, thermostats, locks, blinds and the security system through pluggable adapters (simulated, Home Assistant, Philips Hue).',

    async setup(ctx) {
      const kind = ctx.config.smarthomeAdapter ?? 'simulated';
      let adapter;
      try {
        adapter = createAdapter(kind, ctx.integrations?.config(kind) ?? {});
      } catch (error) {
        ctx.logger.warn?.(`[jarvis] smart home adapter "${kind}" is not configured (${error.message}); using the simulated home.`);
        adapter = createAdapter('simulated');
      }
      registry = new DeviceRegistry({ store: ctx.store, events: ctx.events, adapter, security: ctx.security });
      ctx.devices = registry;
      try {
        await registry.discover();
      } catch (error) {
        ctx.logger.warn?.(`[jarvis] device discovery failed: ${error.message}`);
      }
    },

    intents: [
      {
        name: 'smarthome.scene',
        priority: 4,
        examples: ['activate movie mode', 'good night', 'good morning', 'i am leaving', 'start party mode', 'movie time', 'i am home'],
        patterns: [
          new RegExp(`^(?:activate|run|start|set|enable|trigger|turn on|switch to|go to)\\s+(?:the\\s+)?(${sceneRe})\\s*(?:mode|scene)?$`),
          new RegExp(`^(${sceneRe})\\s+(?:mode|scene|time)$`),
          /^(good ?night|good ?morning)$/,
          /^i am (leaving|home|back|going to bed|going out|heading out|off to bed)$/,
          /^(?:it is |time for )?(bedtime|movie night)$/,
        ],
        slots: (m) => {
          const raw = m[1].replace(/^going to bed|off to bed$/, 'bedtime').replace(/^going out|heading out$/, 'leaving').replace('movie night', 'movie');
          const key = SCENE_ALIASES[raw.replace(/\s+/g, ' ')] ?? SCENE_ALIASES[raw.replace(/\s+/g, '')];
          return key ? { scene: key } : null;
        },
        handler: scene,
      },
      {
        name: 'smarthome.thermostat',
        priority: 3,
        examples: ['set the thermostat to 72', 'turn the heating up', 'i am cold', 'make it warmer', 'what is the thermostat set to', 'set temperature to 21 degrees'],
        patterns: [
          /^(?:set|turn|put|change|adjust)\s+(?:the\s+)?(?:(.+?)\s+)?(?:thermostat|heating|heat|heater|temperature|ac|air conditioning)\s+(?:to\s+|at\s+)?(-?\d{1,3}(?:\.\d)?)\s*(?:°|degrees?)?\s*(c|f|celsius|fahrenheit)?$/,
          /^(?:set|make)\s+it\s+(?:to\s+)?(-?\d{1,3}(?:\.\d)?)\s*(?:°|degrees?)\s*(c|f|celsius|fahrenheit)?(?:\s+in here)?$/,
          /^(?:turn|crank|bump)\s+(up|down)\s+(?:the\s+)?(?:thermostat|heating|heat|temperature|ac|air conditioning)$/,
          /^(?:turn|crank|bump)\s+(?:the\s+)?(?:thermostat|heating|heat|temperature|ac|air conditioning)\s+(up|down)$/,
          /^(?:make it|i want it)\s+(warmer|cooler|colder|hotter)(?:\s+in here)?$/,
          /^(?:it is|i am|i feel)\s+(?:a bit\s+|a little\s+|too\s+|so\s+|really\s+|very\s+)?(cold|hot|warm|chilly|freezing|boiling|roasting)(?:\s+in here)?$/,
          /^what is\s+(?:the\s+)?(?:thermostat|heating|temperature)\s+(?:set to|at|set at)$/,
          /^what(?: temperature)? is (?:the\s+)?(?:thermostat|temperature inside|temperature in here|indoor temperature)(?:\s+(?:set to|at))?$/,
        ],
        slots: (m, { stripped }) => {
          if (/^(?:set|turn|put|change|adjust)\b/.test(stripped) && m[2] !== undefined && /\d/.test(m[2] ?? '')) {
            return { target: m[1]?.trim() || undefined, value: Number(m[2]), unit: m[3] ? m[3][0].toUpperCase() : undefined };
          }
          if (/^(?:set|make)\s+it\b/.test(stripped) && /\d/.test(m[1] ?? '')) return { value: Number(m[1]), unit: m[2] ? m[2][0].toUpperCase() : undefined };
          if (/^what\b/.test(stripped)) return { query: true };
          const word = m[1];
          if (word === 'up' || ['warmer', 'hotter'].includes(word)) return { delta: 1.5 };
          if (word === 'down' || ['cooler', 'colder'].includes(word)) return { delta: -1.5 };
          if (['cold', 'chilly', 'freezing'].includes(word)) return { delta: 2, feeling: word };
          if (['hot', 'warm', 'boiling', 'roasting'].includes(word)) return { delta: -2, feeling: word };
          return null;
        },
        handler: thermostat,
      },
      {
        name: 'smarthome.security',
        priority: 3,
        examples: ['arm the alarm', 'disarm the security system', 'set the alarm to night mode', 'is the alarm on', 'arm the security system in away mode'],
        patterns: [
          /^(arm|disarm|activate|deactivate|enable|disable)\s+(?:the\s+)?(?:house\s+)?(?:security system|alarm system|security|alarm)(?:\s+(?:in|to|for)\s+(home|away|night|stay)\s*mode)?$/,
          /^(?:set|put|switch)\s+(?:the\s+)?(?:security system|alarm system|security|alarm)\s+(?:to|in|on)\s+(home|away|night|stay|off)(?:\s+mode)?$/,
          /^turn\s+(on|off)\s+(?:the\s+)?(?:security system|alarm system|security|alarm)$/,
          /^turn\s+(?:the\s+)?(?:security system|alarm system|security|alarm)\s+(on|off)$/,
          /^is\s+(?:the\s+)?(?:security system|alarm system|security|alarm)\s+(?:on|off|armed|disarmed|set|active)$/,
        ],
        slots: (m, { stripped }) => {
          if (/^is\b/.test(stripped)) return { query: true };
          const verb = m[1];
          if (['home', 'away', 'night', 'stay'].includes(verb)) return { action: 'arm', mode: verb === 'stay' ? 'home' : verb };
          if (verb === 'off' || ['disarm', 'deactivate', 'disable'].includes(verb)) return { action: 'disarm' };
          return { action: 'arm', mode: m[2] ? (m[2] === 'stay' ? 'home' : m[2]) : 'away' };
        },
        handler: securitySystem,
      },
      {
        name: 'smarthome.lock',
        priority: 3,
        examples: ['lock the front door', 'unlock the back door', 'is the front door locked', 'lock all the doors', 'lock up'],
        patterns: [
          /^(lock|unlock)\s+(?:the\s+|all\s+(?:the\s+)?|my\s+)?(.+)$/,
          /^(?:is|are)\s+(?:the\s+|my\s+)?(.+?)\s+(?:locked|unlocked|secure)$/,
          /^(lock) up(?: the house)?$/,
        ],
        slots: (m, { stripped }) => {
          if (/^(?:is|are)\b/.test(stripped)) return { query: true, target: m[1].trim() };
          if (/^lock up/.test(stripped)) return { action: 'lock', target: 'doors' };
          const target = m[2].trim();
          if (/\b(screen|phone|computer|laptop|account)\b/.test(target)) return null;
          return { action: m[1], target };
        },
        handler: lock,
      },
      {
        name: 'smarthome.color',
        priority: 2,
        examples: ['make the living room lights blue', 'set the bedroom lamp to warm white', 'change the office lights to red'],
        patterns: [
          new RegExp(`^(?:set|change|make|turn|switch)\\s+(?:the\\s+)?(.+?)\\s+(?:color\\s+)?(?:to\\s+)?(${colorRe})$`),
          new RegExp(`^(?:i want|give me)\\s+(${colorRe})\\s+(?:light|lights|lighting)\\s+in\\s+(?:the\\s+)?(.+)$`),
        ],
        slots: (m, { stripped }) => {
          if (/^(?:i want|give me)\b/.test(stripped)) return { ...targetSlots(m[2]), color: m[1] };
          return { ...targetSlots(m[1]), color: parseColor(m[2]) ?? m[2] };
        },
        handler: color,
      },
      {
        name: 'smarthome.level',
        priority: 2,
        examples: ['dim the living room lights', 'set the bedroom lamp to 50%', 'brighten the office lights', 'make the kitchen lights brighter', 'dim the lights to 20 percent'],
        patterns: [
          /^(?:dim|brighten|set|turn|put)\s+(?:the\s+)?(.+?)\s+(?:brightness\s+)?(?:down\s+|up\s+)?(?:to|at)\s+(\d{1,3})\s*(?:%|percent)?$/,
          /^(dim|brighten)\s+(?:the\s+)?(.+)$/,
          /^(?:make|turn|set)\s+(?:the\s+)?(.+?)\s+(brighter|dimmer|darker|lighter)$/,
          /^(?:turn|bring)\s+(?:the\s+)?(.+?)\s+(up|down)(?:\s+a (?:bit|little))?$/,
          /^(?:open|close|raise|lower)\s+(?:the\s+)?(.*(?:blinds?|curtains|shades|shutters).*)$/,
        ],
        slots: (m, { stripped }) => {
          if (/(thermostat|heating|heat|temperature|\bac\b|air conditioning|alarm|security|volume)/.test(stripped)) return null;
          if (/^(?:open|raise)\b/.test(stripped)) return { ...targetSlots(m[1]), value: 100 };
          if (/^(?:close|lower)\b/.test(stripped)) return { ...targetSlots(m[1]), value: 0 };
          if (m[2] !== undefined && /^\d+$/.test(m[2])) return { ...targetSlots(m[1]), value: Math.min(100, Number(m[2])) };
          if (m[1] === 'dim') return { ...targetSlots(m[2]), value: parseLevel('dim') };
          if (m[1] === 'brighten') return { ...targetSlots(m[2]), value: parseLevel('bright') };
          const dir = m[2];
          if (['brighter', 'lighter', 'up'].includes(dir)) return { ...targetSlots(m[1]), delta: 25 };
          if (['dimmer', 'darker', 'down'].includes(dir)) return { ...targetSlots(m[1]), delta: -25 };
          return null;
        },
        handler: level,
      },
      {
        name: 'smarthome.power',
        priority: 1,
        examples: ['turn on the kitchen lights', 'turn off the living room lights', 'switch on the coffee maker', 'turn it off', 'lights off', 'turn off everything', 'switch the bedroom fan on', 'kill the lights'],
        patterns: [
          /^(?:turn|switch|power|put|flip)\s+(on|off)\s+(?:the\s+|my\s+)?(.+)$/,
          /^(?:turn|switch|power|shut|flip)\s+(?:the\s+|my\s+)?(.+?)\s+(on|off)$/,
          /^(?:turn|switch)\s+(on|off)$/,
          /^(lights?|lamps?)\s+(on|off)(?:\s+in\s+(?:the\s+)?(.+))?$/,
          /^(?:kill|cut|shut off)\s+(?:the\s+)?(.+)$/,
          /^and\s+(?:the\s+)?(.+?)(?:\s+(?:too|as well|also))?$/,
        ],
        slots: (m, { stripped, context }) => {
          if (/^and\b/.test(stripped)) {
            const last = context?.entities?.lastPower;
            if (!last || !context?.lastIntent?.startsWith('smarthome.')) return null;
            return { ...targetSlots(m[1]), state: last };
          }
          if (/^(?:kill|cut|shut off)\b/.test(stripped)) return { ...targetSlots(m[1]), state: 'off' };
          if (/^(lights?|lamps?)\s+(on|off)/.test(stripped)) return { target: m[3] ? `${m[3]} lights` : 'lights', state: m[2] };
          if (m[2] === undefined) return { pronoun: true, state: m[1] };
          const first = m[1] === 'on' || m[1] === 'off';
          const state = first ? m[1] : m[2];
          const target = first ? m[2] : m[1];
          if (/\b(alarm|security|news|music|radio|timer|reminder|incognito|private mode|voice)\b/.test(target)) return null;
          return { ...targetSlots(target), state };
        },
        handler: async (slots, ctx) => {
          const result = await power(slots, ctx);
          if (!result.unresolved) result.track = { ...result.track, lastPower: slots.state };
          return result;
        },
      },
      {
        name: 'smarthome.status',
        examples: ['list devices', 'which lights are on', 'is the kitchen light on', 'what is the status of the front door', 'show my devices', 'what devices are on'],
        patterns: [
          /^(?:what is|show|check|get|tell me)\s+(?:me\s+)?(?:the\s+)?(?:status|state)\s+of\s+(?:the\s+|my\s+)?(.+)$/,
          /^(?:is|are)\s+(?:the\s+|my\s+)?(.+?)\s+(?:still\s+)?(?:on|off|open|closed)$/,
          /^(?:which|what)\s+(lights|devices|things)\s+are\s+(?:still\s+|currently\s+)?(on|off)$/,
          /^(?:show|list|what are)\s+(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?(?:smart\s+)?(?:home\s+)?(?:devices|smart home)$/,
          /^(?:home|house|device|devices)\s+status$/,
        ],
        slots: (m, { stripped }) => {
          if (/^(?:which|what)\s+(lights|devices|things)\s+are/.test(stripped)) return { filter: m[2], type: m[1] === 'lights' ? 'light' : undefined };
          if (/^(?:show|list|what are)\b/.test(stripped) || /status$/.test(stripped)) return {};
          const target = m[1].trim();
          if (/\b(weather|news|alarm|security)\b/.test(target)) return null;
          return targetSlots(target);
        },
        handler: status,
      },
    ],

    tools: [
      {
        name: 'smart_home_list_devices',
        description: 'List the smart home devices JARVIS can control, with their room, type and current state. Call this before controlling a device when you are unsure of its exact name, or when the user asks what is on, off, locked or what the temperature is set to.',
        input_schema: {
          type: 'object',
          properties: { room: { type: ['string', 'null'], description: 'Optional room name to filter by, e.g. "kitchen". Null for every room.' } },
          required: ['room'],
          additionalProperties: false,
        },
        run: async ({ room }, ctx) => {
          const units = ctx.profile.get('units');
          const devices = registry.all().filter((d) => !room || d.room === String(room).toLowerCase());
          return { devices: devices.map((d) => ({ name: d.name, room: d.room, type: d.type, state: describeState(d, units) })) };
        },
      },
      {
        name: 'smart_home_control',
        description: 'Control one or more smart home devices. Call this whenever the user wants to switch something on or off, dim or brighten lights, change a light color, set the thermostat, lock or unlock a door, or arm or disarm the security system. Unlocking and disarming require the user to confirm first.',
        input_schema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Device, room or group in plain words, e.g. "kitchen lights", "front door", "bedroom", "everything". Several targets may be joined with "and".' },
            action: { type: 'string', enum: ['on', 'off', 'set_brightness', 'set_color', 'set_temperature', 'lock', 'unlock', 'arm', 'disarm'] },
            value: { type: ['string', 'number', 'null'], description: 'Brightness percent (0-100), color name, temperature in degrees, or the alarm mode ("home", "away", "night"). Null when the action needs no value.' },
          },
          required: ['target', 'action', 'value'],
          additionalProperties: false,
        },
        run: async (input, ctx) => {
          const result = await controlTool(input, { ...ctx, actor: 'assistant' });
          return { result: result.text ?? result.message ?? result.error, needs_confirmation: Boolean(result.needs_confirmation) };
        },
      },
      {
        name: 'smart_home_run_scene',
        description: 'Run a predefined scene that adjusts several devices at once. Call this when the user says things like "good night", "movie time", "I\'m leaving" or asks for a mode by name.',
        input_schema: {
          type: 'object',
          properties: { scene: { type: 'string', enum: Object.keys(SCENES) } },
          required: ['scene'],
          additionalProperties: false,
        },
        run: async ({ scene: name }, ctx) => ({ result: (await scene({ scene: name }, { ...ctx, actor: 'assistant' })).text }),
      },
    ],

    routes: [
      { method: 'GET', path: '/api/devices', handler: (req, ctx) => ({ devices: registry.all().map((d) => ({ ...d, summary: describeState(d, ctx.profile.get('units')) })), scenes: Object.entries(SCENES).map(([id, s]) => ({ id, label: s.label })), adapter: registry.adapter.label }) },
      {
        method: 'POST',
        path: '/api/devices/:id/command',
        handler: async (req, ctx) => {
          const device = registry.get(req.params.id);
          if (!device) return { status: 404, body: { error: 'device not found' } };
          const { command, params } = req.body ?? {};
          if (typeof command !== 'string') return { status: 400, body: { error: 'command is required' } };
          try {
            const updated = await registry.command(device, command, params ?? {}, { actor: 'dashboard' });
            return { device: { ...updated, summary: describeState(updated, ctx.profile.get('units')) } };
          } catch (error) {
            return { status: 400, body: { error: error.message } };
          }
        },
      },
      {
        method: 'POST',
        path: '/api/scenes/:name',
        handler: async (req, ctx) => {
          if (!SCENES[req.params.name]) return { status: 404, body: { error: 'scene not found' } };
          const result = await scene({ scene: req.params.name }, { ...ctx, actor: 'dashboard' });
          return { text: result.text, devices: result.cards?.[0]?.devices ?? [] };
        },
      },
      { method: 'POST', path: '/api/devices/discover', handler: async () => registry.discover() },
    ],

    snapshot: (ctx) => {
      const units = ctx.profile.get('units');
      const devices = registry.all();
      return {
        adapter: registry.adapter.label,
        devices: devices.map((d) => ({ id: d.id, name: d.name, room: d.room, type: d.type, state: d.state, summary: describeState(d, units) })),
        scenes: Object.entries(SCENES).map(([id, s]) => ({ id, label: s.label })),
        stats: { total: devices.length, on: devices.filter((d) => d.state?.on).length, unlocked: devices.filter((d) => d.type === 'lock' && !d.state.locked).length },
      };
    },

    suggestions: (ctx) => {
      const out = [];
      const hour = ctx.now().getHours();
      const unlocked = registry.all().filter((d) => d.type === 'lock' && !d.state.locked);
      if (unlocked.length && (hour >= 21 || hour < 6)) {
        out.push({ id: 'lock-doors', text: `The ${list(unlocked.map((d) => lc(d.name)))} ${unlocked.length === 1 ? 'is' : 'are'} unlocked. Lock up?`, utterance: 'lock all the doors', score: 0.9 });
      }
      const lightsOn = registry.all().filter((d) => d.type === 'light' && d.state.on);
      if (lightsOn.length >= 3 && (hour >= 23 || hour < 5)) {
        out.push({ id: 'lights-late', text: `${lightsOn.length} lights are still on. Run the good night scene?`, utterance: 'good night', score: 0.8 });
      }
      return out;
    },
  };
}

export { SCENES };
