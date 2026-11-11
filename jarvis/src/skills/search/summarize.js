/**
 * Extractive summarizer used when no language model is configured. Scores
 * sentences by the frequency of their content words (with a small bonus for
 * early sentences) and returns the best ones in their original order.
 */
const STOPWORDS = new Set(`a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own s said same she should so some such t than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your`.split(/\s+/));

export function splitSentences(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"'“(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function summarizeText(text, { sentences = 4 } = {}) {
  const all = splitSentences(text).filter((s) => s.length >= 40 && s.length <= 500);
  if (all.length <= sentences) return { summary: all.join(' '), keyPoints: all.slice(0, 3), method: 'extractive' };
  const freq = new Map();
  const words = (s) => s.toLowerCase().match(/[a-z][a-z'-]{2,}/g)?.filter((w) => !STOPWORDS.has(w)) ?? [];
  for (const sentence of all) for (const w of words(sentence)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const max = Math.max(...freq.values(), 1);
  const scored = all.map((sentence, index) => {
    const ws = words(sentence);
    const score = ws.reduce((acc, w) => acc + freq.get(w) / max, 0) / Math.sqrt(ws.length || 1);
    const position = index < 3 ? 1.25 : index < 8 ? 1.1 : 1;
    return { sentence, index, score: score * position };
  });
  const top = scored.slice().sort((a, b) => b.score - a.score).slice(0, sentences).sort((a, b) => a.index - b.index);
  const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  return { summary: top.map((s) => s.sentence).join(' '), keyPoints: top.slice(0, 3).map((s) => s.sentence), keywords, method: 'extractive' };
}

export function firstSentences(text, count = 2, maxChars = 420) {
  const out = [];
  let length = 0;
  for (const sentence of splitSentences(text)) {
    if (out.length >= count || length + sentence.length > maxChars) break;
    out.push(sentence);
    length += sentence.length;
  }
  return out.length ? out.join(' ') : String(text ?? '').slice(0, maxChars);
}
