// All sound is synthesised live with the Web Audio API — no audio files needed.

function distortionCurve(k) {
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.aiVoices = [];
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // player engine
    this.engine = this.makeEngine();
    this.engine.out.connect(this.master);
    this.intake = this.noiseChain('bandpass', 900, 1.2);
    this.intake.out.connect(this.master);

    // tyre squeal: band-passed noise + a wobbling tone
    this.tire = this.noiseChain('bandpass', 1500, 5);
    this.tire.out.connect(this.master);
    const sq = ctx.createOscillator(); sq.type = 'triangle'; sq.frequency.value = 820;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 11;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 45;
    lfo.connect(lfoGain).connect(sq.frequency);
    this.squeal = ctx.createGain(); this.squeal.gain.value = 0;
    sq.connect(this.squeal).connect(this.master);
    sq.start(); lfo.start();

    this.wind = this.noiseChain('lowpass', 600, 0.7);
    this.wind.out.connect(this.master);
    this.rough = this.noiseChain('lowpass', 180, 1);
    this.rough.out.connect(this.master);
    this.scrapeN = this.noiseChain('bandpass', 2800, 2);
    this.scrapeN.out.connect(this.master);
  }

  noiseChain(type, freq, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const out = ctx.createGain(); out.gain.value = 0;
    src.connect(f).connect(out);
    src.start(0, Math.random() * 1.9);
    return { filter: f, out };
  }

  makeEngine() {
    const ctx = this.ctx;
    const mix = ctx.createGain();
    const oscs = [['sawtooth', 0.5], ['sawtooth', 0.45], ['square', 0.1]].map(([type, g]) => {
      const o = ctx.createOscillator(); o.type = type;
      const gn = ctx.createGain(); gn.gain.value = g;
      o.connect(gn).connect(mix);
      o.start();
      return o;
    });
    const shaper = ctx.createWaveShaper(); shaper.curve = distortionCurve(25); shaper.oversample = '2x';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
    const out = ctx.createGain(); out.gain.value = 0;
    mix.connect(shaper).connect(lp).connect(out);
    return { oscs, lp, out };
  }

  setEngine(e, rpm, throttle, cyl, vol) {
    const t = this.ctx.currentTime;
    const f = (rpm / 60) * (cyl / 2);
    e.oscs[0].frequency.setTargetAtTime(f, t, 0.02);
    e.oscs[1].frequency.setTargetAtTime(f * 0.5 * 1.004, t, 0.02);
    e.oscs[2].frequency.setTargetAtTime(f * 2.01, t, 0.02);
    e.lp.frequency.setTargetAtTime(250 + throttle * 2400 + rpm * 0.3, t, 0.04);
    e.out.gain.setTargetAtTime(vol * (0.13 + throttle * 0.17), t, 0.04);
  }

  // Positional engines for opponents.
  setOpponents(list) {
    if (!this.ctx) return;
    this.clearOpponents();
    for (const ai of list) {
      const e = this.makeEngine();
      const p = this.ctx.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = 7; p.rolloffFactor = 1.4; p.maxDistance = 500;
      e.out.connect(p).connect(this.master);
      this.aiVoices.push({ ai, e, p });
    }
  }

  clearOpponents() {
    for (const v of this.aiVoices) {
      v.e.oscs.forEach((o) => o.stop());
      v.p.disconnect();
    }
    this.aiVoices = [];
  }

  update(car, camera) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = car.spec;
    const speed = car.speed;
    this.setEngine(this.engine, car.rpm, car.throttle, s.cyl, 1);
    this.intake.out.gain.setTargetAtTime(car.throttle * (car.rpm / s.redline) * 0.06, t, 0.05);
    this.intake.filter.frequency.setTargetAtTime(500 + car.rpm * 0.2, t, 0.05);

    const sl = car.slip || 0;
    this.tire.out.gain.setTargetAtTime(sl * 0.22, t, 0.05);
    this.squeal.gain.setTargetAtTime(sl * sl * 0.05, t, 0.05);
    this.wind.out.gain.setTargetAtTime(Math.min(0.25, speed * speed * 0.00004), t, 0.1);
    this.rough.out.gain.setTargetAtTime(car.surface !== 'road' ? Math.min(0.5, speed * 0.02) : 0, t, 0.05);
    this.scrapeN.out.gain.setTargetAtTime(car.scrape > 0 ? Math.min(0.2, speed * 0.006) * car.scrape : 0, t, 0.03);

    // listener follows camera
    const L = this.ctx.listener;
    const fwd = camera.getWorldDirection(this._fwd || (this._fwd = camera.position.clone()));
    if (L.positionX) {
      L.positionX.setTargetAtTime(camera.position.x, t, 0.02);
      L.positionY.setTargetAtTime(camera.position.y, t, 0.02);
      L.positionZ.setTargetAtTime(camera.position.z, t, 0.02);
      L.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      L.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      L.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      L.setPosition(camera.position.x, camera.position.y, camera.position.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
    for (const v of this.aiVoices) {
      const a = v.ai;
      if (v.p.positionX) {
        v.p.positionX.setTargetAtTime(a.pos.x, t, 0.02);
        v.p.positionY.setTargetAtTime(0.5, t, 0.02);
        v.p.positionZ.setTargetAtTime(a.pos.z, t, 0.02);
      } else v.p.setPosition(a.pos.x, 0.5, a.pos.z);
      this.setEngine(v.e, a.rpm, a.braking ? 0.1 : 0.8, a.spec.cyl, 0.55);
    }
  }

  silence() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const g of [this.engine.out, this.intake.out, this.tire.out, this.squeal, this.wind.out, this.rough.out, this.scrapeN.out]) {
      g.gain.setTargetAtTime(0, t, 0.05);
    }
  }

  burst(dur, type, freq, vol) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }

  thud(strength) {
    if (!this.ctx) return;
    const v = Math.min(1, strength / 15);
    this.burst(0.35, 'lowpass', 500, 0.9 * v + 0.15);
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.6 * v + 0.1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.35);
  }

  shift() {
    if (!this.ctx) return;
    this.burst(0.08, 'bandpass', 1800, 0.18);
  }

  beep(freq, dur = 0.25) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    g.gain.setValueAtTime(0.16, t + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }
}
