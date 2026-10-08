import * as THREE from 'three';

// Ring buffer of quads laid down behind sliding tyres.
export class SkidMarks {
  constructor(scene, max = 2500) {
    this.max = max;
    this.next = 0;
    this.filled = 0;
    this.pos = new Float32Array(max * 4 * 3);
    const idx = new Uint32Array(max * 6);
    for (let q = 0; q < max; q++) {
      const v = q * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], q * 6);
    }
    this.geo = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.attr);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({
      color: 0x0c0c0c, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.last = [null, null];
  }

  update(wheels, active) {
    for (let k = 0; k < wheels.length; k++) {
      const w = wheels[k];
      if (!active) { this.last[k] = null; continue; }
      const prev = this.last[k];
      if (!prev) { this.last[k] = w.clone(); continue; }
      const dx = w.x - prev.x, dz = w.z - prev.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35) continue;
      if (d > 4) { prev.copy(w); continue; }
      const nx = (-dz / d) * 0.13, nz = (dx / d) * 0.13, y = 0.065;
      const o = this.next * 12;
      this.pos.set([
        prev.x + nx, y, prev.z + nz, prev.x - nx, y, prev.z - nz,
        w.x + nx, y, w.z + nz, w.x - nx, y, w.z - nz,
      ], o);
      this.next = (this.next + 1) % this.max;
      this.filled = Math.min(this.max, this.filled + 1);
      prev.copy(w);
      this.dirty = true;
    }
    if (this.dirty) {
      this.attr.needsUpdate = true;
      this.geo.setDrawRange(0, this.filled * 6);
      this.dirty = false;
    }
  }

  clear() {
    this.pos.fill(0);
    this.attr.needsUpdate = true;
    this.filled = 0; this.next = 0;
    this.geo.setDrawRange(0, 0);
    this.last = [null, null];
  }
}

// Pooled sprite puffs for tyre smoke and dirt.
export class Smoke {
  constructor(scene, count = 70) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    this.parts = [];
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      scene.add(s);
      this.parts.push({ s, life: 0, max: 1, vel: new THREE.Vector3() });
    }
    this.i = 0;
    this.acc = 0;
  }

  emit(p, color, vel) {
    const q = this.parts[this.i];
    this.i = (this.i + 1) % this.parts.length;
    q.s.position.set(p.x + (Math.random() - 0.5) * 0.4, 0.35, p.z + (Math.random() - 0.5) * 0.4);
    q.s.material.color.set(color);
    q.vel.set(vel.x * 0.25 + (Math.random() - 0.5), 0.8 + Math.random() * 0.6, vel.z * 0.25 + (Math.random() - 0.5));
    q.life = q.max = 1.1 + Math.random() * 0.6;
    q.s.visible = true;
  }

  update(dt, wheels, intensity, color, vel) {
    if (intensity > 0) {
      this.acc += dt * 40 * intensity;
      while (this.acc > 1) {
        this.acc -= 1;
        this.emit(wheels[Math.random() < 0.5 ? 0 : 1], color, vel);
      }
    }
    for (const q of this.parts) {
      if (q.life <= 0) continue;
      q.life -= dt;
      if (q.life <= 0) { q.s.visible = false; continue; }
      const t = 1 - q.life / q.max;
      q.s.position.addScaledVector(q.vel, dt);
      q.vel.multiplyScalar(1 - dt * 1.5);
      const sc = 0.8 + t * 4;
      q.s.scale.set(sc, sc, sc);
      q.s.material.opacity = 0.45 * (1 - t);
    }
  }

  clear() {
    for (const q of this.parts) { q.life = 0; q.s.visible = false; }
  }
}
