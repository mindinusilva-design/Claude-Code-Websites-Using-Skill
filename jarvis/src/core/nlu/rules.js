/**
 * Deterministic intent matcher. Skills register intents as regular-expression
 * patterns plus a slot extractor. Matching is fast, offline and explainable,
 * which makes it the first line of understanding; the statistical classifier
 * and the language model only step in when the rules are unsure.
 */

const CONTRACTIONS = [
  [/\bwhat's\b/g, 'what is'], [/\bwhats\b/g, 'what is'], [/\bhow's\b/g, 'how is'], [/\bit's\b/g, 'it is'],
  [/\bthat's\b/g, 'that is'], [/\bi'm\b/g, 'i am'], [/\bi'd\b/g, 'i would'], [/\bi'll\b/g, 'i will'],
  [/\bcan't\b/g, 'cannot'], [/\bdon't\b/g, 'do not'], [/\bwon't\b/g, 'will not'], [/\bisn't\b/g, 'is not'],
  [/\blet's\b/g, 'let us'], [/\bgimme\b/g, 'give me'], [/\bwanna\b/g, 'want to'], [/\bpls\b|\bplz\b/g, 'please'],
];

const FILLERS = /\b(hey|hi|ok|okay|yo|um|uh|please|kindly|could you|can you|would you|will you|i want you to|i need you to|i would like you to|jarvis|j\.a\.r\.v\.i\.s\.?)\b[,!]?\s*/gi;

/** Same clean-up as normalize() but keeps the user's capitalization. */
export function normalizeCased(text) {
  let t = String(text ?? '').trim();
  t = t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  for (const [re, rep] of CONTRACTIONS) t = t.replace(new RegExp(re.source, 'gi'), rep);
  t = t.replace(/[?!.]+$/g, '').replace(/\s+/g, ' ').trim();
  return t;
}

export function normalize(text) {
  return normalizeCased(text).toLowerCase();
}

export function stripFillers(text) {
  return String(text).replace(FILLERS, '').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
}

const AFFIRMATIVE = /^(?:yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|go ahead|go for it|please do|yes please|affirmative|absolutely|correct|that is right|right|proceed)(?:\s+(?:please|jarvis|do it|go ahead))*$/i;
const NEGATIVE = /^(?:no|nope|nah|cancel|never mind|nevermind|stop|do not|don't|negative|abort|forget it|no thanks|no thank you)(?:\s+(?:please|jarvis|thanks|thank you))*$/i;

export function isAffirmative(text) {
  return AFFIRMATIVE.test(normalize(text));
}

export function isNegative(text) {
  return NEGATIVE.test(normalize(text));
}

export class RuleEngine {
  constructor() {
    this.rules = [];
  }

  /**
   * @param {object} rule
   * @param {string} rule.intent        dotted intent name, e.g. "smarthome.power"
   * @param {RegExp[]} rule.patterns    tested against the normalized utterance
   * @param {Function} [rule.slots]     (match, { text, normalized, stripped, cased, context }) -> slots | null (null rejects)
   * @param {number} [rule.priority]    tie-breaker, higher wins
   * @param {string[]} [rule.examples]  training utterances for the classifier
   */
  add(rule) {
    if (!rule?.intent || !Array.isArray(rule.patterns)) throw new Error('RuleEngine.add: intent and patterns are required');
    this.rules.push({ priority: 0, examples: [], ...rule });
    return this;
  }

  intents() {
    return [...new Set(this.rules.map((r) => r.intent))];
  }

  examples() {
    const out = [];
    for (const rule of this.rules) for (const example of rule.examples) out.push({ text: example, intent: rule.intent });
    return out;
  }

  /** Match one utterance. Returns candidates sorted by confidence. */
  match(text, context = {}) {
    const normalized = normalize(text);
    const stripped = stripFillers(normalized);
    const casedText = normalizeCased(text);
    const casedTarget = stripFillers(casedText) || casedText;
    const candidates = [];
    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        const re = new RegExp(pattern.source, pattern.flags.includes('i') ? pattern.flags : `${pattern.flags}i`);
        const target = stripped || normalized;
        const m = re.exec(target);
        if (!m) continue;
        let slots = {};
        if (rule.slots) {
          // `cased` is the same match against the case-preserved text, for names and titles.
          slots = rule.slots(m, { text, normalized, stripped: target, context, cased: re.exec(casedTarget) ?? m });
          if (slots == null) continue;
        }
        const coverage = target.length ? m[0].length / target.length : 0;
        const anchored = (m.index === 0 ? 0.05 : 0) + (m.index + m[0].length === target.length ? 0.05 : 0);
        const confidence = Math.min(0.99, 0.55 + coverage * 0.35 + anchored + rule.priority * 0.01);
        candidates.push({ intent: rule.intent, slots, confidence: Number(confidence.toFixed(3)), matched: m[0], source: 'rules' });
        break;
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates;
  }

  /**
   * Split "do X and then do Y" into independent commands. Only splits when
   * every segment parses on its own, otherwise the utterance stays whole.
   */
  matchCompound(text, context = {}, { threshold = 0.72 } = {}) {
    const normalized = normalize(text);
    const strongSplit = normalized.split(/\s*(?:,\s*)?(?:\band then\b|\bthen\b|\band also\b|\bafter that\b|;)\s*/i).map((s) => s.trim()).filter(Boolean);
    const tryParts = (parts) => {
      if (parts.length < 2) return null;
      const results = parts.map((part) => this.match(part, context)[0]);
      if (results.every((r) => r && r.confidence >= threshold)) return results.map((r, i) => ({ ...r, segment: parts[i] }));
      return null;
    };
    let result = tryParts(strongSplit);
    if (result) return result;
    const weakSplit = normalized.split(/\s*,?\s*\band\b\s+(?=(?:also\s+)?(?:turn|switch|set|dim|lock|unlock|arm|disarm|remind|add|create|schedule|book|show|tell|what|search|look|play|open|close|start|stop|check|read|give|find)\b)/i).map((s) => s.trim()).filter(Boolean);
    result = tryParts(weakSplit);
    if (result) return result;
    const single = this.match(text, context)[0];
    return single ? [{ ...single, segment: normalized }] : [];
  }
}
