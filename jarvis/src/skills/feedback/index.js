/**
 * Conversational feedback: "that's wrong", "no, I meant ...", "good job".
 * Ratings go to the learning engine; a correction is both learned from and
 * executed straight away, so the user never has to repeat themselves twice.
 */
export function createFeedbackSkill() {
  async function negative(slots, ctx) {
    const last = ctx.session?.lastExchange;
    if (!last) return { text: "Sorry about that. Tell me what you'd like and I'll try again." };
    const correction = slots.correction?.trim();
    const record = ctx.kernel.feedback({ turnId: last.turnId, utterance: last.utterance, intent: last.intent, rating: 'down', comment: correction ?? slots.comment ?? null, sessionId: ctx.session.sessionId });
    if (correction) {
      const retry = await ctx.kernel.handle({ text: correction, sessionId: ctx.session.sessionId, channel: ctx.channel, replay: true });
      const learned = record.learned ? ` I'll remember that "${last.utterance}" means this.` : '';
      return { ...retry.reply, text: `Sorry about that. ${retry.reply.text}${learned}`, replayed: retry };
    }
    return { text: "Sorry about that. I've noted it so I can do better. What did you mean? You can say \"I meant ...\" and I'll learn from it.", pending: { intent: 'feedback.negative', slots: {}, slot: 'correction' } };
  }

  async function positive(slots, ctx) {
    const last = ctx.session?.lastExchange;
    if (last) ctx.kernel.feedback({ turnId: last.turnId, utterance: last.utterance, intent: last.intent, rating: 'up', sessionId: ctx.session.sessionId });
    return { text: 'Glad that helped. Thanks for letting me know.' };
  }

  return {
    id: 'feedback',
    name: 'Feedback',
    description: 'Lets you rate answers and correct misunderstandings in plain language; corrections retrain the intent classifier.',

    intents: [
      {
        name: 'feedback.negative',
        priority: 6,
        examples: ["that's wrong", "that's not what i meant", 'no, i meant turn on the kitchen lights', 'you misunderstood me', 'bad answer'],
        patterns: [
          /^(?:no[,.!]?\s+)?(?:i meant|i actually meant|what i meant was|i said|i asked for|i wanted(?: you to)?|i was asking(?: for| about)?)\s+(.+)$/,
          /^(?:that is|that was|this is|you are|you were)\s+(?:wrong|incorrect|not right|not correct|not it|not what i (?:meant|asked|wanted|said)|not helpful|useless)$/,
          /^(?:wrong|incorrect|bad answer|bad job|bad bot|not helpful|that did not help|that does not help|you got (?:that|it) wrong|you misunderstood(?: me)?|not what i (?:meant|asked|wanted|said)|wrong answer|try again)$/,
        ],
        slots: (m, { stripped }) => (/^(?:no[,.!]?\s+)?(?:i meant|i actually meant|what i meant was|i said|i asked for|i wanted|i was asking)/.test(stripped) ? { correction: m[1] } : {}),
        handler: negative,
      },
      {
        name: 'feedback.positive',
        priority: 6,
        examples: ["that's right", 'good job', 'perfect', 'well done', 'exactly what i wanted'],
        patterns: [
          /^(?:that is|that was|this is)\s+(?:right|correct|perfect|great|helpful|exactly right|spot on|what i (?:meant|wanted|needed)|exactly what i (?:meant|wanted|needed)|awesome|brilliant)$/,
          /^(?:good job|well done|nice work|great job|perfect|exactly|spot on|nice one|good bot|great|awesome|brilliant|excellent|you are (?:great|awesome|the best|amazing|brilliant)|exactly what i (?:meant|wanted|needed))$/,
        ],
        handler: positive,
      },
    ],
  };
}
