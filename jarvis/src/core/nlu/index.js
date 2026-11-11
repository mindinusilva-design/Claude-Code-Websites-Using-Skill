import { RuleEngine, normalize, isAffirmative, isNegative } from './rules.js';
import { NaiveBayesClassifier } from './classifier.js';

/**
 * Hybrid natural-language understanding.
 *
 *   1. Rules       - deterministic patterns from every skill (fast, offline).
 *   2. Learned     - phrases the user corrected ("no, I meant ...") become aliases,
 *                    and a Naive Bayes classifier generalizes from all feedback.
 *   3. Language    - Claude, for open-ended requests and anything the first two
 *                    layers are unsure about (handled by the kernel).
 *
 * `understand()` returns ranked intents with slots plus a confidence and the
 * layer that produced the answer, so every decision is explainable.
 */
export class NLU {
  constructor({ rules = new RuleEngine(), classifier = new NaiveBayesClassifier(), threshold = 0.72, classifierThreshold = 0.8, aliasFor = null } = {}) {
    this.rules = rules;
    this.classifier = classifier;
    this.aliasFor = aliasFor; // (normalized utterance) -> canonical command learned from a correction
    this.threshold = threshold;
    this.classifierThreshold = classifierThreshold;
  }

  /** Seed the classifier with the example utterances each skill declares. */
  seed() {
    if (this.classifier.size > 0) return this;
    for (const { text, intent } of this.rules.examples()) this.classifier.train(text, intent);
    return this;
  }

  understand(text, context = null) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return { intents: [], confidence: 0, source: 'none', normalized: '' };
    const normalized = normalize(trimmed);

    // An answer to a pending question: a yes/no confirmation, or a missing
    // detail ("When should I remind you?" -> "tomorrow at 9").
    if (context?.pending) {
      const pending = context.pending;
      const yesNo = isAffirmative(trimmed) || isNegative(trimmed);
      const answer = (value) => ({
        intents: [{ intent: pending.intent, slots: { ...pending.slots, [pending.slot]: value }, confidence: 0.95, source: 'clarification' }],
        confidence: 0.95,
        source: 'clarification',
        normalized,
      });
      if (pending.slot === 'confirm') {
        if (yesNo) return answer(isAffirmative(trimmed) ? 'yes' : 'no');
      } else if (!yesNo && normalized.split(' ').length <= 8) {
        const direct = this.rules.match(trimmed, context)[0];
        if (!direct || direct.confidence < 0.9) return answer(trimmed.replace(/^(the|in the|to)\s+/i, ''));
      }
    }

    // A phrase the user has corrected before maps straight to what they meant.
    const alias = this.aliasFor?.(normalized);
    if (alias) {
      const learned = this.rules.matchCompound(alias, context);
      if (learned.length && Math.min(...learned.map((c) => c.confidence)) >= this.threshold) {
        return { intents: learned.map((c) => ({ ...c, source: 'learned' })), confidence: Math.min(...learned.map((c) => c.confidence)), source: 'learned', normalized, alias };
      }
    }

    const compound = this.rules.matchCompound(trimmed, context);
    if (compound.length > 1) {
      const confidence = Math.min(...compound.map((c) => c.confidence));
      return { intents: compound, confidence, source: 'rules', compound: true, normalized };
    }
    const best = compound[0];
    if (best && best.confidence >= this.threshold) {
      return { intents: [best], confidence: best.confidence, source: 'rules', normalized };
    }

    const predicted = this.classifier.predict(trimmed)[0];
    if (predicted && predicted.confidence >= this.classifierThreshold && this.classifier.size >= 5) {
      const slots = best?.intent === predicted.intent ? best.slots : {};
      return {
        intents: [{ intent: predicted.intent, slots, confidence: predicted.confidence, source: 'classifier' }],
        confidence: predicted.confidence,
        source: 'classifier',
        normalized,
        alternatives: best ? [best] : [],
      };
    }

    if (best) return { intents: [best], confidence: best.confidence, source: 'rules', weak: true, normalized, alternatives: predicted ? [predicted] : [] };
    return { intents: [], confidence: 0, source: 'none', normalized, alternatives: predicted ? [predicted] : [] };
  }
}

export { RuleEngine, NaiveBayesClassifier, normalize, isAffirmative, isNegative };
