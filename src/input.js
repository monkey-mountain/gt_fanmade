const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export class Input {
  constructor() {
    this.keys = new Set();
    this.steer = 0;
    this.onPress = null;
    this.padPrev = [];
    addEventListener('keydown', (e) => {
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.onPress?.(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  sample(dt) {
    const k = this.keys;
    let throttle = k.has('ArrowUp') || k.has('KeyW') ? 1 : 0;
    let brake = k.has('ArrowDown') || k.has('KeyS') ? 1 : 0;
    let handbrake = k.has('Space');
    const target = (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0) - (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0);

    // keyboard steering ramps in, snaps back faster
    const reversing = target !== 0 && Math.sign(target) !== Math.sign(this.steer) && this.steer !== 0;
    const rate = target === 0 ? 6 : reversing ? 9 : 3.4;
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);
    let steer = this.steer;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find((p) => p && p.connected);
    if (gp) {
      const ax = gp.axes[0] || 0;
      if (Math.abs(ax) > 0.08) steer = -Math.sign(ax) * ((Math.abs(ax) - 0.08) / 0.92) ** 1.4;
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      if (rt > 0.04) throttle = Math.max(throttle, rt);
      if (lt > 0.04) brake = Math.max(brake, lt);
      if (gp.buttons[1]?.pressed) handbrake = true;
      // edge-triggered buttons: Y camera, Start pause, Back reset
      const map = { 3: 'KeyC', 9: 'Escape', 8: 'KeyR', 0: 'Enter' };
      for (const [i, code] of Object.entries(map)) {
        const p = !!gp.buttons[i]?.pressed;
        if (p && !this.padPrev[i]) this.onPress?.(code);
        this.padPrev[i] = p;
      }
    }
    return { throttle, brake, steer, handbrake };
  }
}
