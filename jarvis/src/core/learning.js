/**
 * Continuous learning + feedback loop. Every interaction can be rated; ratings
 * and corrections flow back into the classifier so the assistant adapts to the
 * user's own phrasing. Everything is explainable: the dashboard shows how many
 * samples were learned, the accuracy per intent and the recent corrections.
 */
export class LearningEngine {
  constructor({ store, classifier, rules, events, logger = console }) {
    this.store = store;
    this.classifier = classifier;
    this.rules = rules;
    this.events = events;
    this.logger = logger;
    this.feedback = store.collection('feedback');
    this.stats = store.read('learning', null) ?? { interactions: 0, selfTrained: 0, corrections: 0, byIntent: {} };
    const saved = store.read('classifier', null);
    if (saved) this.classifier.load(saved);
    this.dirty = false;
  }

  /** Called after each handled turn. High-confidence rule matches reinforce the classifier lightly. */
  recordInteraction({ utterance, intent, confidence, source }) {
    if (!intent) return;
    this.stats.interactions += 1;
    const entry = (this.stats.byIntent[intent] ??= { seen: 0, up: 0, down: 0 });
    entry.seen += 1;
    if (source === 'rules' && confidence >= 0.85) {
      this.classifier.train(utterance, intent, 0.5);
      this.stats.selfTrained += 1;
    }
    this.dirty = true;
    this.persist();
  }

  /**
   * @param {object} fb
   * @param {string} fb.utterance      the user's original text
   * @param {string} [fb.intent]       the intent JARVIS chose
   * @param {'up'|'down'} fb.rating
   * @param {string} [fb.comment]      free text, may contain "I meant ..."
   * @param {string} [fb.correctedIntent]
   */
  applyFeedback(fb) {
    const record = this.feedback.insert({
      utterance: fb.utterance ?? null,
      intent: fb.intent ?? null,
      rating: fb.rating,
      comment: fb.comment ?? null,
      correctedIntent: fb.correctedIntent ?? null,
      turnId: fb.turnId ?? null,
      sessionId: fb.sessionId ?? null,
    });
    const entry = fb.intent ? (this.stats.byIntent[fb.intent] ??= { seen: 0, up: 0, down: 0 }) : null;
    let learned = null;
    if (fb.rating === 'up' && fb.utterance && fb.intent) {
      this.classifier.train(fb.utterance, fb.intent, 1);
      if (entry) entry.up += 1;
      learned = { utterance: fb.utterance, intent: fb.intent };
    } else if (fb.rating === 'down') {
      if (entry) entry.down += 1;
      if (fb.utterance && fb.intent) this.classifier.untrain(fb.utterance, fb.intent, 1);
      let corrected = fb.correctedIntent ?? null;
      if (!corrected && fb.comment) {
        const guess = this.rules.match(fb.comment.replace(/^(no[,!]?\s*)?(i meant|i wanted|i said|i asked)\s*(to|for)?\s*/i, ''))[0];
        if (guess && guess.confidence >= 0.7) corrected = guess.intent;
      }
      if (corrected && fb.utterance) {
        this.classifier.train(fb.utterance, corrected, 2);
        this.stats.corrections += 1;
        learned = { utterance: fb.utterance, intent: corrected };
        this.feedback.update(record.id, { correctedIntent: corrected });
      }
    }
    this.dirty = true;
    this.persist();
    this.events?.publish('learning.updated', { feedbackId: record.id, learned });
    return { ...record, learned };
  }

  persist() {
    if (!this.dirty) return;
    this.store.write('classifier', this.classifier.toJSON());
    this.store.write('learning', this.stats);
    this.dirty = false;
  }

  report() {
    const all = this.feedback.all();
    const up = all.filter((f) => f.rating === 'up').length;
    const down = all.filter((f) => f.rating === 'down').length;
    const byIntent = Object.entries(this.stats.byIntent).map(([intent, s]) => ({
      intent,
      seen: s.seen,
      up: s.up,
      down: s.down,
      satisfaction: s.up + s.down ? Number((s.up / (s.up + s.down)).toFixed(2)) : null,
    })).sort((a, b) => b.seen - a.seen);
    return {
      samples: Number(this.classifier.size.toFixed(1)),
      interactions: this.stats.interactions,
      selfTrained: this.stats.selfTrained,
      corrections: this.stats.corrections,
      feedback: { total: all.length, up, down, satisfaction: up + down ? Number((up / (up + down)).toFixed(2)) : null },
      byIntent,
      recent: all.slice(-10).reverse(),
    };
  }

  reset() {
    this.feedback.clear();
    this.stats = { interactions: 0, selfTrained: 0, corrections: 0, byIntent: {} };
    this.store.delete('classifier');
    this.store.write('learning', this.stats);
  }
}
