/**
 * Multinomial Naive Bayes intent classifier with Laplace smoothing over
 * unigrams + bigrams. It learns online: every confirmed interaction and every
 * correction from the feedback loop becomes a training example, so the
 * assistant's understanding of a particular user keeps improving without a
 * retraining job. Serializable so it survives restarts.
 */

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'please', 'my', 'me', 'i', 'is', 'it', 'for', 'and', 'in', 'on', 'at', 'hey', 'jarvis', 'can', 'you', 'could', 'would']);

export function tokenize(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9%°\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
  const tokens = [...words];
  for (let i = 0; i < words.length - 1; i += 1) tokens.push(`${words[i]}_${words[i + 1]}`);
  return tokens;
}

export class NaiveBayesClassifier {
  constructor(state = null) {
    this.classCounts = {};
    this.tokenCounts = {};
    this.vocab = new Set();
    this.totalDocs = 0;
    if (state) this.load(state);
  }

  train(text, label, weight = 1) {
    const tokens = tokenize(text);
    if (!tokens.length || !label) return this;
    this.classCounts[label] = (this.classCounts[label] ?? 0) + weight;
    this.totalDocs += weight;
    const counts = (this.tokenCounts[label] ??= { __total: 0 });
    for (const token of tokens) {
      counts[token] = (counts[token] ?? 0) + weight;
      counts.__total += weight;
      this.vocab.add(token);
    }
    return this;
  }

  /** Reduce the weight of a (text, label) pair after negative feedback. */
  untrain(text, label, weight = 1) {
    if (!this.tokenCounts[label]) return this;
    const tokens = tokenize(text);
    const counts = this.tokenCounts[label];
    for (const token of tokens) {
      if (counts[token]) {
        counts[token] = Math.max(0, counts[token] - weight);
        counts.__total = Math.max(0, counts.__total - weight);
      }
    }
    this.classCounts[label] = Math.max(0.1, (this.classCounts[label] ?? 0) - weight);
    return this;
  }

  predict(text, limit = 3) {
    const tokens = tokenize(text);
    const labels = Object.keys(this.classCounts);
    if (!tokens.length || !labels.length) return [];
    const vocabSize = this.vocab.size || 1;
    const scores = labels.map((label) => {
      const counts = this.tokenCounts[label] ?? { __total: 0 };
      let logProb = Math.log((this.classCounts[label] + 0.1) / (this.totalDocs + 0.1 * labels.length));
      for (const token of tokens) {
        logProb += Math.log(((counts[token] ?? 0) + 1) / (counts.__total + vocabSize));
      }
      return { label, logProb };
    });
    const max = Math.max(...scores.map((s) => s.logProb));
    const weights = scores.map((s) => ({ label: s.label, w: Math.exp(s.logProb - max) }));
    const sum = weights.reduce((acc, s) => acc + s.w, 0);
    return weights
      .map((s) => ({ intent: s.label, confidence: Number((s.w / sum).toFixed(4)), source: 'classifier' }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  toJSON() {
    return {
      classCounts: this.classCounts,
      tokenCounts: this.tokenCounts,
      vocab: [...this.vocab],
      totalDocs: this.totalDocs,
    };
  }

  load(state) {
    this.classCounts = { ...(state.classCounts ?? {}) };
    this.tokenCounts = JSON.parse(JSON.stringify(state.tokenCounts ?? {}));
    this.vocab = new Set(state.vocab ?? []);
    this.totalDocs = state.totalDocs ?? 0;
    return this;
  }

  get size() {
    return this.totalDocs;
  }
}
