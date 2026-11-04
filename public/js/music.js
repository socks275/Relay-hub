/* Pine — built-in generative music ("Listen" tab).
 * No audio files: every station is composed live with WebAudio, so it
 * works offline and never gets blocked. Musical stations use a lookahead
 * step scheduler; ambience stations are layered filtered noise. */

const TRACKS = {
  lofi: ["midnight homework", "rain on the library roof", "cassettes from 2009", "study break", "warm static & tea"],
  piano: ["felt & dust", "the quiet staircase", "letters unsent", "blue hour", "practice room B"],
  synth: ["neon pines", "midnight motorway", "chrome horizon", "grid runner", "afterglow '84"],
  rain: ["canopy rainfall", "window seat", "soft storm", "moss & thunder"],
  waves: ["night shore", "slow tide", "salt air", "the long exhale"],
  cafe: ["corner table", "vinyl & espresso", "afternoon slow", "paperback weather"],
};

const NOTE = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

class MusicEngine {
  constructor() {
    this.ctx = null;
    this.playing = null;        // station id
    this.nodes = [];            // everything to stop on switch
    this.timers = [];
    this.volume = 0.75;
    this.onState = null;        // (stationId, trackName) => {}
    this._trackTimer = null;
  }

  _ensureCtx() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    // Simple generated reverb shared by musical stations.
    this.verb = this.ctx.createConvolver();
    const len = this.ctx.sampleRate * 2.2;
    const impulse = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    this.verb.buffer = impulse;
    this.verbGain = this.ctx.createGain();
    this.verbGain.gain.value = 0.35;
    this.verb.connect(this.verbGain).connect(this.master);
    this.master.connect(this.analyser).connect(this.ctx.destination);
  }

  _track(node) { this.nodes.push(node); return node; }

  _noiseBuffer(seconds = 2, brown = false) {
    const len = this.ctx.sampleRate * seconds;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * white) / 1.02; d[i] = last * 3.2; }
      else d[i] = white;
    }
    return buf;
  }

  _loopNoise({ brown = false, type = "lowpass", freq = 800, q = 0.5, gain = 0.2 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(3, brown);
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    this._track(src);
    return { src, filter: f, gain: g };
  }

  _crackle(amount = 0.03) {
    const src = this.ctx.createBufferSource();
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() < 0.0012 ? (Math.random() * 2 - 1) * 0.7 : (Math.random() * 2 - 1) * 0.006;
    src.buffer = buf; src.loop = true;
    const g = this.ctx.createGain(); g.gain.value = amount;
    src.connect(g).connect(this.master);
    src.start();
    this._track(src);
  }

  _tone({ midi, at, dur, type = "sine", gain = 0.15, attack = 0.01, toVerb = true, detune = 0, filterFreq = 0 }) {
    const t = at;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = NOTE(midi);
    osc.detune.value = detune;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let head = osc;
    if (filterFreq) {
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = filterFreq;
      osc.connect(f); head = f;
    }
    head.connect(g).connect(this.master);
    if (toVerb) g.connect(this.verb);
    osc.start(t);
    osc.stop(t + dur + 0.1);
  }

  _kick(at, gain = 0.5) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.setValueAtTime(130, at);
    osc.frequency.exponentialRampToValueAtTime(42, at + 0.12);
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(g).connect(this.master);
    osc.start(at); osc.stop(at + 0.25);
  }

  _hat(at, gain = 0.06, open = false) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.2);
    const f = this.ctx.createBiquadFilter();
    f.type = "highpass"; f.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + (open ? 0.25 : 0.05));
    src.connect(f).connect(g).connect(this.master);
    src.start(at); src.stop(at + 0.3);
  }

  /* Lookahead scheduler: calls fn(step, time) for 16th notes at bpm. */
  _sequence(bpm, fn) {
    const spb = 60 / bpm / 4; // seconds per 16th
    let step = 0;
    let nextTime = this.ctx.currentTime + 0.08;
    const tick = () => {
      while (nextTime < this.ctx.currentTime + 0.45) {
        fn(step, nextTime);
        step++;
        nextTime += spb;
      }
    };
    tick();
    this.timers.push(setInterval(tick, 180));
  }

  /* ---------------- stations ---------------- */

  _stLofi() {
    // Am7 – Fmaj7 – Cmaj7 – G6, one bar each (midi roots 45,41,48,43)
    const chords = [
      [57, 60, 64, 67], [53, 57, 60, 64], [48, 55, 59, 64], [55, 59, 62, 64],
    ];
    const bass = [33, 29, 36, 31];
    this._crackle(0.5);
    this._loopNoise({ type: "lowpass", freq: 400, gain: 0.012 });
    this._sequence(72, (step, t) => {
      const bar = Math.floor(step / 16) % 4;
      const s16 = step % 16;
      if (s16 === 0) {
        for (const m of chords[bar])
          this._tone({ midi: m, at: t + Math.random() * 0.03, dur: 2.8, type: "triangle", gain: 0.055, attack: 0.4, filterFreq: 1400 });
        this._tone({ midi: bass[bar], at: t, dur: 2.6, type: "sine", gain: 0.16, attack: 0.02, toVerb: false });
      }
      if (s16 % 4 === 0) this._kick(t, 0.32);
      if (s16 === 4 || s16 === 12) this._hat(t, 0.10, true);
      if (s16 % 2 === 0 && Math.random() < 0.5) this._hat(t, 0.035);
      // Sparse smoky melody:
      if (s16 % 4 === 2 && Math.random() < 0.4) {
        const scale = [69, 72, 74, 76, 79, 81];
        const m = scale[Math.floor(Math.random() * scale.length)];
        this._tone({ midi: m, at: t + 0.02, dur: 1.1, type: "sine", gain: 0.07, attack: 0.01, filterFreq: 2200 });
        this._tone({ midi: m, at: t + 0.02, dur: 1.1, type: "triangle", gain: 0.03, attack: 0.01, filterFreq: 1200 });
      }
    });
  }

  _stPiano() {
    // D minor, slow and sparse. Lower voice walks chords, top voice wanders.
    const chords = [
      [50, 53, 57], [46, 50, 53], [48, 52, 55], [45, 48, 52],
    ];
    const top = [62, 65, 69, 72, 74, 77];
    this._sequence(48, (step, t) => {
      const bar = Math.floor(step / 16) % 4;
      const s16 = step % 16;
      const play = (m, at, dur, gain) => {
        this._tone({ midi: m, at, dur, type: "triangle", gain, attack: 0.004, filterFreq: 2600 });
        this._tone({ midi: m, at, dur: dur * 0.6, type: "sine", gain: gain * 0.6, attack: 0.004 });
      };
      if (s16 === 0) for (const m of chords[bar]) play(m, t + Math.random() * 0.05, 3.6, 0.075);
      if (s16 % 4 === 0 && Math.random() < 0.55) {
        const m = top[Math.floor(Math.random() * top.length)];
        play(m, t + Math.random() * 0.04, 2.4, 0.085);
        if (Math.random() < 0.25) play(m - 12, t + 0.28, 1.8, 0.05);
      }
    });
  }

  _stSynth() {
    // A minor synthwave: i – VI – III – VII
    const roots = [33, 29, 36, 31];           // A F C G (midi, low)
    const arpNotes = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
    this._sequence(102, (step, t) => {
      const bar = Math.floor(step / 16) % 4;
      const s16 = step % 16;
      if (s16 % 4 === 0) this._kick(t, 0.5);
      if (s16 % 4 === 2) this._hat(t, 0.05);
      // Driving 8th-note bass:
      if (s16 % 2 === 0)
        this._tone({ midi: roots[bar] + 12, at: t, dur: 0.22, type: "sawtooth", gain: 0.085, attack: 0.005, toVerb: false, filterFreq: 900 });
      // 16th arp:
      const seq = arpNotes[bar];
      const idx = [0, 1, 2, 1][s16 % 4] + (s16 >= 8 ? 0 : 0);
      this._tone({ midi: seq[idx] + (s16 % 8 >= 4 ? 12 : 0), at: t, dur: 0.16, type: "square", gain: 0.028, attack: 0.002, filterFreq: 3200 });
      // Wide pad on bar start:
      if (s16 === 0)
        for (const m of arpNotes[bar])
          this._tone({ midi: m, at: t, dur: 2.3, type: "sawtooth", gain: 0.018, attack: 0.7, filterFreq: 1500, detune: (Math.random() - 0.5) * 14 });
    });
  }

  _stRain() {
    this._loopNoise({ type: "bandpass", freq: 1800, q: 0.4, gain: 0.10 });
    this._loopNoise({ brown: true, type: "lowpass", freq: 500, gain: 0.20 });
    const patter = this._loopNoise({ type: "highpass", freq: 3500, gain: 0.025 });
    // Slowly wandering patter intensity:
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain(); lfoGain.gain.value = 0.012;
    lfo.connect(lfoGain).connect(patter.gain.gain);
    lfo.start(); this._track(lfo);
    // Occasional far-off thunder:
    const thunder = () => {
      const at = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuffer(4, true);
      const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 140;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.5, at + 0.7);
      g.gain.exponentialRampToValueAtTime(0.001, at + 3.8);
      src.connect(f).connect(g).connect(this.master);
      src.start(at); src.stop(at + 4);
      this.timers.push(setTimeout(thunder, 16000 + Math.random() * 26000));
    };
    this.timers.push(setTimeout(thunder, 7000));
  }

  _stWaves() {
    const sea = this._loopNoise({ brown: true, type: "lowpass", freq: 420, gain: 0.16 });
    // 9-second swell:
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 1 / 9;
    const gMod = this.ctx.createGain(); gMod.gain.value = 0.09;
    lfo.connect(gMod).connect(sea.gain.gain);
    const fMod = this.ctx.createGain(); fMod.gain.value = 180;
    lfo.connect(fMod).connect(sea.filter.frequency);
    lfo.start(); this._track(lfo);
    this._loopNoise({ type: "bandpass", freq: 900, q: 0.6, gain: 0.018 });
  }

  _stCafe() {
    this._crackle(0.8);
    this._loopNoise({ brown: true, type: "lowpass", freq: 320, gain: 0.05 });
    this._loopNoise({ type: "bandpass", freq: 600, q: 0.3, gain: 0.012 });
    // The odd distant cup / spoon clink:
    const clink = () => {
      const at = this.ctx.currentTime + 0.05;
      const base = 2100 + Math.random() * 1400;
      for (const [mult, g] of [[1, 0.05], [2.7, 0.02], [4.1, 0.008]]) {
        const osc = this.ctx.createOscillator();
        osc.frequency.value = base * mult;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(g, at);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
        osc.connect(gain).connect(this.master);
        osc.connect; osc.start(at); osc.stop(at + 0.45);
      }
      this.timers.push(setTimeout(clink, 5000 + Math.random() * 14000));
    };
    this.timers.push(setTimeout(clink, 2500));
  }

  /* ---------------- public API ---------------- */

  async play(id) {
    this._ensureCtx();
    await this.ctx.resume();
    if (this.playing === id) return this.stop();
    this._teardown();
    ({ lofi: this._stLofi, piano: this._stPiano, synth: this._stSynth, rain: this._stRain, waves: this._stWaves, cafe: this._stCafe })[id]?.call(this);
    this.playing = id;
    this._cycleTrack();
    this.onState?.(this.playing, this.track);
  }

  _cycleTrack() {
    clearInterval(this._trackTimer);
    const pick = () => {
      const list = TRACKS[this.playing] || ["pine fm"];
      this.track = list[Math.floor(Math.random() * list.length)];
      this.onState?.(this.playing, this.track);
    };
    pick();
    this._trackTimer = setInterval(pick, 26000);
  }

  stop() {
    this._teardown();
    this.playing = null;
    this.onState?.(null, "");
  }

  _teardown() {
    clearInterval(this._trackTimer);
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* already stopped */ }
      try { n.disconnect?.(); } catch { /* ignore */ }
    }
    this.nodes = [];
    // Scheduled one-shot tones fade on their own within ~3s.
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }
}

export const music = new MusicEngine();
