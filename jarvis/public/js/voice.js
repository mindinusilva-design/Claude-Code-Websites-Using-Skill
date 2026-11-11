// JARVIS voice: speaking and listening, with two engines for each.
//
//   Speaking   cloud   -> ElevenLabs audio from /api/voice/speak (natural voice)
//              browser -> speechSynthesis (always available as a fallback)
//   Listening  browser -> Web Speech recognition (Chrome, Edge, Safari)
//              cloud   -> microphone recording, auto-stopped at the end of
//                         speech, transcribed by /api/voice/transcribe
//
// Everything degrades gracefully: if the cloud engine fails mid-session the
// browser engine takes over for that utterance.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

export class Voice {
  /**
   * @param {object} hooks
   * @param {(text: string) => void} hooks.onTranscript
   * @param {(text: string) => void} [hooks.onInterim]
   * @param {(state: string, line?: string) => void} [hooks.onState]  idle | listening | standby | transcribing | speaking
   * @param {(message: string) => void} [hooks.onError]
   * @param {(level: number) => void} [hooks.onLevel]                0..1 audio level while listening or speaking
   * @param {(text: string, voiceId: string|null) => Promise<Blob>} [hooks.fetchSpeech]
   * @param {(blob: Blob) => Promise<string>} [hooks.transcribe]
   */
  constructor(hooks) {
    this.hooks = { onInterim() {}, onState() {}, onError() {}, onLevel() {}, ...hooks };
    this.settings = { engine: 'auto', sttEngine: 'auto', voiceId: null, browserVoice: null, rate: 1 };
    this.server = { tts: false, stt: false };
    this.recognition = null;
    this.listening = false;
    this.handsFree = false;
    this.wakeWord = 'jarvis';
    this.awaitingCommand = false;
    this.speaking = false;
    this.audio = null;
    this.audioCtx = null;
    this.recorder = null;
    this.speakToken = 0;
    if (this.canBrowserSpeak) speechSynthesis.addEventListener?.('voiceschanged', () => this.hooks.onVoicesChanged?.());
  }

  // ---------------------------------------------------------------- capabilities
  get canBrowserSpeak() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }
  get canRecord() { return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder); }
  get canSpeak() { return this.canBrowserSpeak || this.server.tts; }
  get canListen() { return Boolean(Recognition) || (this.server.stt && this.canRecord); }
  get canHandsFree() { return Boolean(Recognition) && this.listenEngine === 'browser'; }

  /** Which engine will actually be used, after preferences and availability. */
  get speakEngine() {
    if (this.server.tts && this.settings.engine !== 'browser') return 'cloud';
    return this.canBrowserSpeak ? 'browser' : null;
  }
  get listenEngine() {
    const cloudOk = this.server.stt && this.canRecord;
    if (this.settings.sttEngine === 'cloud' && cloudOk) return 'cloud';
    if (Recognition && this.settings.sttEngine !== 'cloud') return 'browser';
    if (cloudOk) return 'cloud';
    return Recognition ? 'browser' : null;
  }

  configure({ server, settings } = {}) {
    if (server) this.server = { tts: Boolean(server.tts), stt: Boolean(server.stt) };
    if (settings) this.settings = { ...this.settings, ...settings };
  }

  browserVoices() {
    if (!this.canBrowserSpeak) return [];
    return speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  }

  #pickBrowserVoice() {
    const voices = this.browserVoices();
    return voices.find((v) => v.voiceURI === this.settings.browserVoice)
      ?? voices.find((v) => /en-GB/i.test(v.lang) && /daniel|george|arthur|oliver|male/i.test(v.name))
      ?? voices.find((v) => /en-GB/i.test(v.lang))
      ?? voices[0] ?? null;
  }

  #context() {
    if (!this.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.audioCtx = new Ctx();
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    return this.audioCtx;
  }

  /** Feed an analyser's loudness into onLevel until stop() is called. */
  #meter(analyser, onFrame = null) {
    const data = new Uint8Array(analyser.fftSize);
    let running = true;
    const tick = () => {
      if (!running) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, rms * 4);
      this.hooks.onLevel(level);
      onFrame?.(rms);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { running = false; this.hooks.onLevel(0); };
  }

  // ---------------------------------------------------------------- speaking
  async speak(text) {
    if (!text) return;
    this.cancelSpeech();
    const token = ++this.speakToken;
    const wasHandsFree = this.handsFree;
    if (this.speakEngine === 'cloud' && this.hooks.fetchSpeech) {
      try {
        const blob = await this.hooks.fetchSpeech(text, this.settings.voiceId);
        if (token !== this.speakToken) return; // a newer reply or a cancel arrived
        await this.#playBlob(blob, token, wasHandsFree);
        return;
      } catch (error) {
        if (token !== this.speakToken) return;
        this.hooks.onError(`Natural voice unavailable (${error.message}). Using the browser voice.`, { soft: true });
      }
    }
    this.#speakBrowser(text, wasHandsFree);
  }

  #beginSpeaking() {
    this.speaking = true;
    if (this.listening && this.recognition) this.recognition.abort(); // don't hear ourselves
    this.hooks.onState('speaking');
  }

  #endSpeaking(wasHandsFree) {
    this.speaking = false;
    this.hooks.onLevel(0);
    this.hooks.onState(this.handsFree ? 'standby' : 'idle');
    if (wasHandsFree && this.handsFree && !this.listening) this.#startBrowser();
  }

  #playBlob(blob, token, wasHandsFree) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = this.settings.rate;
      audio.preservesPitch = true;
      this.audio = audio;
      let stopMeter = null;
      const ctx = this.#context();
      if (ctx) {
        try {
          const source = ctx.createMediaElementSource(audio);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          analyser.connect(ctx.destination);
          stopMeter = this.#meter(analyser);
        } catch { /* metering is decoration only */ }
      }
      const cleanup = () => {
        stopMeter?.();
        URL.revokeObjectURL(url);
        if (this.audio === audio) this.audio = null;
      };
      audio.onplay = () => this.#beginSpeaking();
      audio.onended = () => { cleanup(); this.#endSpeaking(wasHandsFree); resolve(); };
      audio.onpause = () => { if (!audio.ended) { cleanup(); this.#endSpeaking(false); resolve(); } };
      audio.onerror = () => { cleanup(); reject(new Error('audio playback failed')); };
      audio.play().catch((error) => {
        cleanup();
        if (token === this.speakToken) reject(new Error(error.name === 'NotAllowedError' ? 'the browser blocked audio until you interact with the page' : error.message));
      });
    });
  }

  #speakBrowser(text, wasHandsFree) {
    if (!this.canBrowserSpeak) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this.settings.rate;
    utterance.pitch = 0.95;
    const voice = this.#pickBrowserVoice();
    if (voice) utterance.voice = voice;
    // Synthesis exposes no audio stream, so pulse the orb on word boundaries.
    utterance.onboundary = () => { this.hooks.onLevel(0.7); setTimeout(() => this.speaking && this.hooks.onLevel(0.25), 120); };
    utterance.onstart = () => this.#beginSpeaking();
    utterance.onend = () => this.#endSpeaking(wasHandsFree);
    utterance.onerror = () => this.#endSpeaking(wasHandsFree);
    speechSynthesis.speak(utterance);
  }

  cancelSpeech() {
    this.speakToken += 1;
    if (this.audio) { this.audio.pause(); this.audio = null; }
    if (this.canBrowserSpeak) speechSynthesis.cancel();
    if (this.speaking) { this.speaking = false; this.hooks.onLevel(0); }
  }

  // ---------------------------------------------------------------- listening
  listenOnce() {
    if (this.listening) return;
    this.cancelSpeech();
    this.handsFree = false;
    if (this.listenEngine === 'cloud') this.#startRecording();
    else if (this.listenEngine === 'browser') this.#startBrowser();
  }

  setHandsFree(on, wakeWord = 'jarvis') {
    this.wakeWord = String(wakeWord || 'jarvis').toLowerCase();
    if (on && !this.canHandsFree) {
      this.hooks.onError('Hands-free listening needs browser speech recognition (Chrome, Edge or Safari).');
      return false;
    }
    this.handsFree = on;
    this.awaitingCommand = false;
    if (on && !this.listening) this.#startBrowser();
    if (!on) this.stop();
    return true;
  }

  stop() {
    this.handsFree = false;
    this.awaitingCommand = false;
    if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
    if (this.recognition && this.listening) this.recognition.stop();
    this.listening = false;
    this.hooks.onState('idle');
  }

  #startBrowser() {
    try {
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
        if (interim) this.hooks.onInterim(interim);
      };
      recognition.onerror = (event) => {
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        this.handsFree = false;
        this.hooks.onError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Microphone access was blocked. Allow it in your browser to talk to JARVIS.'
          : `Speech recognition stopped (${event.error}).`);
      };
      recognition.onend = () => {
        this.listening = false;
        if (this.handsFree && !this.speaking) setTimeout(() => this.handsFree && !this.listening && !this.speaking && this.#startBrowser(), 300);
        else if (!this.speaking) this.hooks.onState('idle');
      };
      this.recognition = recognition;
      recognition.start();
      this.listening = true;
      this.hooks.onState(this.handsFree ? 'standby' : 'listening');
    } catch (error) {
      this.listening = false;
      this.hooks.onError(`Could not start listening (${error.message}).`);
    }
  }

  #final(text) {
    if (!text) return;
    if (!this.handsFree) { this.hooks.onTranscript(text); return; }
    const lower = text.toLowerCase();
    const index = lower.indexOf(this.wakeWord);
    if (this.awaitingCommand) {
      this.awaitingCommand = false;
      this.hooks.onTranscript(text);
    } else if (index >= 0) {
      const command = text.slice(index + this.wakeWord.length).replace(/^[\s,.!?]+/, '');
      if (command) this.hooks.onTranscript(command);
      else {
        this.awaitingCommand = true;
        this.hooks.onState('listening', 'Yes?');
        this.hooks.onWake?.();
      }
    }
  }

  /** Record until the speaker pauses, then send the clip for transcription. */
  async #startRecording() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (error) {
      this.hooks.onError(error.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser to talk to JARVIS.' : `Could not open the microphone (${error.message}).`);
      return;
    }
    const mimeType = RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    this.recorder = recorder;
    this.listening = true;
    this.hooks.onState('listening');

    // End-of-speech detection: wait for speech, then stop after a pause.
    const started = performance.now();
    let heardAt = null;
    let quietSince = null;
    let stopMeter = () => {};
    const ctx = this.#context();
    if (ctx) {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      stopMeter = this.#meter(analyser, (rms) => {
        if (recorder.state !== 'recording') return;
        const now = performance.now();
        if (rms > 0.035) { heardAt = heardAt ?? now; quietSince = null; }
        else if (heardAt) quietSince = quietSince ?? now;
        if (heardAt && quietSince && now - quietSince > 1200) recorder.stop();
        else if (!heardAt && now - started > 6000) recorder.stop();
        else if (now - started > 20000) recorder.stop();
      });
    } else {
      setTimeout(() => recorder.state === 'recording' && recorder.stop(), 8000);
    }

    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      stopMeter();
      for (const track of stream.getTracks()) track.stop();
      this.listening = false;
      this.recorder = null;
      const blob = new Blob(chunks, { type: (recorder.mimeType || mimeType || 'audio/webm').split(';')[0] });
      if (!heardAt && ctx) { this.hooks.onState('idle'); this.hooks.onError("I didn't hear anything. Try again when you're ready.", { soft: true }); return; }
      if (blob.size < 1200) { this.hooks.onState('idle'); return; }
      this.hooks.onState('transcribing');
      try {
        const text = await this.hooks.transcribe(blob);
        this.hooks.onState('idle');
        if (text) this.hooks.onTranscript(text);
        else this.hooks.onError("I couldn't make out any words. Try again?", { soft: true });
      } catch (error) {
        this.hooks.onState('idle');
        this.hooks.onError(`Transcription failed (${error.message}).`);
      }
    };
    recorder.start(250);
  }
}
