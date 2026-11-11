import { RuleEngine, normalize } from './rules.js';
import { NaiveBayesClassifier } from './classifier.js';

/**
 * Hybrid natural-language understanding.
 *
 *   1. Rules       - deterministic patterns from every skill (fast, offline).
 *   2. Classifier  - Naive Bayes that learns this user's phrasings from feedback.
 *   3. Language    - Claude, for open-ended requests and anything the first two
 *                    layers are unsure about (handled by the kernel).
 *
 * `understand()` returns ranked intents with slots plus a confidence and the
 * layer that produced the answer, so every decision is explainable.
 */
export class NLU {
  constructor({ rules = new RuleEngine(), classifier = new NaiveBayesClassifier(), threshold = 0.72, classifierThreshold = 0.8 } = {}) {
    this.rules = rules;
    this.classifier = classifier;
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

    // An answer to a pending clarification question ("Which room?" -> "the kitchen").
    if (context?.pending && normalized.split(' ').length <= 6) {
      const pending = context.pending;
      const direct = this.rules.match(trimmed, context)[0];
      if (!direct || direct.confidence < 0.9) {
        return {
          intents: [{ intent: pending.intent, slots: { ...pending.slots, [pending.slot]: trimmed.replace(/^(the|in the|to)\s+/i, '') }, confidence: 0.9, source: 'clarification' }],
          confidence: 0.9,
          source: 'clarification',
          normalized,
        };
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

export { RuleEngine, NaiveBayesClassifier, normalize };
