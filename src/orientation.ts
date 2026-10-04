// Follow the phone's physical orientation: the camera looks out of the back of
// the device. Uses absolute (compass-referenced) orientation:
//   Android/Chrome: `deviceorientationabsolute`; iOS Safari: `webkitCompassHeading`.

export interface Enu { dir: [number, number, number]; up: [number, number, number] }

type OrientationEventWithCompass = DeviceOrientationEvent & { webkitCompassHeading?: number };

export class DeviceFollower {
  private handler?: (e: Event) => void;
  private eventName = '';
  private smooth?: Enu;
  offsetDeg = 0; // user heading correction
  onUpdate: (v: Enu) => void = () => {};

  get active() { return !!this.handler; }

  /** Must be called from a user gesture (iOS permission prompt). */
  async start(): Promise<boolean> {
    const DOE = (window as any).DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try { if ((await DOE.requestPermission()) !== 'granted') return false; } catch { return false; }
    }
    this.eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    this.smooth = undefined;
    this.handler = (ev: Event) => {
      const e = ev as OrientationEventWithCompass;
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      let alpha = e.alpha;
      if (typeof e.webkitCompassHeading === 'number') alpha = 360 - e.webkitCompassHeading;
      else if (this.eventName === 'deviceorientation' && !e.absolute) return; // relative only: unusable
      this.push(toEnu(alpha - this.offsetDeg, e.beta, e.gamma, screenAngle()));
    };
    window.addEventListener(this.eventName, this.handler);
    // fail if nothing arrives (desktop browsers, insecure context)
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        if (this.smooth) resolve(true);
        else if (Date.now() - t0 > 2500) { this.stop(); resolve(false); }
        else setTimeout(check, 100);
      };
      check();
    });
  }

  stop() {
    if (this.handler) window.removeEventListener(this.eventName, this.handler);
    this.handler = undefined;
  }

  private push(v: Enu) {
    if (!this.smooth) this.smooth = v;
    else {
      const k = 0.25;
      const mix = (a: number[], b: number[]) => normalize(a.map((x, i) => x + (b[i] - x) * k));
      this.smooth = { dir: mix(this.smooth.dir, v.dir), up: mix(this.smooth.up, v.up) };
    }
    this.onUpdate(this.smooth);
  }
}

function screenAngle() {
  return (screen.orientation?.angle ?? (window as any).orientation ?? 0) as number;
}

/** W3C device orientation (Z-X'-Y'' intrinsic) to camera vectors in East-North-Up. */
export function toEnu(alpha: number, beta: number, gamma: number, screenDeg: number): Enu {
  const r = Math.PI / 180;
  const cA = Math.cos(alpha * r), sA = Math.sin(alpha * r);
  const cB = Math.cos(beta * r), sB = Math.sin(beta * r);
  const cG = Math.cos(gamma * r), sG = Math.sin(gamma * r);
  // R = Rz(alpha) * Rx(beta) * Ry(gamma)
  const R = [
    [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
    [sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG],
    [-cB * sG, sB, cB * cG],
  ];
  const mul = (v: number[]) => [0, 1, 2].map((i) => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]) as [number, number, number];
  const s = screenDeg * r;
  return { dir: mul([0, 0, -1]), up: mul([Math.sin(s), Math.cos(s), 0]) };
}

function normalize(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
