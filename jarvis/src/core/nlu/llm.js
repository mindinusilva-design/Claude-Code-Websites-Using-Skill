import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Minimal JSON-schema check so a tool never runs on malformed input. */
export function validateInput(schema, input) {
  if (!schema || schema.type !== 'object') return null;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const key of schema.required ?? []) {
    if (!(key in input)) return `missing required field "${key}"`;
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = schema.properties?.[key];
    if (!prop) {
      if (schema.additionalProperties === false) return `unexpected field "${key}"`;
      continue;
    }
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok = types.some((t) => (t === 'integer' ? Number.isInteger(value) : t === actual));
    if (!ok) return `field "${key}" should be ${types.join(' or ')}`;
    if (prop.enum && value !== null && !prop.enum.includes(value)) return `field "${key}" must be one of ${prop.enum.join(', ')}`;
  }
  return null;
}

function classifyError(error) {
  if (error instanceof Anthropic.AuthenticationError) return { error: 'auth', message: 'The Anthropic API key was rejected.' };
  if (error instanceof Anthropic.RateLimitError) return { error: 'rate_limit', message: 'The language model is rate limited right now.' };
  if (error instanceof Anthropic.APIConnectionError) return { error: 'network', message: 'Could not reach the language model.' };
  if (error instanceof Anthropic.APIError) return { error: 'api', status: error.status, message: error.message };
  return { error: 'unknown', message: error?.message ?? String(error) };
}

/**
 * Claude-backed language layer. Open-ended conversation, complex multi-step
 * requests and summarization go through here; the rule engine handles the
 * fast path. When no API key is configured `enabled` is false and JARVIS
 * degrades gracefully to rules + classifier.
 */
export function createLanguageModel({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.JARVIS_LLM_MODEL || DEFAULT_MODEL,
  effort = process.env.JARVIS_LLM_EFFORT || 'low',
  maxTokens = 16000,
  client = null,
  logger = console,
} = {}) {
  if (!apiKey && !client) {
    return { enabled: false, model: null, reason: 'ANTHROPIC_API_KEY is not set' };
  }
  const anthropic = client ?? new Anthropic({ apiKey });

  function toRunnable(tools, calls) {
    return tools.map((tool) =>
      betaTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
        strict: true,
        run: async (input) => {
          const problem = validateInput(tool.input_schema, input);
          if (problem) return JSON.stringify({ error: `invalid input: ${problem}` });
          const result = await tool.run(input);
          calls.push({ name: tool.name, input, result });
          return typeof result === 'string' ? result : JSON.stringify(result ?? null);
        },
      }),
    );
  }

  return {
    enabled: true,
    model,
    effort,

    /**
     * One conversational turn with tool access.
     * @returns {{text:string, calls:Array, usage?:object, model?:string, refused?:boolean, error?:string}}
     */
    async converse({ system, context = '', history = [], message, tools = [] }) {
      const calls = [];
      try {
        const runner = anthropic.beta.messages.toolRunner({
          model,
          max_tokens: maxTokens,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort },
          system: [
            { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
            ...(context ? [{ type: 'text', text: context }] : []),
          ],
          tools: toRunnable(tools, calls),
          messages: [...history, { role: 'user', content: message }],
          max_iterations: 8,
        });
        const final = await runner.runUntilDone();
        if (final.stop_reason === 'refusal') {
          return { refused: true, category: final.stop_details?.category ?? null, text: '', calls };
        }
        const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        return { text, calls, usage: final.usage, model: final.model, stopReason: final.stop_reason };
      } catch (error) {
        const info = classifyError(error);
        logger.warn?.(`[jarvis] language model error (${info.error}): ${info.message}`);
        return { text: '', calls, ...info };
      }
    },

    /** One-shot text generation (drafting posts, rewriting). */
    async complete({ system, prompt, maxTokens = 4000 }) {
      try {
        const response = await anthropic.beta.messages.create({
          model,
          max_tokens: maxTokens,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort: 'low' },
          system,
          messages: [{ role: 'user', content: prompt }],
        });
        if (response.stop_reason === 'refusal') return { refused: true, category: response.stop_details?.category ?? null, text: '' };
        const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        return { text, usage: response.usage, model: response.model };
      } catch (error) {
        const info = classifyError(error);
        logger.warn?.(`[jarvis] completion error (${info.error}): ${info.message}`);
        return { text: '', ...info };
      }
    },

    /** Answer a factual question strictly from retrieved sources. */
    async answer({ question, sources }) {
      const material = sources.map((s, i) => `<source index="${i + 1}" title="${s.title}" origin="${s.source}">\n${String(s.text).slice(0, 4000)}\n</source>`).join('\n\n');
      try {
        const response = await anthropic.beta.messages.create({
          model,
          max_tokens: 4000,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort: 'low' },
          system: 'You are JARVIS, a concise assistant. Answer the question using only the supplied sources. Reply in one to three plain sentences suitable for reading aloud, without markdown. If the sources do not contain the answer, say so briefly.',
          messages: [{ role: 'user', content: `${material}\n\nQuestion: ${question}` }],
        });
        if (response.stop_reason === 'refusal') return { refused: true, category: response.stop_details?.category ?? null, text: '' };
        const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        return { text, usage: response.usage, model: response.model };
      } catch (error) {
        const info = classifyError(error);
        logger.warn?.(`[jarvis] answer error (${info.error}): ${info.message}`);
        return { text: '', ...info };
      }
    },

    /** Faithful summary of an article or page. */
    async summarize({ text, title = '', url = '', sentences = 4 }) {
      const MAX_CHARS = 120_000;
      const truncated = text.length > MAX_CHARS;
      const body = truncated ? text.slice(0, MAX_CHARS) : text;
      try {
        const response = await anthropic.beta.messages.create({
          model,
          max_tokens: 4000,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort: 'low' },
          system: 'You are JARVIS, a precise assistant. Summarize the supplied article faithfully. Never invent facts that are not in the text. Answer in plain prose, then a short bullet list of key points.',
          messages: [
            {
              role: 'user',
              content: `Title: ${title || 'unknown'}\nSource: ${url || 'unknown'}\n\n<article>\n${body}\n</article>\n\nSummarize this in about ${sentences} sentences, then list up to 4 key points.`,
            },
          ],
        });
        if (response.stop_reason === 'refusal') return { refused: true, category: response.stop_details?.category ?? null, text: '' };
        const summary = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        return { text: summary, truncated, usage: response.usage, model: response.model };
      } catch (error) {
        const info = classifyError(error);
        logger.warn?.(`[jarvis] summarize error (${info.error}): ${info.message}`);
        return { text: '', ...info };
      }
    },
  };
}
