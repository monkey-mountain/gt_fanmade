const $ = (id) => document.getElementById(id);

export function formatTime(t) {
  if (t == null || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export class HUD {
  constructor(track) {
    this.track = track;
    this.root = $('hud');
    this.el = {
      pos: $('pos-num'), posOf: $('pos-of'), lap: $('lap-num'), lapOf: $('lap-of'),
      cur: $('t-cur'), last: $('t-last'), best: $('t-best'),
      spd: $('spd'), gear: $('gear'), banner: $('banner'), wrong: $('wrongway'), cam: $('cam-label'),
    };
    this.tacho = $('tacho').getContext('2d');
    this.mini = $('minimap');
    this.mctx = this.mini.getContext('2d');
    this.prepMinimap();
    this.lastTach = -1;
  }

  show(v) { this.root.classList.toggle('hidden', !v); }

  prepMinimap() {
    const b = this.track.bounds;
    const size = 220, pad = 22;
    const w = b.max.x - b.min.x, h = b.max.z - b.min.z;
    const s = (size - pad * 2) / Math.max(w, h);
    const ox = (size - w * s) / 2 - b.min.x * s;
    const oz = (size - h * s) / 2 - b.min.z * s;
    this.map = (x, z) => [x * s + ox, z * s + oz];
    // cache the track outline
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.lineJoin = 'round';
    g.beginPath();
    this.track.points.forEach((p, i) => {
      const [x, y] = this.map(p.x, p.z);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.closePath();
    g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 9; g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 3.5; g.stroke();
    const [sx, sy] = this.map(this.track.points[0].x, this.track.points[0].z);
    g.fillStyle = '#e10600'; g.fillRect(sx - 6, sy - 1.5, 12, 3);
    this.mapBase = c;
  }

  drawMinimap(racers, player) {
    const g = this.mctx;
    g.clearRect(0, 0, 220, 220);
    g.drawImage(this.mapBase, 0, 0);
    for (const r of racers) {
      if (r === player) continue;
      const [x, y] = this.map(r.pos.x, r.pos.z);
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2);
      g.fillStyle = '#' + r.model.color.toString(16).padStart(6, '0');
      g.fill(); g.lineWidth = 1.2; g.strokeStyle = '#000'; g.stroke();
    }
    const [x, y] = this.map(player.pos.x, player.pos.z);
    g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2);
    g.fillStyle = '#ffd60a'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#000'; g.stroke();
  }

  drawTacho(rpm, redline) {
    const r100 = Math.round(rpm / 40);
    if (r100 === this.lastTach) return;
    this.lastTach = r100;
    const g = this.tacho, cx = 150, cy = 150, R = 128;
    const maxR = Math.ceil(redline / 1000) * 1000 + 1000;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const ang = (v) => a0 + ((a1 - a0) * v) / maxR;
    g.clearRect(0, 0, 300, 300);

    g.beginPath(); g.arc(cx, cy, R + 14, 0, Math.PI * 2);
    g.fillStyle = 'rgba(8,12,18,.72)'; g.fill();
    g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.14)'; g.stroke();

    g.lineCap = 'butt';
    g.beginPath(); g.arc(cx, cy, R - 4, ang(redline), ang(maxR));
    g.strokeStyle = 'rgba(225,6,0,.9)'; g.lineWidth = 10; g.stroke();

    const hot = rpm > redline * 0.93;
    g.beginPath(); g.arc(cx, cy, R - 16, a0, ang(Math.min(rpm, maxR)));
    g.strokeStyle = hot ? '#ff3b30' : 'rgba(255,255,255,.9)'; g.lineWidth = 6;
    g.shadowColor = hot ? '#ff3b30' : '#9fd3ff'; g.shadowBlur = 12; g.stroke(); g.shadowBlur = 0;

    g.fillStyle = '#fff'; g.font = '700 17px Orbitron, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let v = 0; v <= maxR; v += 500) {
      const a = ang(v), major = v % 1000 === 0;
      const r1 = R - (major ? 26 : 20);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.lineTo(cx + Math.cos(a) * (R - 10), cy + Math.sin(a) * (R - 10));
      g.strokeStyle = v >= redline ? '#ff5a4f' : 'rgba(255,255,255,.8)';
      g.lineWidth = major ? 3 : 1.5; g.stroke();
      if (major) {
        g.fillStyle = v >= redline ? '#ff5a4f' : '#fff';
        g.fillText(String(v / 1000), cx + Math.cos(a) * (R - 42), cy + Math.sin(a) * (R - 42));
      }
    }
    const a = ang(Math.min(rpm, maxR));
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * 34, cy + Math.sin(a) * 34);
    g.lineTo(cx + Math.cos(a) * (R - 8), cy + Math.sin(a) * (R - 8));
    g.strokeStyle = '#ff2a1f'; g.lineWidth = 4; g.lineCap = 'round'; g.stroke();
  }

  update({ car, position, total, lap, laps, cur, last, best, wrongWay }) {
    const e = this.el;
    e.pos.textContent = position;
    e.posOf.textContent = `/${total}`;
    e.lap.textContent = Math.max(1, Math.min(lap, laps || lap));
    e.lapOf.textContent = laps ? `/${laps}` : '';
    e.cur.textContent = formatTime(cur);
    e.last.textContent = formatTime(last);
    e.best.textContent = formatTime(best);
    e.spd.textContent = Math.round(car.speed * 3.6);
    e.gear.textContent = car.reverse ? 'R' : car.speed < 0.5 && car.throttle === 0 ? 'N' : String(car.gear + 1);
    e.gear.style.color = car.rpm > car.spec.redline * 0.93 ? '#ff3b30' : '#fff';
    e.wrong.classList.toggle('hidden', !wrongWay);
    this.drawTacho(car.rpm, car.spec.redline);
  }

  banner(text, cls = '') {
    const b = this.el.banner;
    b.className = '';
    b.textContent = text;
    void b.offsetWidth; // restart animation
    b.className = `pop ${cls}`;
  }

  camLabel(text) {
    const c = this.el.cam;
    c.textContent = text;
    c.classList.add('show');
    clearTimeout(this.camT);
    this.camT = setTimeout(() => c.classList.remove('show'), 1200);
  }
}
