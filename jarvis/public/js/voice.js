// Voice in and out using the browser's Web Speech API. Recognition and
// synthesis are both optional: the app works fully by text without them.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

export class Voice {
  constructor({ onTranscript, onInterim, onState, onError }) {
    this.onTranscript = onTranscript;
    this.onInterim = onInterim ?? (() => {});
    this.onState = onState ?? (() => {});
    this.onError = onError ?? (() => {});
    this.recognition = null;
    this.listening = false;
    this.handsFree = false;
    this.wakeWord = 'jarvis';
    this.awaitingCommand = false;
    this.speaking = false;
    this.rate = 1;
    this.preferredVoice = null;
    if (this.canSpeak) {
      const pick = () => {
        const voices = speechSynthesis.getVoices();
        this.preferredVoice = voices.find((v) => /en-GB/i.test(v.lang) && /male|daniel|george|arthur|oliver/i.test(v.name))
          ?? voices.find((v) => /en-GB/i.test(v.lang))
          ?? voices.find((v) => /^en/i.test(v.lang))
          ?? null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  get canListen() { return Boolean(Recognition); }
  get canSpeak() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }

  #build() {
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = this.handsFree;
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (result.isFinal) this.#final(text);
        else interim += text;
      }
      if (interim) this.onInterim(interim);
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      this.handsFree = false;
      this.onError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Microphone access was blocked. Allow it in your browser to talk to JARVIS.'
        : `Speech recognition stopped (${event.error}).`);
    };
    recognition.onend = () => {
      this.listening = false;
      if (this.handsFree && !this.speaking) {
        setTimeout(() => this.handsFree && !this.listening && !this.speaking && this.#start(), 300);
      } else if (!this.speaking) {
        this.onState('idle');
      }
    };
    return recognition;
  }

  #final(text) {
    if (!text) return;
    if (!this.handsFree) {
      this.onTranscript(text);
      return;
    }
    // Hands-free: only act on speech that starts with (or follows) the wake word.
    const lower = text.toLowerCase();
    const index = lower.indexOf(this.wakeWord);
    if (this.awaitingCommand) {
      this.awaitingCommand = false;
      this.onTranscript(text);
    } else if (index >= 0) {
      const command = text.slice(index + this.wakeWord.length).replace(/^[\s,.!?]+/, '');
      if (command) this.onTranscript(command);
      else {
        this.awaitingCommand = true;
        this.onState('listening', 'Yes?');
      }
    }
  }

  #start() {
    try {
      this.recognition = this.#build();
      this.recognition.start();
      this.listening = true;
      this.onState(this.handsFree ? 'standby' : 'listening');
    } catch (error) {
      this.listening = false;
      this.onError(`Could not start listening (${error.message}).`);
    }
  }

  listenOnce() {
    if (!this.canListen || this.listening) return;
    this.cancelSpeech();
    this.handsFree = false;
    this.#start();
  }

  setHandsFree(on, wakeWord = 'jarvis') {
    if (!this.canListen) return;
    this.wakeWord = String(wakeWord || 'jarvis').toLowerCase();
    this.handsFree = on;
    this.awaitingCommand = false;
    if (on && !this.listening) this.#start();
    if (!on) this.stop();
  }

  stop() {
    this.handsFree = false;
    this.awaitingCommand = false;
    if (this.recognition && this.listening) this.recognition.stop();
    this.listening = false;
    this.onState('idle');
  }

  speak(text) {
    if (!this.canSpeak || !text) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this.rate;
    utterance.pitch = 0.950;
    if (this.preferredVoice) utterance.voice = this.preferredVoice;
    const wasHandsFree = this.handsFree;
    utterance.onstart = () => {
      this.speaking = true;
      // Pause recognition so JARVIS does not hear itself.
      if (this.listening) this.recognition.abort();
      this.onState('speaking');
    };
    const done = () => {
      this.speaking = false;
      this.onState('idle');
      if (wasHandsFree && this.handsFree && !this.listening) this.#start();
    };
    utterance.onend = done;
    utterance.onerror = done;
    speechSynthesis.speak(utterance);
  }

  cancelSpeech() {
    if (this.canSpeak) speechSynthesis.cancel();
    this.speaking = false;
  }
}
