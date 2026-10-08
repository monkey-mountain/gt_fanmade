import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Original fictional circuit ("Monkey Mountain Raceway"), defined as control points in metres.
const SCALE = 1.6;
const CONTROL = [
  [0, -30], [0, -130], [6, -225], [40, -300], [110, -332], [180, -300], [202, -232],
  [172, -165], [130, -122], [148, -62], [228, -40], [300, -82], [360, -62],
  [392, 18], [362, 100], [272, 132], [182, 108], [112, 142], [50, 128], [8, 80], [0, 30],
];

const ROAD_Y = 0.05;
const CURB_Y = 0.07;

// Deterministic RNG so the scenery is identical every load.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTex(w, h, draw, { repeat = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function speckle(g, w, h, amount, rand = Math.random) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

function textBoard(text, bg, fg, w = 512, h = 128) {
  return canvasTex(w, h, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.font = `italic 900 ${Math.floor(h * 0.55)}px Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 2);
  }, { repeat: false });
}

export class Track {
  constructor() {
    this.width = 15;
    this.half = this.width / 2;
    this.wallOffset = this.half + 7.5;

    const pts = CONTROL.map(([x, z]) => new THREE.Vector3(x * SCALE, 0, z * SCALE));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this.curve.arcLengthDivisions = 4000;
    this.length = this.curve.getLength();
    this.N = Math.round(this.length / 2);
    this.seg = this.length / this.N;
    this.points = this.curve.getSpacedPoints(this.N).slice(0, this.N);

    const N = this.N;
    this.tangents = [];
    this.normals = []; // points to the driver's right
    for (let i = 0; i < N; i++) {
      const a = this.points[(i - 1 + N) % N], b = this.points[(i + 1) % N];
      const t = new THREE.Vector3().subVectors(b, a).normalize();
      this.tangents.push(t);
      this.normals.push(new THREE.Vector3(-t.z, 0, t.x));
    }

    // Signed curvature (+ = right-hander) and its magnitude.
    const K = 5;
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t1 = this.tangents[(i - K + N) % N], t2 = this.tangents[(i + K) % N];
      const cross = t1.x * t2.z - t1.z * t2.x;
      raw[i] = Math.asin(THREE.MathUtils.clamp(cross, -1, 1)) / (2 * K * this.seg);
    }
    this.scurv = new Float32Array(N);
    this.curv = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -3; k <= 3; k++) s += raw[(i + k + N) % N];
      this.scurv[i] = s / 7;
      this.curv[i] = Math.abs(this.scurv[i]);
    }

    this.corner = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let k = -14; k <= 14; k++) m = Math.max(m, this.curv[(i + k + N) % N]);
      this.corner[i] = m > 0.0065 ? 1 : 0;
    }

    const box = new THREE.Box3().setFromPoints(this.points);
    this.bounds = box;
    this.center = box.getCenter(new THREE.Vector3());
  }

  headingAt(i) {
    const t = this.tangents[((i % this.N) + this.N) % this.N];
    return Math.atan2(t.x, t.z);
  }

  // Grid slot k (0 = pole). Returns sample index and lateral offset.
  gridSlot(k, solo = false) {
    return { index: this.N - 5 - k * 5, lateral: solo ? 0 : (k % 2 === 0 ? -3.3 : 3.3) };
  }

  // Nearest centre-line sample to pos. `hint` restricts the search to a local window.
  project(pos, hint) {
    const N = this.N;
    let best = 0, bd = Infinity;
    const full = hint == null;
    const range = 40;
    const count = full ? N : range * 2 + 1;
    const start = full ? 0 : hint - range;
    for (let k = 0; k < count; k++) {
      const i = (((start + k) % N) + N) % N;
      const p = this.points[i];
      const dx = pos.x - p.x, dz = pos.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    const p = this.points[best], n = this.normals[best], t = this.tangents[best];
    const dx = pos.x - p.x, dz = pos.z - p.z;
    return { index: best, lateral: dx * n.x + dz * n.z, along: dx * t.x + dz * t.z };
  }

  // Interpolated frame at fractional sample index s.
  sample(s, outPos, outTan, outNorm) {
    const N = this.N;
    const f = ((s % N) + N) % N;
    const i = Math.floor(f), j = (i + 1) % N, a = f - i;
    outPos.lerpVectors(this.points[i], this.points[j], a);
    if (outTan) outTan.lerpVectors(this.tangents[i], this.tangents[j], a).normalize();
    if (outNorm) outNorm.lerpVectors(this.normals[i], this.normals[j], a).normalize();
    return i;
  }

  // Strip along the track between lateral offsets a (left) and b (right).
  ribbon(a, b, ya, yb, vScale, filter) {
    const N = this.N;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const k = i % N, p = this.points[k], n = this.normals[k];
      pos.push(p.x + n.x * a, p.y + ya, p.z + n.z * a, p.x + n.x * b, p.y + yb, p.z + n.z * b);
      const v = (i * this.seg) / vScale;
      uv.push(0, v, 1, v);
    }
    for (let i = 0; i < N; i++) {
      if (filter && !filter(i)) continue;
      const l0 = 2 * i, r0 = 2 * i + 1, l1 = 2 * i + 2, r1 = 2 * i + 3;
      idx.push(l0, r0, l1, r0, r1, l1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  minDistance(x, z, step = 3) {
    let bd = Infinity;
    for (let i = 0; i < this.N; i += step) {
      const p = this.points[i];
      const d = (x - p.x) ** 2 + (z - p.z) ** 2;
      if (d < bd) bd = d;
    }
    return Math.sqrt(bd);
  }

  build(scene) {
    const { half, N } = this;
    const rand = rng(1337);

    // ── Ground ──
    const grassTex = canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = '#4d7c35'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#558a3a'; g.fillRect(0, 0, w / 2, h);
      speckle(g, w, h, 30, rand);
    });
    grassTex.repeat.set(500, 500);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(8000, 8000),
      new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(this.center.x, 0, this.center.z);
    ground.receiveShadow = true;
    scene.add(ground);

    // ── Road ──
    const asphalt = canvasTex(256, 512, (g, w, h) => {
      g.fillStyle = '#37393c'; g.fillRect(0, 0, w, h);
      speckle(g, w, h, 26, rand);
      // darker rubbered-in racing groove
      g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(w * 0.3, 0, w * 0.4, h);
      g.fillStyle = '#e9e9e9';
      g.fillRect(5, 0, 5, h); g.fillRect(w - 10, 0, 5, h);
    });
    const road = new THREE.Mesh(this.ribbon(-half, half, ROAD_Y, ROAD_Y, 30),
      new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.88 }));
    road.receiveShadow = true;
    scene.add(road);

    // ── Curbs & gravel (corners only) ──
    const curbTex = canvasTex(32, 64, (g, w, h) => {
      g.fillStyle = '#d01f2b'; g.fillRect(0, 0, w, h / 2);
      g.fillStyle = '#f2f2f2'; g.fillRect(0, h / 2, w, h / 2);
    });
    const curbMat = new THREE.MeshStandardMaterial({ map: curbTex, roughness: 0.65 });
    const inCorner = (i) => this.corner[i] === 1;
    for (const [a, b] of [[-half - 1.4, -half], [half, half + 1.4]]) {
      const m = new THREE.Mesh(this.ribbon(a, b, CURB_Y, CURB_Y, 6, inCorner), curbMat);
      m.receiveShadow = true;
      scene.add(m);
    }
    const sandTex = canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = '#cbb486'; g.fillRect(0, 0, w, h);
      speckle(g, w, h, 34, rand);
    });
    const sandMat = new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1 });
    for (const [a, b] of [[-half - 7, -half - 1.4], [half + 1.4, half + 7]]) {
      const m = new THREE.Mesh(this.ribbon(a, b, ROAD_Y - 0.01, ROAD_Y - 0.01, 10, inCorner), sandMat);
      m.receiveShadow = true;
      scene.add(m);
    }

    // ── Armco barriers ──
    const wallTex = canvasTex(64, 64, (g, w, h) => {
      g.fillStyle = '#c4cad1'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#8c939b'; g.fillRect(0, h * 0.3, w, 3); g.fillRect(0, h * 0.62, w, 3);
      g.fillStyle = '#1f4fa8'; g.fillRect(0, 0, w, 6);
    });
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, metalness: 0.55, roughness: 0.4, side: THREE.DoubleSide });
    for (const off of [-this.wallOffset, this.wallOffset]) {
      const m = new THREE.Mesh(this.ribbon(off, off, 0, 1.1, 4), wallMat);
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
    }

    this.buildStart(scene);
    this.buildGrandstand(scene, rand);
    this.buildPits(scene);
    this.buildBillboards(scene);
    this.buildTrees(scene, rand);
    this.buildMountains(scene, rand);
  }

  frameAt(i) {
    const p = this.points[((i % this.N) + this.N) % this.N];
    return { p, n: this.normals[((i % this.N) + this.N) % this.N], h: this.headingAt(i) };
  }

  buildStart(scene) {
    const { p, n, h } = this.frameAt(0);
    const checker = canvasTex(160, 16, (g, w, hh) => {
      const s = 8;
      for (let x = 0; x < w; x += s) for (let y = 0; y < hh; y += s) {
        g.fillStyle = ((x + y) / s) % 2 === 0 ? '#111' : '#f5f5f5';
        g.fillRect(x, y, s, s);
      }
    }, { repeat: false });
    const lineGeo = new THREE.PlaneGeometry(this.width, 1.5).rotateX(-Math.PI / 2);
    const line = new THREE.Mesh(lineGeo, new THREE.MeshStandardMaterial({ map: checker, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1 }));
    line.position.set(p.x, ROAD_Y + 0.005, p.z);
    line.rotation.y = h;
    line.receiveShadow = true;
    scene.add(line);

    // grid boxes
    const gridMat = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -1 });
    for (let k = 0; k < 6; k++) {
      const slot = this.gridSlot(k);
      const f = this.frameAt(slot.index + 1);
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.25).rotateX(-Math.PI / 2), gridMat);
      bar.position.set(f.p.x + f.n.x * slot.lateral, ROAD_Y + 0.005, f.p.z + f.n.z * slot.lateral);
      bar.rotation.y = f.h;
      scene.add(bar);
    }

    // gantry
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x2a2f36, metalness: 0.7, roughness: 0.4 });
    const span = this.width + 6;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8, 0.6), steel);
      post.position.set(s * span / 2, 4, 0);
      post.castShadow = true;
      g.add(post);
    }
    const beamTex = textBoard('GT FANMADE · START', '#b30000', '#ffffff', 1024, 96);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 0.6, 1.6, 0.8),
      [steel, steel, steel, steel, new THREE.MeshStandardMaterial({ map: beamTex, emissive: 0x220000 }), new THREE.MeshStandardMaterial({ map: beamTex, emissive: 0x220000 })]);
    beam.position.y = 7.6;
    beam.castShadow = true;
    g.add(beam);
    // start lights
    this.startLights = [];
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff0000, emissiveIntensity: 0 });
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), mat);
      l.position.set((i - 2) * 0.9, 6.5, 0);
      g.add(l);
      this.startLights.push(mat);
    }
    g.position.set(p.x, 0, p.z);
    g.rotation.y = h;
    scene.add(g);
  }

  setStartLights(count, green = false) {
    this.startLights.forEach((m, i) => {
      m.emissive.set(green ? 0x22ff44 : 0xff1a00);
      m.emissiveIntensity = green ? 3 : (i < count ? 3 : 0);
    });
  }

  buildGrandstand(scene, rand) {
    const { p, n, h } = this.frameAt(12);
    const g = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.9 });
    const length = 110, rows = 9;
    for (let r = 0; r < rows; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.55 * (r + 1), length), concrete);
      step.position.set(-(r * 1.3), 0.275 * (r + 1), 0);
      step.castShadow = true; step.receiveShadow = true;
      g.add(step);
    }
    // crowd
    const per = Math.floor(length / 0.62);
    const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.75, 0.42),
      new THREE.MeshStandardMaterial({ roughness: 0.9 }), rows * per);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    const shirts = [0xe63946, 0xf1faee, 0x457b9d, 0xffb703, 0x2a9d8f, 0x222222, 0xff006e, 0x8ecae6];
    let c = 0;
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < per; k++) {
        if (rand() < 0.18) continue;
        m4.makeTranslation(-(r * 1.3), 0.55 * (r + 1) + 0.37 + rand() * 0.08, -length / 2 + 0.4 + k * 0.62);
        crowd.setMatrixAt(c, m4);
        crowd.setColorAt(c, col.setHex(shirts[Math.floor(rand() * shirts.length)]));
        c++;
      }
    }
    crowd.count = c;
    g.add(crowd);
    // roof
    const roof = new THREE.Mesh(new THREE.BoxGeometry(14, 0.4, length + 4), new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 }));
    roof.position.set(-5, 10.5, 0); roof.rotation.z = -0.08; roof.castShadow = true;
    g.add(roof);
    for (let z = -length / 2; z <= length / 2; z += 18) {
      const col2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 11, 0.5), concrete);
      col2.position.set(-11.5, 5.5, z); col2.castShadow = true;
      g.add(col2);
    }
    const off = -(this.wallOffset + 3);
    g.position.set(p.x + n.x * off, 0, p.z + n.z * off);
    // Local z runs along the track; local +x points to the driver's left. Mirror x so the
    // rows (built towards -x) climb away from the circuit.
    g.rotation.y = h;
    g.scale.x = -1;
    scene.add(g);
  }

  buildPits(scene) {
    const { p, n, h } = this.frameAt(14);
    const g = new THREE.Group();
    const winTex = canvasTex(256, 64, (gg, w, hh) => {
      gg.fillStyle = '#f2f2f2'; gg.fillRect(0, 0, w, hh);
      gg.fillStyle = '#1b2735';
      for (let x = 6; x < w; x += 32) gg.fillRect(x, 10, 24, 22);
      gg.fillStyle = '#c1121f'; gg.fillRect(0, hh - 12, w, 6);
    });
    winTex.repeat.set(4, 1);
    const side = new THREE.MeshStandardMaterial({ map: winTex, roughness: 0.6 });
    const plain = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.7 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(12, 7, 100), [side, side, plain, plain, plain, plain]);
    b.position.set(0, 3.5, 0);
    b.castShadow = true; b.receiveShadow = true;
    g.add(b);
    const off = this.wallOffset + 9;
    g.position.set(p.x + n.x * off, 0, p.z + n.z * off);
    g.rotation.y = h;
    scene.add(g);
  }

  buildBillboards(scene) {
    const brands = [
      ['TURBO COLA', '#d62828', '#fff'], ['APEX OIL', '#003049', '#fcbf49'], ['MONKEY TYRES', '#111', '#ffd60a'],
      ['NITRO NOODLES', '#f77f00', '#fff'], ['HYPERWATCH', '#fff', '#111'], ['ZENITH FUEL', '#2b9348', '#fff'],
    ];
    const post = new THREE.MeshStandardMaterial({ color: 0x444a52, metalness: 0.5, roughness: 0.5 });
    const count = 10;
    for (let k = 0; k < count; k++) {
      // find the next corner entry after an evenly spaced position
      let i = Math.floor((k / count) * this.N);
      for (let s = 0; s < 120 && !this.corner[i % this.N]; s++) i++;
      i %= this.N;
      const { p, n } = this.frameAt(i);
      const outside = -Math.sign(this.scurv[(i + 20) % this.N]) || 1;
      const off = outside * (this.wallOffset + 2.5);
      const [text, bg, fg] = brands[k % brands.length];
      const board = new THREE.Mesh(new THREE.PlaneGeometry(10, 2.5),
        new THREE.MeshStandardMaterial({ map: textBoard(text, bg, fg), roughness: 0.6, side: THREE.DoubleSide }));
      board.position.set(p.x + n.x * off, 3.2, p.z + n.z * off);
      const face = new THREE.Vector3(-n.x * outside, 0, -n.z * outside);
      board.rotation.y = Math.atan2(face.x, face.z);
      board.castShadow = true;
      scene.add(board);
      for (const s of [-4, 4]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2, 0.2), post);
        leg.position.copy(board.position).add(new THREE.Vector3(Math.cos(board.rotation.y) * s, -2.2, -Math.sin(board.rotation.y) * s));
        scene.add(leg);
      }
    }
  }

  buildTrees(scene, rand) {
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 2.4, 6).translate(0, 1.2, 0);
    const leafGeo = mergeGeometries([
      new THREE.ConeGeometry(2.3, 4.6, 8).translate(0, 4.2, 0),
      new THREE.ConeGeometry(1.7, 3.6, 8).translate(0, 6.2, 0),
    ]);
    const count = 1600;
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a3d26, roughness: 1 }), count);
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), count);
    leaves.castShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), c = new THREE.Color();
    const b = this.bounds, margin = 320;
    let placed = 0, tries = 0;
    const minGap = this.wallOffset + 14;
    while (placed < count && tries < count * 8) {
      tries++;
      const x = b.min.x - margin + rand() * (b.max.x - b.min.x + margin * 2);
      const z = b.min.z - margin + rand() * (b.max.z - b.min.z + margin * 2);
      if (this.minDistance(x, z) < minGap) continue;
      const sc = 0.8 + rand() * 0.9;
      q.setFromAxisAngle(v.set(0, 1, 0), rand() * Math.PI * 2);
      m4.compose(v.set(x, 0, z), q, s.set(sc, sc * (0.85 + rand() * 0.4), sc));
      trunks.setMatrixAt(placed, m4);
      leaves.setMatrixAt(placed, m4);
      leaves.setColorAt(placed, c.setHSL(0.27 + rand() * 0.08, 0.45 + rand() * 0.2, 0.18 + rand() * 0.12));
      placed++;
    }
    trunks.count = leaves.count = placed;
    scene.add(trunks, leaves);
  }

  buildMountains(scene, rand) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x6b8574, roughness: 1, flatShading: true });
    const snow = new THREE.MeshStandardMaterial({ color: 0xf2f5f7, roughness: 0.9, flatShading: true });
    for (let k = 0; k < 34; k++) {
      const a = (k / 34) * Math.PI * 2 + rand() * 0.1;
      const r = 1500 + rand() * 500;
      const hgt = 160 + rand() * 260;
      const rad = 220 + rand() * 260;
      const m = new THREE.Mesh(new THREE.ConeGeometry(rad, hgt, 7 + Math.floor(rand() * 4)), mat);
      m.position.set(this.center.x + Math.cos(a) * r, hgt / 2 - 5, this.center.z + Math.sin(a) * r);
      m.rotation.y = rand() * Math.PI;
      scene.add(m);
      if (hgt > 300) {
        const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.28, hgt * 0.28, 7), snow);
        cap.position.copy(m.position).setY(hgt - 5 - hgt * 0.14 + 0.5);
        cap.rotation.y = m.rotation.y;
        scene.add(cap);
      }
    }
  }
}
