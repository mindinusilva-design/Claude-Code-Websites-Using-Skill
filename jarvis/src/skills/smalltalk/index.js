const JOKES = [
  "I asked the smart fridge for a joke. It said it couldn't, it was still chilling.",
  'Why did the developer go broke? Because he used up all his cache.',
  'I would tell you a UDP joke, but you might not get it.',
  "Why do programmers prefer dark mode? Because light attracts bugs.",
  'There are 10 kinds of people in the world: those who understand binary and those who don\'t.',
  "I told my thermostat a joke. It didn't laugh, but it did warm up to me.",
  'Why was the robot tired when it got home? It had a hard drive.',
  "My vacuum cleaner and I have a lot in common. We've both been gathering dust.",
];

const partOfDay = (date) => {
  const h = date.getHours();
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
};

/** Greetings, identity, help, clock and a little personality. */
export function createSmalltalkSkill() {
  let jokeIndex = Math.floor(Math.random() * JOKES.length);

  const sir = (ctx) => (ctx.profile.get('name') ? `, ${ctx.profile.get('name')}` : '');

  return {
    id: 'smalltalk',
    name: 'Conversation',
    description: 'Greetings, help, the time and date, and light conversation.',

    intents: [
      {
        name: 'smalltalk.greeting',
        examples: ['hello', 'hi jarvis', 'good morning jarvis', 'hey there', 'good evening'],
        patterns: [/^(?:hello|hi|hey|hiya|yo|greetings|howdy|hi there|hello there|hey there|good (?:afternoon|evening|day))(?:\s+jarvis)?$/, /^jarvis$/],
        priority: -1,
        handler: async (slots, ctx) => {
          const now = ctx.now();
          const extra = await ctx.kernel.suggestions(ctx.session);
          const tip = extra[0] ? ` ${extra[0].text}` : ' How can I help?';
          return { text: `Good ${partOfDay(now) === 'night' ? 'evening' : partOfDay(now)}${sir(ctx)}.${tip}` };
        },
      },
      {
        name: 'smalltalk.identity',
        examples: ['who are you', 'what are you', 'what is your name', 'introduce yourself'],
        patterns: [/^(?:who are you|what are you|what is your name|introduce yourself|are you (?:jarvis|an ai|a robot|human|real|alive)|tell me about yourself)$/],
        handler: async (slots, ctx) => ({
          text: `I'm JARVIS, your personal assistant. I manage tasks, reminders and your calendar, control your smart home, check the weather and news, look things up, and learn your preferences as we go. ${ctx.llm?.enabled ? 'For open-ended questions I think with a Claude language model.' : 'I am running on my built-in command understanding at the moment.'} Say "help" to see what I can do.`,
        }),
      },
      {
        name: 'smalltalk.help',
        examples: ['help', 'what can you do', 'what can i ask you', 'show me the commands', 'what are your skills'],
        patterns: [/^(?:help|help me|what can you do|what can i (?:ask|say|do)|what do you do|show (?:me\s+)?(?:the\s+)?(?:commands|examples)|how do i use (?:you|this)|capabilities|what are your (?:features|skills|capabilities|abilities)|commands|examples)$/],
        handler: async (slots, ctx) => {
          const skills = ctx.kernel.registry.list().filter((s) => !['smalltalk', 'feedback'].includes(s.id));
          return {
            text: `Here's what I can do: ${skills.map((s) => s.name.toLowerCase()).join(', ')}. For example, try "${skills[0]?.examples[0]}", "${skills[1]?.examples[0]}" or "${skills[2]?.examples[0]}".`,
            cards: [{ type: 'help', title: 'Things you can ask', sections: skills.map((s) => ({ name: s.name, description: s.description, examples: s.examples.slice(0, 4) })) }],
          };
        },
      },
      {
        name: 'smalltalk.time',
        examples: ['what time is it', "what's the time", 'current time', 'tell me the time'],
        patterns: [/^(?:what is the time|what time is it|time please|current time|tell me the time|the time|what is the current time|do you have the time)(?:\s+(?:right\s+)?now)?$/],
        priority: 2,
        handler: async (slots, ctx) => ({ text: `It's ${ctx.now().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.` }),
      },
      {
        name: 'smalltalk.date',
        examples: ["what's the date", 'what day is it', "what's today's date", 'what is today'],
        patterns: [/^(?:what is (?:the date|today's date|todays date|today|the day|the date today)|what day is it(?: today)?|what day of the week is it|today's date|the date)$/],
        priority: 2,
        handler: async (slots, ctx) => ({ text: `Today is ${ctx.now().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.` }),
      },
      {
        name: 'smalltalk.joke',
        examples: ['tell me a joke', 'make me laugh', 'say something funny', 'another joke'],
        patterns: [/^(?:tell me (?:a|another) joke|joke|another (?:one|joke)|make me laugh|say something funny|do you know (?:a|any) jokes?|got any jokes)$/],
        handler: async () => {
          jokeIndex = (jokeIndex + 1) % JOKES.length;
          return { text: JOKES[jokeIndex] };
        },
      },
      {
        name: 'smalltalk.mood',
        examples: ['how are you', "how's it going", 'how are you doing'],
        patterns: [/^(?:how are you(?: doing| today)?|how is it going|how do you feel|are you ok(?:ay)?|what is up|sup|how have you been)$/],
        handler: async (slots, ctx) => ({ text: `All systems are running smoothly${sir(ctx)}. What can I do for you?` }),
      },
      {
        name: 'smalltalk.thanks',
        examples: ['thanks', 'thank you jarvis', 'cheers', 'appreciate it'],
        patterns: [/^(?:thanks|thank you|thx|ty|cheers|appreciate it|much appreciated|thanks a lot|thank you so much|thank you very much|thanks so much)(?:\s+jarvis)?$/],
        handler: async (slots, ctx) => ({ text: `You're welcome${sir(ctx)}.` }),
      },
      {
        name: 'smalltalk.goodbye',
        examples: ['goodbye', 'bye', 'see you later', "that's all"],
        patterns: [/^(?:bye|goodbye|bye bye|see you(?: later| soon)?|later|that is all|that will be all|talk to you later|i am done|have a good (?:day|night|one))(?:\s+jarvis)?$/],
        handler: async (slots, ctx) => ({ text: `Goodbye${sir(ctx)}. I'll be here when you need me.` }),
      },
      {
        name: 'smalltalk.affirm',
        examples: ['yes', 'yeah', 'sure', 'okay'],
        patterns: [/^(?:yes|yeah|yep|yup|sure|ok|okay|alright|fine|sounds good|go ahead|do it)$/],
        priority: -2,
        handler: async () => ({ text: "I'm not waiting on a yes or no right now. What would you like me to do?" }),
      },
      {
        name: 'smalltalk.deny',
        examples: ['no', 'nope', 'never mind', 'cancel that'],
        patterns: [/^(?:no|nope|nah|never mind|nevermind|cancel|cancel that|forget it|stop|no thanks|no thank you)$/],
        priority: -2,
        handler: async () => ({ text: 'No problem.' }),
      },
    ],
  };
}
