import * as THREE from 'three';
import { G, carStats } from './car.js';
import { WHEEL_R } from './carModel.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3();

// AI opponents ride the centre-line spline with a lateral offset, choosing speed
// from the curvature ahead (v = sqrt(a_lat / k)) and braking early enough to make it.
export class AIDriver {
  constructor(spec, model, name, skill, track, index, lateral) {
    this.spec = spec;
    this.model = model;
    this.name = name;
    this.skill = skill;
    this.isPlayer = false;
    this.s = index - track.N; // continuous progress in samples; < 0 means behind the line
    this.lat = lateral;
    this.latVel = 0;
    this.bias = (Math.random() - 0.5) * 2.5;
    this.v = 0;
    this.vmax = (carStats(spec).top / 3.6) * (0.9 + skill * 0.08);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = 0;
    this.spinAngle = 0;
    this.steer = 0;
    this.braking = 0;
    this.rpm = spec.idle;
    this.gear = 0;
    this.lapsDone = 0;
    this.lapStart = 0;
    this.bestLap = null;
    this.finished = false;
    this.finishTime = null;
    this.audio = null;
    this.place(track);
  }

  get speed() { return this.v; }
  progress() { return this.s; }

  place(track) {
    const i = track.sample(this.s, _p, _t, _n);
    this.trackIdx = i;
    this.pos.set(_p.x + _n.x * this.lat, 0, _p.z + _n.z * this.lat);
    const base = Math.atan2(_t.x, _t.z);
    this.heading = base - Math.atan2(this.latVel, Math.max(this.v, 3));
    this.vel.set(_t.x * this.v + _n.x * this.latVel, 0, _t.z * this.v + _n.z * this.latVel);
  }

  update(dt, track, racers, raceTime, totalLaps) {
    const N = track.N;
    const i = ((Math.floor(this.s) % N) + N) % N;

    // ── target speed from curvature ahead ──
    const aLat = (this.spec.grip * G + (this.spec.downforce * this.v * this.v) / this.spec.mass) * 0.8 * this.skill;
    const aBrake = 7.5 * this.skill;
    let target = this.vmax;
    for (let k = 0; k <= 100; k += 3) {
      const c = Math.max(track.curv[(i + k) % N], 1e-4);
      const vc = Math.sqrt(aLat / c);
      const allow = Math.sqrt(vc * vc + 2 * aBrake * k * track.seg);
      if (allow < target) target = allow;
    }

    // ── racing line: drift to the inside of the upcoming bend ──
    const lim = track.half - 1.4;
    let latTarget = clamp(track.scurv[(i + 10) % N] * 520, -lim * 0.75, lim * 0.75) + this.bias;

    // ── traffic ──
    for (const o of racers) {
      if (o === this) continue;
      const ds = (o.progress(N) - this.s) * track.seg;
      if (ds <= 0 || ds > 16) continue;
      const olat = o.isPlayer ? o.lateral : o.lat;
      if (Math.abs(olat - this.lat) < 2.6) {
        const side = olat > 0 ? -1 : 1;
        latTarget = olat + side * 3.6;
        if (ds < 8 && o.speed < this.v) target = Math.min(target, o.speed - 0.5);
      }
    }
    latTarget = clamp(latTarget, -lim, lim);
    const latAcc = clamp((latTarget - this.lat) * 3 - this.latVel * 2.5, -6, 6);
    this.latVel = clamp(this.latVel + latAcc * dt, -4, 4);
    this.lat = clamp(this.lat + this.latVel * dt, -lim, lim);

    // ── speed ──
    const accel = (2 + 5 * (1 - this.v / this.vmax)) * this.skill;
    const prevV = this.v;
    if (target > this.v) this.v = Math.min(target, this.v + accel * dt);
    else this.v = Math.max(target, this.v - 11 * dt);
    this.v = Math.max(0, this.v);
    this.braking = this.v < prevV - 2 * dt ? 1 : 0;

    const prevLap = Math.floor(this.s / N);
    this.s += (this.v * dt) / track.seg;
    const lap = Math.floor(this.s / N);
    // s crosses k·N at the end of lap k (the run-up from the grid counts towards lap 1)
    if (lap > prevLap && lap >= 1) {
      const t = raceTime - this.lapStart;
      this.bestLap = this.bestLap == null ? t : Math.min(this.bestLap, t);
      this.lapStart = raceTime;
      this.lapsDone = lap;
      if (totalLaps && lap >= totalLaps && !this.finished) { this.finished = true; this.finishTime = raceTime; }
    }

    // simulated engine for audio
    const s = this.spec;
    const wheelRpm = (this.v / WHEEL_R) * 60 / (2 * Math.PI);
    while (this.gear < s.gears.length - 1 && wheelRpm * s.gears[this.gear] * s.final > s.redline * 0.92) this.gear++;
    while (this.gear > 0 && wheelRpm * s.gears[this.gear - 1] * s.final < s.redline * 0.7) this.gear--;
    this.rpm = Math.max(s.idle, wheelRpm * s.gears[this.gear] * s.final);
    this.steer = clamp(track.scurv[(i + 3) % N] * -6, -0.4, 0.4);

    this.place(track);
  }

  idle() { this.rpm = this.spec.idle + Math.random() * 300; }

  syncModel(dt) {
    const m = this.model;
    m.group.position.set(this.pos.x, 0.05, this.pos.z);
    m.group.rotation.y = this.heading;
    this.spinAngle += (this.v / WHEEL_R) * dt;
    for (const sp of m.spins) sp.rotation.x = this.spinAngle;
    for (const pv of m.pivots) pv.rotation.y = this.steer;
    m.chassis.rotation.x = this.braking ? 0.025 : 0;
    m.brakeMat.emissiveIntensity = this.braking ? 4 : 0.8;
  }
}
