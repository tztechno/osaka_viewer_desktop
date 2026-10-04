// Name labels for peaks, landmarks, stations and facilities.
// Peak labels are drawn on top of everything; other labels are depth tested so
// nearer buildings hide them. Visibility is also decided here:
// distance limit by rank, a terrain line-of-sight test (with earth curvature), and
// greedy decluttering so higher-ranked / nearer labels win.
import {
  Cartesian2, Cartesian3, Cartographic, Color, HorizontalOrigin, Label, LabelCollection, LabelStyle,
  NearFarScalar, Scene, VerticalOrigin,
} from 'cesium';
import type { Dem } from './terrain';
import { getLang } from './i18n';

export type Kind = 'p' | 'l' | 's' | 'f';
export interface LabelData { k: Kind; ja: string; en: string; lat: number; lon: number; z: number; r: 1 | 2 | 3; e?: number }

// Max display distance (m) per kind, indexed by rank-1.
const MAX_DIST: Record<Kind, [number, number, number]> = {
  p: [160000, 50000, 12000],
  l: [45000, 12000, 3500],
  s: [8000, 6000, 3000],
  f: [6000, 4000, 1500],
};
const COLORS: Record<Kind, Color> = {
  p: Color.fromCssColorString('#ffe08a'),
  l: Color.WHITE,
  s: Color.fromCssColorString('#a6e4ff'),
  f: Color.fromCssColorString('#e3e3e3'),
};
const MOBILE = matchMedia('(pointer: coarse)').matches;
const FONT_PX = MOBILE ? [15, 13, 12] : [17, 15, 13];
const MAX_VISIBLE = MOBILE ? 40 : 70;

interface Entry { d: LabelData; pos: Cartesian3; label: Label; px: number; w: number; h: number }

export class Labels {
  private collection = new LabelCollection();
  private entries: Entry[] = [];
  readonly enabled: Record<Kind, boolean> = { p: true, l: true, s: true, f: true };
  private _all = true;
  private lastCam = new Cartesian3();
  private lastDir = new Cartesian3();
  private lastRun = 0;
  private dirty = true;

  constructor(private scene: Scene, private dem: Dem) {
    scene.primitives.add(this.collection);
    scene.postRender.addEventListener(() => this.update());
  }

  async load(url: string) {
    const data: LabelData[] = await (await fetch(url)).json();
    for (const d of data) {
      const pos = Cartesian3.fromDegrees(d.lon, d.lat, d.z);
      const px = FONT_PX[d.r - 1] - (d.k === 'f' ? 1 : 0);
      const label = this.collection.add({
        position: pos,
        text: '',
        font: `600 ${px}px "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif`,
        fillColor: COLORS[d.k],
        outlineColor: Color.fromCssColorString('#111').withAlpha(0.9),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        horizontalOrigin: HorizontalOrigin.CENTER,
        pixelOffset: new Cartesian2(0, -2),
        // peaks: always on top (terrain occlusion is tested below); others hide behind buildings
        disableDepthTestDistance: d.k === 'p' ? Number.POSITIVE_INFINITY : 0,
        scaleByDistance: new NearFarScalar(2000, 1.0, 80000, 0.8),
        show: false,
        id: d,
      });
      this.entries.push({ d, pos, label, px, w: 0, h: 0 });
    }
    this.applyLang();
  }

  get all() { return this._all; }
  set all(v: boolean) { this._all = v; this.invalidate(); }
  setKind(k: Kind, v: boolean) { this.enabled[k] = v; this.invalidate(); }
  invalidate() { this.dirty = true; this.scene.requestRender(); }

  text(d: LabelData) {
    const name = getLang() === 'ja' ? d.ja : d.en;
    return d.k === 'p' ? `${name}${d.e ? ` ${d.e}m` : ''}` : name;
  }

  /** Label text with a pointer underneath whose tip sits on the anchor point. */
  private display(d: LabelData) {
    return `${this.text(d)}\n▼`;
  }

  applyLang() {
    for (const e of this.entries) {
      e.label.text = this.display(e.d);
      const px = e.px;
      // rough text width: CJK ~1em, Latin ~0.58em (the pointer line is narrower than the name)
      let w = 0;
      for (const ch of this.text(e.d)) w += ch.charCodeAt(0) > 0x2e80 ? px : px * 0.58;
      e.w = w + 8;
      e.h = px * 2.4 + 6; // name line + pointer line
    }
    this.invalidate();
  }

  private update() {
    const now = performance.now();
    const cam = this.scene.camera;
    const moved = !Cartesian3.equalsEpsilon(cam.positionWC, this.lastCam, 0, 0.5) || !Cartesian3.equalsEpsilon(cam.directionWC, this.lastDir, 1e-4);
    if (!this.dirty && !moved) return;
    if (now - this.lastRun < 120) { this.scene.requestRender(); return; } // try again on a later frame
    this.lastRun = now;
    this.dirty = false;
    Cartesian3.clone(cam.positionWC, this.lastCam);
    Cartesian3.clone(cam.directionWC, this.lastDir);

    const camPos = cam.positionWC, dir = cam.directionWC;
    const candidates: { e: Entry; dist: number }[] = [];
    const tmp = new Cartesian3();
    for (const e of this.entries) {
      if (!this._all || !this.enabled[e.d.k]) continue;
      const dist = Cartesian3.distance(camPos, e.pos);
      if (dist > MAX_DIST[e.d.k][e.d.r - 1]) continue;
      Cartesian3.subtract(e.pos, camPos, tmp);
      if (Cartesian3.dot(tmp, dir) <= 0) continue;
      candidates.push({ e, dist });
    }
    candidates.sort((a, b) => a.e.d.r - b.e.d.r || a.dist - b.dist);

    const canvas = this.scene.canvas;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const boxes: number[][] = [];
    const visible = new Set<Entry>();
    const win = new Cartesian2();
    for (const { e, dist } of candidates) {
      if (boxes.length >= MAX_VISIBLE) break;
      const p = this.scene.cartesianToCanvasCoordinates(e.pos, win);
      if (!p || p.x < -e.w / 2 || p.x > W + e.w / 2 || p.y < 0 || p.y > H + 20) continue;
      const scale = dist > 2000 ? Math.max(0.8, 1 - (0.2 * (dist - 2000)) / 78000) : 1;
      const w = e.w * scale, h = e.h * scale;
      const box = [p.x - w / 2, p.y - h - 2, p.x + w / 2, p.y - 2];
      if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      if (!this.lineOfSight(camPos, e.pos, dist)) continue;
      boxes.push(box);
      visible.add(e);
    }
    let changed = false;
    for (const e of this.entries) {
      const v = visible.has(e);
      if (e.label.show !== v) { e.label.show = v; changed = true; }
    }
    if (changed) this.scene.requestRender();
  }

  /** True if no terrain blocks the straight line between camera and label. */
  private lineOfSight(from: Cartesian3, to: Cartesian3, dist: number) {
    const steps = Math.min(48, Math.max(8, Math.round(dist / 400)));
    const p = new Cartesian3(), c = new Cartographic();
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      Cartesian3.lerp(from, to, f, p);
      if (!Cartographic.fromCartesian(p, undefined, c)) continue;
      const lon = c.longitude * 57.29577951308232, lat = c.latitude * 57.29577951308232;
      // allow a few metres of slack: coarse terrain and the label anchor sit near the surface
      if (this.dem.heightNow(lon, lat) > c.height + 3 + f * 8) return false;
    }
    return true;
  }
}
