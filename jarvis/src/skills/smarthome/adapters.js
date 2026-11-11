import { fetchJson, fetchWithTimeout } from '../../core/http.js';

/**
 * Smart home adapters share one interface:
 *   discover()                       -> Device[]
 *   execute(device, command, params) -> partial state
 *   refresh(device)                  -> partial state (optional)
 *
 * Device: { id, externalId, name, room, type, state, adapter }
 * Types:  light | switch | fan | thermostat | lock | security | speaker | blind
 */

const DEMO_DEVICES = [
  { externalId: 'light.living_room', name: 'Living room lights', room: 'living room', type: 'light', state: { on: true, brightness: 70, color: 'warm white' } },
  { externalId: 'light.kitchen', name: 'Kitchen lights', room: 'kitchen', type: 'light', state: { on: false, brightness: 100, color: 'white' } },
  { externalId: 'light.bedroom', name: 'Bedroom lamp', room: 'bedroom', type: 'light', state: { on: false, brightness: 40, color: 'warm white' } },
  { externalId: 'light.office', name: 'Office lights', room: 'office', type: 'light', state: { on: true, brightness: 90, color: 'cool white' } },
  { externalId: 'light.porch', name: 'Porch light', room: 'outside', type: 'light', state: { on: false, brightness: 100, color: 'white' } },
  { externalId: 'switch.coffee_maker', name: 'Coffee maker', room: 'kitchen', type: 'switch', state: { on: false } },
  { externalId: 'fan.bedroom', name: 'Bedroom fan', room: 'bedroom', type: 'fan', state: { on: false, level: 50 } },
  { externalId: 'climate.home', name: 'Thermostat', room: 'hallway', type: 'thermostat', state: { on: true, target: 21, current: 20.5, mode: 'heat', unit: 'C' } },
  { externalId: 'lock.front_door', name: 'Front door', room: 'entrance', type: 'lock', state: { locked: true } },
  { externalId: 'lock.back_door', name: 'Back door', room: 'kitchen', type: 'lock', state: { locked: false } },
  { externalId: 'alarm.house', name: 'Security system', room: 'house', type: 'security', state: { armed: false, mode: 'off' } },
  { externalId: 'media.living_room_tv', name: 'Living room TV', room: 'living room', type: 'speaker', state: { on: false, volume: 30 } },
  { externalId: 'cover.living_room', name: 'Living room blinds', room: 'living room', type: 'blind', state: { level: 100 } },
];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Pure state transition shared by the simulated adapter and the fallback logic. */
export function applyCommand(device, command, params = {}) {
  const state = { ...device.state };
  switch (command) {
    case 'on':
      state.on = true;
      if (device.type === 'light' && (state.brightness ?? 0) === 0) state.brightness = 100;
      break;
    case 'off':
      state.on = false;
      break;
    case 'toggle':
      state.on = !state.on;
      break;
    case 'set_brightness':
      state.brightness = clamp(Math.round(Number(params.value)), 0, 100);
      state.on = state.brightness > 0;
      break;
    case 'adjust_brightness':
      state.brightness = clamp(Math.round((state.brightness ?? 50) + Number(params.delta)), 0, 100);
      state.on = state.brightness > 0;
      break;
    case 'set_color':
      state.color = String(params.value);
      state.on = true;
      break;
    case 'set_level':
      state.level = clamp(Math.round(Number(params.value)), 0, 100);
      if (device.type === 'fan') state.on = state.level > 0;
      break;
    case 'set_temperature':
      state.target = Number(params.value);
      if (params.unit) state.unit = params.unit;
      state.on = true;
      break;
    case 'adjust_temperature':
      state.target = Number(((state.target ?? 20) + Number(params.delta)).toFixed(1));
      break;
    case 'lock':
      state.locked = true;
      break;
    case 'unlock':
      state.locked = false;
      break;
    case 'arm':
      state.armed = true;
      state.mode = params.mode ?? 'away';
      break;
    case 'disarm':
      state.armed = false;
      state.mode = 'off';
      break;
    case 'set_volume':
      state.volume = clamp(Math.round(Number(params.value)), 0, 100);
      break;
    default:
      throw new Error(`Unsupported command "${command}" for ${device.name}`);
  }
  return state;
}

export function createSimulatedAdapter({ devices = DEMO_DEVICES } = {}) {
  return {
    id: 'simulated',
    label: 'Simulated home (demo devices)',
    async discover() {
      return devices.map((d) => ({ ...d, state: { ...d.state }, adapter: 'simulated' }));
    },
    async execute(device, command, params) {
      await new Promise((r) => setTimeout(r, 20)); // mimic network latency
      return applyCommand(device, command, params);
    },
  };
}

// ---------------------------------------------------------------------------
// Home Assistant (REST API)
// ---------------------------------------------------------------------------
const HA_DOMAINS = { light: 'light', switch: 'switch', fan: 'fan', climate: 'thermostat', lock: 'lock', alarm_control_panel: 'security', media_player: 'speaker', cover: 'blind' };

export function createHomeAssistantAdapter({ url, token }) {
  if (!url || !token) throw new Error('Home Assistant adapter needs HOMEASSISTANT_URL and HOMEASSISTANT_TOKEN');
  const base = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const toDevice = (entity) => {
    const [domain] = entity.entity_id.split('.');
    const type = HA_DOMAINS[domain];
    if (!type) return null;
    const a = entity.attributes ?? {};
    const state = { on: entity.state === 'on' || entity.state === 'heat' || entity.state === 'cool' || entity.state === 'playing' };
    if (type === 'light') {
      state.brightness = a.brightness != null ? Math.round((a.brightness / 255) * 100) : state.on ? 100 : 0;
      state.color = a.color_name ?? (a.color_temp_kelvin ? `${a.color_temp_kelvin}K` : 'white');
    }
    if (type === 'thermostat') {
      state.target = a.temperature ?? null;
      state.current = a.current_temperature ?? null;
      state.mode = entity.state;
      state.unit = 'C';
      state.on = entity.state !== 'off';
    }
    if (type === 'lock') state.locked = entity.state === 'locked';
    if (type === 'security') {
      state.armed = entity.state.startsWith('armed');
      state.mode = entity.state.replace('armed_', '');
    }
    if (type === 'fan') state.level = a.percentage ?? (state.on ? 100 : 0);
    if (type === 'blind') state.level = a.current_position ?? (entity.state === 'open' ? 100 : 0);
    if (type === 'speaker') state.volume = a.volume_level != null ? Math.round(a.volume_level * 100) : null;
    return {
      externalId: entity.entity_id,
      name: a.friendly_name ?? entity.entity_id,
      room: (a.area ?? a.room ?? guessRoom(a.friendly_name ?? entity.entity_id)),
      type,
      state,
      adapter: 'homeassistant',
    };
  };

  const call = async (domain, service, data) => {
    const response = await fetchWithTimeout(`${base}/api/services/${domain}/${service}`, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!response.ok) throw new Error(`Home Assistant responded ${response.status}`);
  };

  return {
    id: 'homeassistant',
    label: `Home Assistant (${base})`,
    async discover() {
      const states = await fetchJson(`${base}/api/states`, { headers });
      return states.map(toDevice).filter(Boolean);
    },
    async refresh(device) {
      const entity = await fetchJson(`${base}/api/states/${device.externalId}`, { headers });
      return toDevice(entity)?.state ?? device.state;
    },
    async execute(device, command, params = {}) {
      const [domain] = device.externalId.split('.');
      const entity_id = device.externalId;
      const next = applyCommand(device, command, params);
      switch (command) {
        case 'on': await call(domain, domain === 'cover' ? 'open_cover' : domain === 'lock' ? 'unlock' : 'turn_on', { entity_id }); break;
        case 'off': await call(domain, domain === 'cover' ? 'close_cover' : domain === 'lock' ? 'lock' : 'turn_off', { entity_id }); break;
        case 'toggle': await call(domain, 'toggle', { entity_id }); break;
        case 'set_brightness':
        case 'adjust_brightness': await call('light', 'turn_on', { entity_id, brightness_pct: next.brightness }); break;
        case 'set_color': await call('light', 'turn_on', { entity_id, color_name: next.color.replace(/\s+/g, '') }); break;
        case 'set_level': await call(domain, domain === 'cover' ? 'set_cover_position' : 'set_percentage', domain === 'cover' ? { entity_id, position: next.level } : { entity_id, percentage: next.level }); break;
        case 'set_temperature':
        case 'adjust_temperature': await call('climate', 'set_temperature', { entity_id, temperature: next.target }); break;
        case 'lock': await call('lock', 'lock', { entity_id }); break;
        case 'unlock': await call('lock', 'unlock', { entity_id }); break;
        case 'arm': await call('alarm_control_panel', next.mode === 'home' ? 'alarm_arm_home' : next.mode === 'night' ? 'alarm_arm_night' : 'alarm_arm_away', { entity_id }); break;
        case 'disarm': await call('alarm_control_panel', 'alarm_disarm', { entity_id }); break;
        case 'set_volume': await call('media_player', 'volume_set', { entity_id, volume_level: next.volume / 100 }); break;
        default: throw new Error(`Unsupported command "${command}"`);
      }
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Philips Hue (local bridge API v1)
// ---------------------------------------------------------------------------
const HUE_COLORS = { red: 0, orange: 5000, yellow: 12750, green: 25500, cyan: 36000, teal: 33000, blue: 46920, purple: 50000, magenta: 56100, pink: 56100 };

export function createHueAdapter({ bridgeUrl, username }) {
  if (!bridgeUrl || !username) throw new Error('Hue adapter needs HUE_BRIDGE_URL and HUE_USERNAME');
  const base = `${bridgeUrl.replace(/\/$/, '')}/api/${username}`;
  const toDevice = (id, light) => ({
    externalId: id,
    name: light.name,
    room: guessRoom(light.name),
    type: 'light',
    state: { on: Boolean(light.state?.on), brightness: Math.round(((light.state?.bri ?? 254) / 254) * 100), color: light.state?.hue != null ? 'color' : 'white', reachable: light.state?.reachable !== false },
    adapter: 'hue',
  });
  return {
    id: 'hue',
    label: `Philips Hue bridge (${bridgeUrl})`,
    async discover() {
      const lights = await fetchJson(`${base}/lights`);
      return Object.entries(lights).map(([id, light]) => toDevice(id, light));
    },
    async refresh(device) {
      const light = await fetchJson(`${base}/lights/${device.externalId}`);
      return toDevice(device.externalId, light).state;
    },
    async execute(device, command, params = {}) {
      const next = applyCommand(device, command, params);
      const body = { on: next.on !== false };
      if (command === 'set_brightness' || command === 'adjust_brightness') body.bri = Math.round((next.brightness / 100) * 254);
      if (command === 'set_color') {
        const key = String(next.color).toLowerCase();
        if (key in HUE_COLORS) { body.hue = HUE_COLORS[key]; body.sat = 254; }
        else if (key.includes('warm')) body.ct = 400;
        else if (key.includes('cool')) body.ct = 200;
        else body.ct = 300;
      }
      const response = await fetchWithTimeout(`${base}/lights/${device.externalId}/state`, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
      if (!response.ok) throw new Error(`Hue bridge responded ${response.status}`);
      return next;
    },
  };
}

const ROOM_WORDS = ['living room', 'lounge', 'kitchen', 'bedroom', 'bathroom', 'office', 'study', 'hallway', 'hall', 'garage', 'garden', 'porch', 'patio', 'dining room', 'nursery', 'basement', 'attic', 'entrance', 'outside'];

export function guessRoom(name) {
  const lower = String(name ?? '').toLowerCase();
  for (const room of ROOM_WORDS) if (lower.includes(room)) return room;
  return 'home';
}

export function createAdapter(kind, config = {}) {
  switch (kind) {
    case 'homeassistant': return createHomeAssistantAdapter({ url: config.url, token: config.token });
    case 'hue': return createHueAdapter({ bridgeUrl: config.bridgeUrl, username: config.username });
    default: return createSimulatedAdapter();
  }
}
