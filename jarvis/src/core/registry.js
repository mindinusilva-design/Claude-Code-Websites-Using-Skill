/**
 * Skill registry: the plugin contract that ties the framework together.
 *
 * A skill is a plain object:
 *   {
 *     id, name, description,
 *     setup(ctx)?,                   // called once with the kernel context
 *     intents: [{ name, patterns, slots?, examples?, priority?, handler }],
 *     tools:   [{ name, description, input_schema, run(input, ctx) }],   // exposed to the language model
 *     routes:  [{ method, path, handler(req, ctx) }],                    // REST endpoints
 *     snapshot(ctx)?,                // data for the dashboard
 *     suggestions(ctx)?              // contextual suggestions (e.g. overdue tasks)
 *   }
 *
 * One definition feeds the rule engine, the classifier seed set, the
 * language-model tool list, the HTTP API and the dashboard, so a new
 * capability is added in exactly one place.
 */
export class SkillRegistry {
  constructor({ rules }) {
    this.rules = rules;
    this.skills = new Map();
    this.handlers = new Map();
    this.toolList = [];
    this.routeList = [];
  }

  register(skill, ctx) {
    if (!skill?.id) throw new Error('SkillRegistry.register: skill.id is required');
    if (this.skills.has(skill.id)) throw new Error(`SkillRegistry.register: duplicate skill "${skill.id}"`);
    for (const intent of skill.intents ?? []) {
      const name = intent.name.includes('.') ? intent.name : `${skill.id}.${intent.name}`;
      if (typeof intent.handler !== 'function') throw new Error(`Intent ${name} has no handler`);
      this.rules.add({ intent: name, patterns: intent.patterns, slots: intent.slots, priority: intent.priority ?? 0, examples: intent.examples ?? [] });
      this.handlers.set(name, { skill, intent: { ...intent, name } });
    }
    for (const tool of skill.tools ?? []) {
      if (this.toolList.some((t) => t.name === tool.name)) throw new Error(`Duplicate tool "${tool.name}"`);
      this.toolList.push({ ...tool, skillId: skill.id });
    }
    for (const route of skill.routes ?? []) this.routeList.push({ ...route, skillId: skill.id });
    this.skills.set(skill.id, skill);
    return Promise.resolve(skill.setup?.(ctx));
  }

  has(intent) {
    return this.handlers.has(intent);
  }

  describe(intent) {
    return this.handlers.get(intent)?.intent ?? null;
  }

  async dispatch(intent, slots, ctx) {
    const entry = this.handlers.get(intent);
    if (!entry) throw new Error(`No handler for intent "${intent}"`);
    const result = await entry.intent.handler(slots ?? {}, ctx);
    return typeof result === 'string' ? { text: result } : result;
  }

  /** Tools in the shape the language model expects, bound to the kernel context. */
  tools(ctx) {
    return this.toolList.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      run: (input) => tool.run(input, ctx),
    }));
  }

  routes() {
    return this.routeList;
  }

  async snapshot(ctx) {
    const out = {};
    for (const [id, skill] of this.skills) {
      if (!skill.snapshot) continue;
      try {
        out[id] = await skill.snapshot(ctx);
      } catch (error) {
        out[id] = { error: error.message };
      }
    }
    return out;
  }

  async suggestions(ctx) {
    const out = [];
    for (const skill of this.skills.values()) {
      if (!skill.suggestions) continue;
      try {
        out.push(...(await skill.suggestions(ctx)));
      } catch { /* a skill's suggestion failure never breaks the turn */ }
    }
    return out;
  }

  list() {
    return [...this.skills.values()].map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      intents: (skill.intents ?? []).map((i) => (i.name.includes('.') ? i.name : `${skill.id}.${i.name}`)),
      tools: (skill.tools ?? []).map((t) => t.name),
      examples: (skill.intents ?? []).flatMap((i) => i.examples ?? []).slice(0, 6),
    }));
  }
}
