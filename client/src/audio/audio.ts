// Every sound is synthesised at load with OfflineAudioContext and kept as an AudioBuffer.
// Nothing is downloaded. The mixer has master/music/sfx gains, a 16-voice pool that steals
// the oldest voice, and stereo panning + distance attenuation for world sounds.

type SoundName =
  | 'pistol' | 'ar' | 'smg' | 'rail' | 'shotgun' | 'sniper' | 'reload' | 'empty' | 'jet' | 'boom' | 'knife'
  | 'hit' | 'hurt' | 'death' | 'pickup' | 'click' | 'beep' | 'alarm' | 'sting' | 'music' | 'musicFrenzy';

const SR = 44100;
const MAX_VOICES = 16;
const VOL_KEY = 'tl:volumes';

/** Render `seconds` of audio with a graph built by `build`. */
async function render(seconds: number, build: (ctx: OfflineAudioContext) => void, rate = SR): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * rate), rate);
  build(ctx);
  return ctx.startRendering();
}

const noiseCache = new Map<number, AudioBuffer>();
function noise(ctx: BaseAudioContext, seconds: number): AudioBufferSourceNode {
  const key = ctx.sampleRate * 1000 + Math.round(seconds * 100);
  let buf = noiseCache.get(key);
  if (!buf || buf.sampleRate !== ctx.sampleRate) {
    buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 1234567;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    noiseCache.set(key, buf);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

/** Gain node with an attack/exponential-decay envelope. */
function env(ctx: BaseAudioContext, t0: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  return g;
}

function tone(ctx: BaseAudioContext, type: OscillatorType, f0: number, f1: number, t0: number, dur: number, peak: number, dest: AudioNode) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const g = env(ctx, t0, peak, 0.004, dur);
  o.connect(g).connect(dest);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

/** Filtered noise burst. */
function burst(ctx: BaseAudioContext, t0: number, dur: number, peak: number, type: BiquadFilterType, f0: number, f1: number, dest: AudioNode, q = 0.7) {
  const n = noise(ctx, Math.max(0.1, dur + 0.05));
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  const g = env(ctx, t0, peak, 0.002, dur);
  n.connect(f).connect(g).connect(dest);
  n.start(t0);
  n.stop(t0 + dur + 0.05);
}

const RECIPES: Record<Exclude<SoundName, 'music' | 'musicFrenzy'>, [number, (c: OfflineAudioContext) => void]> = {
  pistol: [0.14, (c) => { burst(c, 0, 0.12, 0.9, 'lowpass', 5000, 1200, c.destination); tone(c, 'square', 2200, 900, 0, 0.012, 0.3, c.destination); }],
  ar: [0.09, (c) => { burst(c, 0, 0.07, 0.85, 'lowpass', 6000, 1500, c.destination); tone(c, 'square', 2600, 1200, 0, 0.01, 0.25, c.destination); }],
  // Tighter and higher than the AR: a rapid tick that stays readable at 14 shots a second.
  smg: [0.07, (c) => { burst(c, 0, 0.05, 0.7, 'lowpass', 7500, 2000, c.destination); tone(c, 'square', 3200, 1500, 0, 0.008, 0.18, c.destination); }],
  // A charged crack with a falling whine, unmistakable across the map.
  rail: [0.9, (c) => { tone(c, 'sawtooth', 2400, 160, 0, 0.5, 0.35, c.destination); burst(c, 0, 0.05, 1, 'highpass', 4000, 2500, c.destination); burst(c, 0.02, 0.8, 0.5, 'lowpass', 3000, 180, c.destination); tone(c, 'sine', 90, 40, 0, 0.4, 0.8, c.destination); }],
  shotgun: [0.34, (c) => { burst(c, 0, 0.3, 1, 'lowpass', 3500, 500, c.destination, 0.5); tone(c, 'sine', 90, 40, 0, 0.25, 0.9, c.destination); }],
  sniper: [0.75, (c) => { burst(c, 0, 0.03, 1, 'highpass', 3000, 2000, c.destination); burst(c, 0.01, 0.7, 0.6, 'lowpass', 2500, 200, c.destination); tone(c, 'sine', 120, 50, 0, 0.3, 0.7, c.destination); }],
  reload: [0.32, (c) => { tone(c, 'square', 3200, 2400, 0, 0.03, 0.25, c.destination); burst(c, 0, 0.04, 0.4, 'bandpass', 4000, 3000, c.destination, 4); tone(c, 'square', 2600, 2000, 0.2, 0.04, 0.3, c.destination); burst(c, 0.2, 0.05, 0.5, 'bandpass', 3500, 2500, c.destination, 4); }],
  empty: [0.06, (c) => { burst(c, 0, 0.03, 0.6, 'bandpass', 2000, 1500, c.destination, 3); }],
  jet: [2, (c) => {
    // Band-passed noise with a slow LFO on the gain; played as a loop.
    const n = noise(c, 2.1);
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.8;
    const g = c.createGain(); g.gain.value = 0.5;
    const lfo = c.createOscillator(); lfo.frequency.value = 2; const lg = c.createGain(); lg.gain.value = 0.15;
    lfo.connect(lg).connect(g.gain);
    n.connect(f).connect(g).connect(c.destination);
    n.start(0); lfo.start(0);
  }],
  boom: [1.3, (c) => { burst(c, 0, 1.2, 1, 'lowpass', 1800, 120, c.destination, 0.4); tone(c, 'sine', 70, 35, 0, 1.0, 1, c.destination); }],
  knife: [0.2, (c) => { const g = c.createGain(); g.gain.setValueAtTime(0.0001, 0); g.gain.linearRampToValueAtTime(0.6, 0.07); g.gain.exponentialRampToValueAtTime(0.0001, 0.18); const n = noise(c, 0.2); const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.setValueAtTime(1500, 0); f.frequency.exponentialRampToValueAtTime(5000, 0.18); n.connect(f).connect(g).connect(c.destination); n.start(0); }],
  hit: [0.08, (c) => tone(c, 'sine', 1800, 1800, 0, 0.06, 0.5, c.destination)],
  hurt: [0.2, (c) => tone(c, 'sine', 140, 55, 0, 0.18, 0.9, c.destination)],
  // Mini-Militia-style falling whistle into a soft thud: you died, respawn is on its way.
  death: [0.95, (c) => {
    tone(c, 'triangle', 880, 150, 0, 0.55, 0.22, c.destination);
    tone(c, 'sine', 110, 45, 0.5, 0.42, 0.85, c.destination);
    burst(c, 0.5, 0.3, 0.4, 'lowpass', 700, 90, c.destination, 0.5);
  }],
  pickup: [0.3, (c) => { [660, 880, 1320].forEach((f, i) => tone(c, 'triangle', f, f, i * 0.08, 0.09, 0.4, c.destination)); }],
  click: [0.05, (c) => tone(c, 'square', 1000, 1000, 0, 0.03, 0.15, c.destination)],
  beep: [0.15, (c) => tone(c, 'sine', 880, 880, 0, 0.12, 0.4, c.destination)],
  alarm: [0.9, (c) => { for (let i = 0; i < 4; i++) tone(c, 'square', i % 2 ? 900 : 600, i % 2 ? 900 : 600, i * 0.2, 0.18, 0.25, c.destination); }],
  sting: [1.3, (c) => { [523, 392, 311, 262].forEach((f, i) => tone(c, 'sawtooth', f, f * 0.98, i * 0.15, 0.6, 0.18, c.destination)); }],
};

/** 8-bar loop at `bpm`: kick, snare, saw bass. Frenzy is faster and brighter (with hats). */
function musicRecipe(bpm: number, bright: boolean): [number, (c: OfflineAudioContext) => void] {
  const beat = 60 / bpm;
  const bars = 8;
  const dur = bars * 4 * beat;
  return [dur, (c) => {
    const out = c.createGain();
    out.gain.value = 0.5;
    out.connect(c.destination);
    const bassNotes = [55, 55, 65.4, 49, 55, 55, 73.4, 61.7]; // A, A, C, G, A, A, D, B (Hz)
    for (let bar = 0; bar < bars; bar++) {
      for (let b = 0; b < 4; b++) {
        const t = (bar * 4 + b) * beat;
        tone(c, 'sine', 150, 45, t, 0.25, 0.9, out); // kick
        if (b % 2 === 1) burst(c, t, 0.15, 0.45, 'bandpass', 1800, 1200, out, 0.8); // snare
        if (bright) { burst(c, t + beat / 2, 0.04, 0.18, 'highpass', 8000, 7000, out); burst(c, t, 0.03, 0.12, 'highpass', 9000, 8000, out); }
        for (let e = 0; e < 2; e++) {
          // Saw bass on eighth notes through a low-pass filter.
          const tt = t + e * beat / 2;
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = bassNotes[bar] * (e === 1 && b === 3 ? 2 : 1);
          const f = c.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.value = bright ? 1400 : 700;
          const g = env(c, tt, 0.22, 0.01, beat / 2 - 0.02);
          o.connect(f).connect(g).connect(out);
          o.start(tt);
          o.stop(tt + beat / 2);
        }
      }
    }
  }];
}

export class Audio {
  ctx: AudioContext;
  private master: GainNode;
  private music: GainNode;
  private sfx: GainNode;
  private buffers = new Map<SoundName, AudioBuffer>();
  private voices: { src: AudioBufferSourceNode; started: number }[] = [];
  private musicSrc: AudioBufferSourceNode | null = null;
  private musicKind: 'music' | 'musicFrenzy' | null = null;
  private jetSrc: AudioBufferSourceNode | null = null;
  private jetGain: GainNode;
  volumes = { master: 0.8, music: 0.45, sfx: 0.8 };
  /** Listener position (camera centre) for panning; half view width for attenuation. */
  listenerX = 0;
  listenerY = 0;
  hearing = 900;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.music = this.ctx.createGain();
    this.sfx = this.ctx.createGain();
    this.music.connect(this.master);
    this.sfx.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.jetGain = this.ctx.createGain();
    this.jetGain.gain.value = 0;
    this.jetGain.connect(this.sfx);
    try {
      Object.assign(this.volumes, JSON.parse(localStorage.getItem(VOL_KEY) ?? '{}'));
    } catch { /* ignore bad saved data */ }
    this.applyVolumes();
    // Mute while the tab is hidden.
    document.addEventListener('visibilitychange', () => this.applyVolumes());
  }

  /** Synthesise every buffer. `progress` receives 0..1. */
  async generate(progress: (f: number) => void): Promise<void> {
    const names = Object.keys(RECIPES) as (keyof typeof RECIPES)[];
    const total = names.length + 2;
    let done = 0;
    for (const n of names) {
      const [dur, build] = RECIPES[n];
      this.buffers.set(n, await render(dur, build));
      progress(++done / total);
    }
    const [d1, b1] = musicRecipe(120, false);
    this.buffers.set('music', await render(d1, b1, 22050));
    progress(++done / total);
    const [d2, b2] = musicRecipe(140, true);
    this.buffers.set('musicFrenzy', await render(d2, b2, 22050));
    progress(1);
  }

  /** Browsers block audio until a user gesture: call from the first tap/key. */
  unlock(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  applyVolumes(): void {
    const hidden = document.visibilityState === 'hidden';
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(hidden ? 0 : this.volumes.master, t, 0.02);
    this.music.gain.setTargetAtTime(this.volumes.music, t, 0.02);
    this.sfx.gain.setTargetAtTime(this.volumes.sfx, t, 0.02);
  }

  setVolumes(v: Partial<Audio['volumes']>): void {
    Object.assign(this.volumes, v);
    localStorage.setItem(VOL_KEY, JSON.stringify(this.volumes));
    this.applyVolumes();
  }

  /**
   * Play a sound. With (x, y) it is a world sound: panned by x relative to the camera and
   * quieter with distance. Without, it plays centred (UI and own-player sounds).
   */
  play(name: SoundName, volume = 1, x?: number, y?: number, rate = 1): void {
    const buf = this.buffers.get(name);
    if (!buf || this.ctx.state !== 'running') return;
    let pan = 0;
    let gain = volume;
    if (x !== undefined && y !== undefined) {
      const dx = x - this.listenerX;
      const dist = Math.hypot(dx, y - this.listenerY);
      gain *= Math.max(0, 1 - dist / (this.hearing * 2.2));
      if (gain < 0.02) return;
      pan = Math.max(-1, Math.min(1, dx / this.hearing));
    }
    // Voice pool: steal the oldest voice when 16 are playing.
    this.voices = this.voices.filter((v) => v.started + (v.src.buffer?.duration ?? 0) / v.src.playbackRate.value > this.ctx.currentTime);
    if (this.voices.length >= MAX_VOICES) {
      const oldest = this.voices.shift()!;
      try { oldest.src.stop(); } catch { /* already stopped */ }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.sfx);
    src.start();
    this.voices.push({ src, started: this.ctx.currentTime });
  }

  /** Looping jetpack noise; volume follows thrust. */
  setJet(on: boolean): void {
    if (!this.jetSrc && this.buffers.has('jet') && this.ctx.state === 'running') {
      this.jetSrc = this.ctx.createBufferSource();
      this.jetSrc.buffer = this.buffers.get('jet')!;
      this.jetSrc.loop = true;
      this.jetSrc.connect(this.jetGain);
      this.jetSrc.start();
    }
    this.jetGain.gain.setTargetAtTime(on ? 0.45 : 0, this.ctx.currentTime, on ? 0.03 : 0.08);
  }

  /** Start or switch the music loop (normal / Frenzy); null stops it. */
  setMusic(kind: 'music' | 'musicFrenzy' | null): void {
    if (kind === this.musicKind) return;
    this.musicKind = kind;
    if (this.musicSrc) {
      try { this.musicSrc.stop(); } catch { /* already stopped */ }
      this.musicSrc = null;
    }
    if (!kind || this.ctx.state !== 'running') {
      if (this.ctx.state !== 'running') this.musicKind = null;
      return;
    }
    const buf = this.buffers.get(kind);
    if (!buf) return;
    this.musicSrc = this.ctx.createBufferSource();
    this.musicSrc.buffer = buf;
    this.musicSrc.loop = true;
    this.musicSrc.connect(this.music);
    this.musicSrc.start();
  }
}
