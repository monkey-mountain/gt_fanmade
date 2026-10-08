import * as THREE from 'three';
import { WHEEL_R } from './carModel.js';

export const G = 9.81;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Fictional cars. Torque in Nm, mass in kg, drag = 0.5·ρ·Cd·A.
export const CARS = [
  {
    id: 'kestrel', name: 'Kestrel RS', desc: 'Light, balanced and eager to turn in.', style: 'coupe', color: 0xd81e2c,
    torque: 380, mass: 1180, grip: 1.12, downforce: 0.45, redline: 8000, idle: 950, drag: 0.38, cyl: 4,
    gears: [3.4, 2.2, 1.6, 1.25, 1.0, 0.84], final: 4.1, wheelbase: 2.55,
  },
  {
    id: 'orion', name: 'Orion V8', desc: 'Big-block muscle. Mighty on the straights.', style: 'muscle', color: 0x1d4fd8,
    torque: 620, mass: 1540, grip: 0.98, downforce: 0.2, redline: 6800, idle: 800, drag: 0.37, cyl: 8,
    gears: [2.9, 1.95, 1.45, 1.15, 0.92, 0.75], final: 3.6, wheelbase: 2.75,
  },
  {
    id: 'mistral', name: 'Mistral GT-P', desc: 'Aero prototype. Glued to the tarmac.', style: 'proto', color: 0xf2b705,
    torque: 410, mass: 1260, grip: 1.2, downforce: 1.25, redline: 9000, idle: 1100, drag: 0.43, cyl: 6,
    gears: [3.2, 2.15, 1.6, 1.28, 1.05, 0.88], final: 3.9, wheelbase: 2.65,
  },
];

export function torqueAt(spec, rpm) {
  const x = rpm / spec.redline;
  return spec.torque * Math.max(0.35, 1 - 1.2 * (x - 0.7) ** 2);
}

export function carStats(spec) {
  let hp = 0;
  for (let r = 1000; r <= spec.redline; r += 100) hp = Math.max(hp, (torqueAt(spec, r) * r * 2 * Math.PI) / 60 / 745.7);
  const top = ((spec.redline * 2 * Math.PI) / 60) * WHEEL_R / (spec.gears[spec.gears.length - 1] * spec.final);
  return { hp: Math.round(hp), kg: spec.mass, top: Math.round(top * 3.6 * 0.98), grip: spec.grip };
}

const SURFACE = {
  road: { grip: 1, roll: 0.015 },
  sand: { grip: 0.5, roll: 0.22 },
  grass: { grip: 0.6, roll: 0.09 },
};

export class Car {
  constructor(spec, model, name = 'YOU') {
    this.spec = spec;
    this.model = model;
    this.name = name;
    this.isPlayer = true;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.gear = 0;
    this.rpm = spec.idle;
    this.shiftTimer = 0;
    this.reverse = false;
    this.throttle = 0;
    this.braking = 0;
    this.slip = 0;
    this.wheelSpin = 0;
    this.latAcc = 0;
    this.lonAcc = 0;
    this.surface = 'road';
    this.impact = 0;
    this.scrape = 0;
    this.spinAngle = 0;
    this.vLong = 0;
    this.trackIdx = 0;
    this.lateral = 0;
    // race bookkeeping
    this.lap = 0;
    this.halfway = false;
    this.lapStart = 0;
    this.lastLap = null;
    this.bestLap = null;
    this.finished = false;
    this.finishTime = null;
    this.events = { shift: 0 };
  }

  placeAt(track, index, lateral) {
    const i = ((index % track.N) + track.N) % track.N;
    const p = track.points[i], n = track.normals[i];
    this.pos.set(p.x + n.x * lateral, 0, p.z + n.z * lateral);
    this.heading = track.headingAt(i);
    this.vel.set(0, 0, 0);
    this.yawRate = 0; this.steer = 0; this.gear = 0; this.reverse = false;
    this.trackIdx = i;
    this.lateral = lateral;
  }

  resetToTrack(track) {
    const pr = track.project(this.pos, null);
    this.placeAt(track, pr.index, THREE.MathUtils.clamp(pr.lateral, -track.half + 2, track.half - 2));
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }

  progress(N) { return (this.lap - 1) * N + this.trackIdx; }

  // Stationary (countdown): let the engine rev.
  idle(dt, input) {
    const s = this.spec;
    const target = s.idle + input.throttle * (s.redline - s.idle) * 0.97;
    this.rpm += (target - this.rpm) * Math.min(1, dt * (target > this.rpm ? 7 : 4));
    this.throttle = input.throttle;
    this.braking = 1;
    this.slip = 0;
  }

  step(dt, input, track) {
    const s = this.spec;
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const rx = -fz, rz = fx; // driver's right
    let vLong = this.vel.x * fx + this.vel.z * fz;
    let vLat = this.vel.x * rx + this.vel.z * rz;
    const speed = Math.abs(vLong);

    // ── surface ──
    const pr = track.project(this.pos, this.trackIdx);
    this.trackIdx = pr.index;
    this.lateral = pr.lateral;
    const absLat = Math.abs(pr.lateral);
    this.surface = absLat < track.half + 1.4 ? 'road' : track.corner[pr.index] && absLat < track.half + 7 ? 'sand' : 'grass';
    const surf = SURFACE[this.surface];
    const gripAcc = (s.grip * G + (s.downforce * vLong * vLong) / s.mass) * surf.grip;

    // ── steering: full lock sits just past the grip limit, so holding a key doesn't plough ──
    const gripLock = Math.atan((s.wheelbase * gripAcc * 1.18) / Math.max(speed * speed, 1));
    const maxSteer = Math.min(0.6, gripLock * (input.handbrake ? 2.2 : 1));
    this.steer += clamp(input.steer * maxSteer - this.steer, -3 * dt, 3 * dt);

    // ── pedals / direction ──
    let throttle = input.throttle, brake = input.brake, braking = 0;
    if (throttle > 0 && vLong > -0.5) this.reverse = false;
    if (brake > 0 && throttle === 0 && vLong < 0.5) this.reverse = true;
    if (!this.reverse) {
      if (brake > 0 && vLong > 0.3) braking = brake;
      if (throttle > 0 && vLong < -0.3) { braking = Math.max(braking, throttle); throttle = 0; }
    } else if (throttle > 0 && vLong < -0.3) {
      braking = throttle;
    }

    // ── engine & gearbox ──
    let drive = 0;
    const wheelRpm = (speed / WHEEL_R) * 60 / (2 * Math.PI);
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    if (this.reverse) {
      this.gear = 0;
      const rpmT = Math.max(s.idle + brake * 2500, wheelRpm * 3.2 * s.final);
      this.rpm += (rpmT - this.rpm) * Math.min(1, dt * 8);
      if (brake > 0 && vLong > -11) drive = -brake * s.mass * 4.5;
      this.throttle = brake;
    } else {
      const ratio = (g) => s.gears[g] * s.final;
      let engRpm = wheelRpm * ratio(this.gear);
      if (this.shiftTimer <= 0) {
        if (engRpm > s.redline * 0.94 && this.gear < s.gears.length - 1 && vLong > 0) {
          this.gear++; this.shiftTimer = 0.18; this.events.shift++;
        } else if (this.gear > 0) {
          const lower = wheelRpm * ratio(this.gear - 1);
          if (lower < s.redline * 0.78 && engRpm < s.redline * 0.52) { this.gear--; this.shiftTimer = 0.12; }
        }
      }
      engRpm = wheelRpm * ratio(this.gear);
      const clutch = this.gear === 0 ? s.idle + throttle * s.redline * 0.42 : s.idle;
      const rpmT = Math.max(engRpm, clutch);
      this.rpm += (rpmT - this.rpm) * Math.min(1, dt * 14);
      let torque = torqueAt(s, this.rpm) * throttle;
      if (this.shiftTimer > 0) torque = 0;
      if (this.rpm >= s.redline) { torque = 0; this.rpm = s.redline - 120 * Math.random(); }
      drive = (torque * ratio(this.gear) * 0.85) / WHEEL_R;
      // engine braking
      if (throttle < 0.05 && vLong > 1) drive -= s.mass * 0.9 * (this.rpm / s.redline);
      this.throttle = throttle;
    }

    // traction limit on the driven axle
    const maxTrac = gripAcc * s.mass * 0.62;
    this.wheelSpin = drive > maxTrac ? Math.min(1, (drive - maxTrac) / maxTrac) : 0;
    drive = clamp(drive, -maxTrac, maxTrac);

    // ── longitudinal ──
    const prevLong = vLong;
    let Fx = drive;
    Fx -= s.drag * vLong * Math.abs(vLong);
    Fx -= surf.roll * s.mass * G * Math.sign(vLong) * Math.min(1, speed);
    vLong += (Fx / s.mass) * dt;
    if (braking > 0) {
      const dec = braking * gripAcc * 1.02 * dt;
      vLong = Math.abs(vLong) <= dec ? 0 : vLong - Math.sign(vLong) * dec;
    }
    if (input.handbrake) {
      const dec = 3.5 * dt;
      vLong = Math.abs(vLong) <= dec ? 0 : vLong - Math.sign(vLong) * dec;
    }
    this.braking = braking;

    // ── lateral grip ──
    const latGrip = gripAcc * (input.handbrake ? 0.32 : 1) * (this.wheelSpin > 0.3 ? 0.72 : 1);
    const maxDv = latGrip * dt;
    const dvLat = clamp(-vLat, -maxDv, maxDv);
    vLat += dvLat;
    vLong -= Math.sign(vLong) * Math.abs(dvLat) * 0.06; // sliding scrubs speed

    // ── yaw ──
    const rawYaw = (vLong * Math.tan(this.steer)) / s.wheelbase;
    const yawMax = (gripAcc * (input.handbrake ? 1.9 : 1.0)) / Math.max(Math.abs(vLong), 4);
    const yawT = clamp(rawYaw, -yawMax, yawMax);
    const understeer = Math.max(0, Math.abs(rawYaw) - yawMax) / yawMax;
    this.yawRate += (yawT - this.yawRate) * Math.min(1, dt * 10);
    vLong *= 1 - Math.min(0.5, understeer) * 0.25 * dt;

    this.vel.set(fx * vLong + rx * vLat, 0, fz * vLong + rz * vLat);
    this.heading += this.yawRate * dt;
    this.pos.addScaledVector(this.vel, dt);

    this.slip = clamp(Math.max(0, Math.abs(vLat) - 1.2) / 5 + understeer * 0.6 + this.wheelSpin * 0.8
      + (braking > 0.9 && speed > 25 ? 0.15 : 0), 0, 1) * (this.surface === 'road' ? 1 : 0.3);
    if (speed < 3) this.slip *= speed / 3;
    this.latAcc += (vLong * this.yawRate - this.latAcc) * Math.min(1, dt * 6);
    this.lonAcc += ((vLong - prevLong) / dt - this.lonAcc) * Math.min(1, dt * 6);
    this.vLong = vLong;

    // ── barriers ──
    this.scrape = Math.max(0, this.scrape - dt * 4);
    const pr2 = track.project(this.pos, this.trackIdx);
    const limit = track.wallOffset - 1.05;
    if (Math.abs(pr2.lateral) > limit) {
      const n = track.normals[pr2.index];
      const sgn = Math.sign(pr2.lateral);
      const excess = Math.abs(pr2.lateral) - limit;
      this.pos.x -= n.x * sgn * excess;
      this.pos.z -= n.z * sgn * excess;
      const vn = (this.vel.x * n.x + this.vel.z * n.z) * sgn;
      if (vn > 0) {
        this.vel.x -= n.x * sgn * vn * 1.35;
        this.vel.z -= n.z * sgn * vn * 1.35;
        this.impact = Math.max(this.impact, vn);
        this.yawRate *= 0.5;
      }
      this.vel.multiplyScalar(1 - 0.6 * dt);
      this.scrape = 1;
    }
  }

  rearWheels(out) {
    const d = this.model.dims;
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const rx = -fz, rz = fx;
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1;
      out[k].set(
        this.pos.x + rx * side * d.wheelX + fx * d.rearZ, 0,
        this.pos.z + rz * side * d.wheelX + fz * d.rearZ,
      );
    }
    return out;
  }

  syncModel(dt) {
    const m = this.model;
    m.group.position.set(this.pos.x, 0.05, this.pos.z);
    m.group.rotation.y = this.heading;
    m.chassis.rotation.z = clamp(this.latAcc * 0.009, -0.07, 0.07);
    m.chassis.rotation.x = clamp(-this.lonAcc * 0.005, -0.045, 0.045);
    m.chassis.position.y = this.surface === 'road' ? 0 : (Math.random() - 0.5) * Math.min(0.05, this.speed * 0.002);
    this.spinAngle += (this.vLong / WHEEL_R) * dt;
    for (const sp of m.spins) sp.rotation.x = this.spinAngle;
    for (const pv of m.pivots) pv.rotation.y = this.steer;
    m.brakeMat.emissiveIntensity = this.braking > 0.05 ? 4 : 0.8;
  }
}
