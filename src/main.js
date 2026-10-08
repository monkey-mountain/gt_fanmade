import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Track } from './track.js';
import { CARS, Car, carStats } from './car.js';
import { buildCarModel, disposeModel } from './carModel.js';
import { AIDriver } from './ai.js';
import { AudioEngine } from './audio.js';
import { HUD, formatTime } from './hud.js';
import { Input } from './input.js';
import { SkidMarks, Smoke } from './fx.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TOTAL_LAPS = 3;
const STEP = 1 / 120;

const PAINTS = [0xd81e2c, 0x1d4fd8, 0xf2b705, 0xf4f4f4, 0x15171a, 0x9aa3ad, 0x1f8a4c, 0xff6b1a, 0x7b2cbf];
const AI_NAMES = ['K. Hayashi', 'L. Moreau', 'J. Whitfield', 'S. Okafor', 'A. Lindqvist'];
const CAM_MODES = [['chase', 'CHASE CAM'], ['far', 'FAR CHASE'], ['hood', 'HOOD CAM'], ['bumper', 'BUMPER CAM']];

// ───────────── renderer / scene ─────────────
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 5000);

const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(140));
function makeSky(scale) {
  const sky = new Sky();
  sky.scale.setScalar(scale);
  const u = sky.material.uniforms;
  u.turbidity.value = 4.5;
  u.rayleigh.value = 1.3;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(sunDir);
  return sky;
}
scene.add(makeSky(4500));
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(makeSky(50));
  scene.environment = pmrem.fromScene(envScene).texture;
  scene.environmentIntensity = 0.7;
}
scene.fog = new THREE.Fog(0xb9cde0, 400, 2800);

scene.add(new THREE.HemisphereLight(0xd6e8ff, 0x4b5a3b, 0.9));
const sun = new THREE.DirectionalLight(0xfff0dc, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 500 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

const track = new Track();
track.build(scene);

const hud = new HUD(track);
const audio = new AudioEngine();
const input = new Input();
const skids = new SkidMarks(scene);
const smoke = new Smoke(scene);

// ───────────── state ─────────────
const sel = { mode: 'race', car: 0, color: CARS[0].color };
const state = { phase: 'menu', prevPhase: null, countdown: 0, cdStage: 0, raceTime: 0, finishT: 0, t: 0 };
let player = null;
let ais = [];
let racers = [];
let showroom = null;
let camMode = 0;
const cam = { heading: 0, y: 0, shake: 0 };

const storage = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
camMode = storage.get('gtf-cam') ?? 0;

// ───────────── menu ─────────────
function buildMenu() {
  const list = $('car-list');
  CARS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'car-card';
    b.innerHTML = `<span class="dot" style="background:#${c.color.toString(16).padStart(6, '0')}"></span><span>${c.name}<small>${c.desc}</small></span>`;
    b.onclick = () => { sel.car = i; sel.color = c.color; refreshMenu(); };
    list.appendChild(b);
  });
  const sw = $('swatches');
  PAINTS.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = '#' + p.toString(16).padStart(6, '0');
    b.dataset.c = p;
    b.onclick = () => { sel.color = p; refreshMenu(); };
    sw.appendChild(b);
  });
  document.querySelectorAll('.mode').forEach((b) => {
    b.onclick = () => { sel.mode = b.dataset.mode; refreshMenu(); };
  });
  $('start-btn').onclick = startRace;
  document.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'resume') togglePause(false);
      if (a === 'restart') { togglePause(false); startRace(); }
      if (a === 'menu') { togglePause(false); toMenu(); }
    };
  });
}

function refreshMenu() {
  document.querySelectorAll('.car-card').forEach((b, i) => b.classList.toggle('active', i === sel.car));
  document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', +b.dataset.c === sel.color));
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === sel.mode));
  const spec = CARS[sel.car];
  const st = carStats(spec);
  $('car-name').textContent = spec.name;
  $('car-desc').textContent = spec.desc;
  const best = storage.get(`gtf-best-${spec.id}`);
  const rows = [
    ['Power', st.hp / 550, `${st.hp} hp`],
    ['Weight', 1 - (st.kg - 1000) / 800, `${st.kg} kg`],
    ['Grip', (st.grip - 0.8) / 0.5, `${st.grip.toFixed(2)} g`],
    ['Top speed', st.top / 340, `${st.top} km/h`],
  ];
  $('car-stats').innerHTML = rows.map(([k, v, t]) =>
    `<div class="stat"><span>${k}</span><span class="bar"><i style="width:${clamp(v, 0.05, 1) * 100}%"></i></span><span class="val">${t}</span></div>`).join('')
    + `<div class="stat"><span>Best lap</span><span></span><span class="val">${best ? formatTime(best) : '—'}</span></div>`;
  // showroom car
  if (showroom) disposeModel(showroom);
  showroom = buildCarModel(spec, sel.color);
  const f = track.frameAt(-60);
  showroom.group.position.set(f.p.x, 0.05, f.p.z);
  showroom.group.rotation.y = f.h;
  scene.add(showroom.group);
}

function toMenu() {
  clearRace();
  state.phase = 'menu';
  hud.show(false);
  $('results').classList.add('hidden');
  $('menu').classList.remove('hidden');
  audio.silence();
  refreshMenu();
}

// ───────────── race setup ─────────────
function clearRace() {
  if (player) disposeModel(player.model);
  ais.forEach((a) => disposeModel(a.model));
  player = null; ais = []; racers = [];
  audio.clearOpponents();
  skids.clear(); smoke.clear();
  track.setStartLights(0);
}

function startRace() {
  audio.init();
  audio.resume();
  clearRace();
  if (showroom) { disposeModel(showroom); showroom = null; }
  camera.clearViewOffset();
  $('menu').classList.add('hidden');
  $('results').classList.add('hidden');

  state.mode = sel.mode;
  const solo = sel.mode === 'trial';
  const slots = solo ? 1 : 6;
  const spec = CARS[sel.car];
  const others = PAINTS.filter((p) => p !== sel.color);
  for (let k = 0; k < slots; k++) {
    const g = track.gridSlot(k, solo);
    if (k === slots - 1) {
      player = new Car(spec, buildCarModel(spec, sel.color));
      player.placeAt(track, g.index, g.lateral);
      scene.add(player.model.group);
    } else {
      const aspec = CARS[(sel.car + 1 + k) % CARS.length];
      const color = others[(k * 2) % others.length];
      const skill = 0.93 - k * 0.02 + Math.random() * 0.03;
      const ai = new AIDriver(aspec, buildCarModel(aspec, color), AI_NAMES[k], skill, track, g.index, g.lateral);
      scene.add(ai.model.group);
      ais.push(ai);
    }
  }
  racers = [player, ...ais];
  player.bestLap = solo ? storage.get(`gtf-best-${spec.id}`) : null;
  audio.setOpponents(ais);

  cam.heading = player.heading;
  state.phase = 'countdown';
  state.countdown = 0;
  state.cdStage = 0;
  state.raceTime = 0;
  hud.show(true);
  hud.camLabel(CAM_MODES[camMode][1]);
}

function togglePause(force) {
  if (!player || state.phase === 'menu') return;
  const pausing = force ?? state.phase !== 'paused';
  if (pausing && state.phase !== 'paused') {
    state.prevPhase = state.phase;
    state.phase = 'paused';
    $('pause').classList.remove('hidden');
    audio.suspend();
  } else if (!pausing && state.phase === 'paused') {
    state.phase = state.prevPhase;
    $('pause').classList.add('hidden');
    audio.resume();
  }
}

input.onPress = (code) => {
  if (code === 'Escape' || code === 'KeyP') {
    if ($('results').classList.contains('hidden')) togglePause();
  } else if (code === 'KeyC' && player) {
    camMode = (camMode + 1) % CAM_MODES.length;
    storage.set('gtf-cam', camMode);
    hud.camLabel(CAM_MODES[camMode][1]);
  } else if (code === 'KeyM') {
    audio.setMuted(!audio.muted);
  } else if (code === 'KeyR' && player && state.phase === 'racing') {
    player.resetToTrack(track);
    cam.heading = player.heading;
  } else if (code === 'Enter' && state.phase === 'menu') {
    startRace();
  }
};
document.addEventListener('visibilitychange', () => { if (document.hidden && state.phase === 'racing') togglePause(true); });

// ───────────── simulation ─────────────
function autopilot(car) {
  const t = track.tangents[car.trackIdx];
  let err = Math.atan2(t.x, t.z) - car.heading;
  err = Math.atan2(Math.sin(err), Math.cos(err));
  return { throttle: car.speed < 22 ? 0.35 : 0, brake: car.speed > 30 ? 0.4 : 0, steer: clamp(err * 2.2 + car.lateral * 0.06, -1, 1), handbrake: false };
}

function countdownStep(dt, inp) {
  state.countdown += dt;
  player.idle(dt, inp);
  ais.forEach((a) => a.idle());
  const marks = [0.8, 1.8, 2.8, 3.8];
  while (state.cdStage < 4 && state.countdown >= marks[state.cdStage]) {
    state.cdStage++;
    if (state.cdStage < 4) {
      hud.banner(String(4 - state.cdStage));
      track.setStartLights([0, 2, 4, 5][state.cdStage]);
      audio.beep(440, 0.25);
    } else {
      hud.banner('GO!', 'go');
      track.setStartLights(5, true);
      audio.beep(880, 0.6);
      state.phase = 'racing';
      state.raceTime = 0;
      player.lapStart = 0;
      ais.forEach((a) => { a.lapStart = 0; });
    }
  }
}

function checkPlayerLap(prevIdx) {
  const N = track.N, i = player.trackIdx;
  if (i > N * 0.4 && i < N * 0.6) player.halfway = true;
  if (prevIdx > N * 0.8 && i < N * 0.2) {
    if (player.lap === 0 || player.halfway) {
      player.lap++;
      player.halfway = false;
      if (player.lap >= 2) {
        const t = state.raceTime - player.lapStart;
        player.lastLap = t;
        player.lapStart = state.raceTime;
        const isBest = player.bestLap == null || t < player.bestLap;
        if (isBest) {
          player.bestLap = t;
          if (state.mode === 'trial') {
            storage.set(`gtf-best-${player.spec.id}`, t);
          }
        }
        if (state.mode === 'race' && player.lap > TOTAL_LAPS) return finishRace();
        hud.banner(isBest ? 'BEST LAP' : formatTime(t), 'small');
        if (state.mode === 'race' && player.lap === TOTAL_LAPS) setTimeout(() => state.phase === 'racing' && hud.banner('FINAL LAP', 'small'), 1300);
      }
    }
  } else if (prevIdx < N * 0.2 && i > N * 0.8) {
    // crossed the line backwards
    player.lap--;
    player.halfway = true;
  }
}

function finishRace() {
  player.finished = true;
  player.finishTime = state.raceTime;
  state.phase = 'finished';
  state.finishT = 0;
  hud.banner('FINISH', 'go');
  audio.beep(660, 0.2);
  setTimeout(() => audio.beep(990, 0.5), 220);
}

function resolveCollisions() {
  for (const ai of ais) {
    const dx = player.pos.x - ai.pos.x, dz = player.pos.z - ai.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 3.9 || d < 1e-3) continue;
    const nx = dx / d, nz = dz / d, overlap = 3.9 - d;
    player.pos.x += nx * overlap * 0.6;
    player.pos.z += nz * overlap * 0.6;
    const n = track.normals[ai.trackIdx], t = track.tangents[ai.trackIdx];
    ai.lat -= (nx * n.x + nz * n.z) * overlap * 0.4;
    ai.s -= ((nx * t.x + nz * t.z) * overlap * 0.4) / track.seg;
    const rv = (player.vel.x - ai.vel.x) * nx + (player.vel.z - ai.vel.z) * nz;
    if (rv < 0) {
      const j = -rv * 0.85;
      player.vel.x += nx * j * 0.5;
      player.vel.z += nz * j * 0.5;
      ai.v = Math.max(0, ai.v - (nx * t.x + nz * t.z) * j * 0.5);
      ai.latVel -= (nx * n.x + nz * n.z) * j * 0.5;
      player.impact = Math.max(player.impact, -rv);
    }
  }
  // AI vs AI: nudge apart sideways
  for (let a = 0; a < ais.length; a++) for (let b = a + 1; b < ais.length; b++) {
    const A = ais[a], B = ais[b];
    const ds = (A.s - B.s) * track.seg, dl = A.lat - B.lat;
    if (Math.abs(ds) < 4.4 && Math.abs(dl) < 2.1) {
      const push = (2.1 - Math.abs(dl)) * 0.5 * (Math.sign(dl) || 1);
      A.lat += push; B.lat -= push;
      const behind = ds < 0 ? A : B, ahead = ds < 0 ? B : A;
      behind.v = Math.min(behind.v, ahead.v);
    }
  }
}

function fixedStep(dt, inp) {
  if (state.phase === 'countdown') return countdownStep(dt, inp);
  if (state.phase !== 'racing' && state.phase !== 'finished') return;
  if (state.phase === 'racing') state.raceTime += dt;
  else { state.finishT += dt; inp = autopilot(player); }
  const prevIdx = player.trackIdx;
  player.step(dt, inp, track);
  const laps = state.mode === 'race' ? TOTAL_LAPS : 0;
  for (const ai of ais) ai.update(dt, track, racers, state.raceTime, laps);
  resolveCollisions();
  if (state.phase === 'racing') checkPlayerLap(prevIdx);
}

// ───────────── standings / results ─────────────
function standings() {
  const N = track.N;
  return [...racers].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    return b.progress(N) - a.progress(N);
  });
}

function showResults() {
  const order = standings();
  const N = track.N;
  const leader = order[0];
  $('res-title').textContent = state.mode === 'race'
    ? `${order.indexOf(player) + 1}${['st', 'nd', 'rd'][order.indexOf(player)] || 'th'} Place`
    : 'Session Complete';
  const rows = order.map((r, i) => {
    let time;
    if (r.finished) time = i === 0 ? formatTime(r.finishTime) : `+${(r.finishTime - leader.finishTime).toFixed(3)}`;
    else {
      const behind = Math.floor((leader.progress(N) - r.progress(N)) / N);
      time = behind >= 1 ? `+${behind} lap${behind > 1 ? 's' : ''}` : 'Running';
    }
    const name = r.isPlayer ? 'YOU' : r.name;
    return `<tr class="${r.isPlayer ? 'me' : ''}"><td class="num">${i + 1}</td><td>${name}</td><td>${r.spec.name}</td><td class="num">${time}</td><td class="num">${formatTime(r.bestLap)}</td></tr>`;
  }).join('');
  $('res-table').innerHTML = `<tr><th>POS</th><th>DRIVER</th><th>CAR</th><th>TIME</th><th>BEST LAP</th></tr>${rows}`;
  $('results').classList.remove('hidden');
}

// ───────────── camera ─────────────
const _v = new THREE.Vector3(), _look = new THREE.Vector3();
function lerpAngle(a, b, t) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

function updateCamera(dt) {
  if (!player) {
    // showroom orbit
    if (!showroom) return;
    state.t += dt;
    const p = showroom.group.position;
    const a = state.t * 0.25 + 0.6;
    camera.position.set(p.x + Math.sin(a) * 7.2, 1.7, p.z + Math.cos(a) * 7.2);
    camera.lookAt(p.x, 0.65, p.z);
    camera.fov = 42;
    if (innerWidth > 760) camera.setViewOffset(innerWidth, innerHeight, -innerWidth * 0.17, 0, innerWidth, innerHeight);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    return;
  }

  const car = player;
  const H = car.model.dims.H;
  cam.shake = Math.max(0, cam.shake - dt * 3);
  if (car.impact > 2) cam.shake = Math.min(1, cam.shake + car.impact * 0.05);
  const shake = cam.shake * 0.25 + (car.surface !== 'road' ? Math.min(0.06, car.speed * 0.002) : 0);

  if (state.phase === 'finished') {
    state.t += dt;
    const a = state.t * 0.35;
    camera.position.set(car.pos.x + Math.sin(a) * 9, 2.6, car.pos.z + Math.cos(a) * 9);
    camera.lookAt(car.pos.x, 0.8, car.pos.z);
    camera.fov = 50;
    camera.updateProjectionMatrix();
    return;
  }

  const mode = CAM_MODES[camMode][0];
  cam.heading = lerpAngle(cam.heading, car.heading, 1 - Math.exp(-dt * (mode === 'far' ? 4 : 6)));
  const hd = mode === 'hood' || mode === 'bumper' ? car.heading : cam.heading;
  const fx = Math.sin(hd), fz = Math.cos(hd);
  const spd = car.speed;

  if (mode === 'chase' || mode === 'far') {
    const dist = mode === 'chase' ? 6.6 : 10.5;
    const height = mode === 'chase' ? 2.1 : 3.4;
    camera.position.set(car.pos.x - fx * dist, height, car.pos.z - fz * dist);
    _look.set(car.pos.x + fx * 4, 1.0, car.pos.z + fz * 4);
    camera.fov = 56 + Math.min(spd, 90) * 0.15;
  } else if (mode === 'hood') {
    camera.position.set(car.pos.x + fx * 0.3, 1.18 * H + 0.08, car.pos.z + fz * 0.3);
    _look.set(car.pos.x + fx * 30, 0.9, car.pos.z + fz * 30);
    camera.fov = 66 + Math.min(spd, 90) * 0.08;
  } else {
    camera.position.set(car.pos.x + fx * 2.35, 0.55, car.pos.z + fz * 2.35);
    _look.set(car.pos.x + fx * 30, 0.6, car.pos.z + fz * 30);
    camera.fov = 70 + Math.min(spd, 90) * 0.1;
  }
  if (shake > 0) camera.position.add(_v.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0));
  camera.lookAt(_look);
  // lean the horizon slightly in cockpit-style views
  if (mode === 'hood' || mode === 'bumper') camera.rotateZ(clamp(car.latAcc * 0.004, -0.04, 0.04));
  camera.updateProjectionMatrix();
}

// ───────────── main loop ─────────────
const wheels = [new THREE.Vector3(), new THREE.Vector3()];
let acc = 0;
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const inp = input.sample(dt);

  if (state.phase === 'paused') { renderer.render(scene, camera); return; }

  if (player) {
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < 12) { fixedStep(STEP, inp); acc -= STEP; n++; }
    if (n === 12) acc = 0;

    player.syncModel(dt);
    ais.forEach((a) => a.syncModel(dt));

    player.rearWheels(wheels);
    const sliding = player.slip > 0.35 && player.surface === 'road';
    skids.update(wheels, sliding);
    const dirt = player.surface !== 'road' && player.speed > 6;
    smoke.update(dt, wheels, sliding ? (player.slip - 0.35) * 1.6 : dirt ? Math.min(1, player.speed / 30) : 0,
      dirt ? (player.surface === 'sand' ? 0xcbb486 : 0x6b5a3d) : 0xdddddd, player.vel);

    if (player.impact > 1.5) audio.thud(player.impact);
    player.impact = 0;
    if (player.events.shift) { audio.shift(); player.events.shift = 0; }

    const order = standings();
    const t = track.tangents[player.trackIdx];
    const fwdDot = Math.sin(player.heading) * t.x + Math.cos(player.heading) * t.z;
    hud.update({
      car: player,
      position: order.indexOf(player) + 1,
      total: racers.length,
      lap: player.lap,
      laps: state.mode === 'race' ? TOTAL_LAPS : 0,
      cur: state.phase === 'countdown' ? 0 : state.phase === 'finished' ? player.lastLap : state.raceTime - player.lapStart,
      last: player.lastLap,
      best: player.bestLap,
      wrongWay: state.phase === 'racing' && fwdDot < -0.3 && player.speed > 4,
    });
    hud.drawMinimap(racers, player);

    if (state.phase === 'finished' && state.finishT > 3 && $('results').classList.contains('hidden')) showResults();

    sun.target.position.copy(player.pos);
  } else if (showroom) {
    sun.target.position.copy(showroom.group.position);
  }

  sun.position.copy(sun.target.position).addScaledVector(sunDir, 200);
  updateCamera(dt);
  if (player) audio.update(player, camera);
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

buildMenu();
toMenu();
$('loading').classList.add('hidden');
requestAnimationFrame(frame);

// handy for debugging from the console
window.__gtf = {
  state, track, startRace,
  get player() { return player; },
  get ais() { return ais; },
  // advance the simulation without rendering (for testing)
  tick(seconds, inp = { throttle: 0, brake: 0, steer: 0, handbrake: false }) {
    for (let k = 0; k < seconds / STEP && player; k++) fixedStep(STEP, typeof inp === 'function' ? inp(player) : inp);
  },
};
