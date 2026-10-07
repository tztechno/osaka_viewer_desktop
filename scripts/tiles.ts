// Shared 3D Tiles (b3dm) writer: geodesy helpers, building geometry and
// per-mesh tiles. Used by build-buildings.ts and build-osm-buildings.ts.
import earcut from 'earcut';
import type { Temple } from './temples.ts';

// KHR_mesh_quantization: positions stored as int16 * POS_SCALE metres (±1638 m).
const POS_SCALE = 0.05;

// ---------- geodesy ----------
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F);
export const RAD = Math.PI / 180;
export function ecef(lat: number, lon: number, h: number): [number, number, number] {
  const sl = Math.sin(lat * RAD), cl = Math.cos(lat * RAD);
  const N = A / Math.sqrt(1 - E2 * sl * sl);
  return [(N + h) * cl * Math.cos(lon * RAD), (N + h) * cl * Math.sin(lon * RAD), (N * (1 - E2) + h) * sl];
}
export function enuFrame(lat: number, lon: number) {
  const sl = Math.sin(lat * RAD), cl = Math.cos(lat * RAD), so = Math.sin(lon * RAD), co = Math.cos(lon * RAD);
  const o = ecef(lat, lon, 0);
  const e = [-so, co, 0], n = [-sl * co, -sl * so, cl], u = [cl * co, cl * so, sl];
  return {
    o, e, n, u,
    toEnu(p: number[]) {
      const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
      return [d[0] * e[0] + d[1] * e[1] + d[2] * e[2], d[0] * n[0] + d[1] * n[1] + d[2] * n[2], d[0] * u[0] + d[1] * u[1] + d[2] * u[2]];
    },
    // column-major 4x4 for tileset "transform"
    matrix: [e[0], e[1], e[2], 0, n[0], n[1], n[2], 0, u[0], u[1], u[2], 0, o[0], o[1], o[2], 1],
  };
}

// ---------- types ----------
export type Ring = number[][]; // [lat, lon, z][]
export interface Bldg {
  id: string; name: string; h: number; s: number; u: string; addr: string;
  solids: { ext: Ring; holes: Ring[]; zb: number; zt: number }[];
}
export interface Poly { ext: Ring; holes: Ring[] }

// ---------- geometry / b3dm ----------
// Walls and roof share vertices and carry no normals: the viewer derives flat
// normals from screen-space derivatives. Primitives are capped at 65535 vertices
// so all index buffers are 16-bit.
export const MAX_VERTS = 65535;
interface Prim { pos: number[]; bid: number[]; idx: number[]; min: number[]; max: number[] }

export class Geom {
  prims: Prim[] = [];
  // batch table: only what styling and labels-on-map need; the rest is fetched on click
  // t: 0 = ordinary, 1 = temple, 2 = shrine, 3 = other place of worship, 4 = castle
  props = { name: [] as string[], h: [] as number[], t: [] as number[] };
  attrs = { id: [] as string[], s: [] as number[], u: [] as string[], addr: [] as string[], tn: [] as string[] };
  geo = { w: Infinity, s: Infinity, e: -Infinity, n: -Infinity, lo: Infinity, hi: -Infinity };
  get count() { return this.props.name.length; }

  private prim(nv: number) {
    let p = this.prims[this.prims.length - 1];
    if (!p || p.pos.length / 3 + nv > MAX_VERTS) {
      p = { pos: [], bid: [], idx: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      this.prims.push(p);
    }
    return p;
  }

  private vert(p: Prim, enu: number[], b: number) {
    // glTF is y-up: (east, up, -north); Cesium rotates y-up to z-up for tiles.
    const q = [Math.round(enu[0] / POS_SCALE), Math.round(enu[2] / POS_SCALE), Math.round(-enu[1] / POS_SCALE)];
    for (let i = 0; i < 3; i++) {
      if (q[i] < -32767 || q[i] > 32767) throw new Error('position out of quantization range');
      if (q[i] < p.min[i]) p.min[i] = q[i];
      if (q[i] > p.max[i]) p.max[i] = q[i];
    }
    p.pos.push(q[0], q[1], q[2]);
    p.bid.push(b);
    return p.pos.length / 3 - 1;
  }

  add(b: Bldg, frame: ReturnType<typeof enuFrame>, temple?: Temple, lod2?: Poly[]) {
    const id = this.count;
    if (lod2?.length) this.addSurfaces(lod2, b, frame, id);
    else for (const s of b.solids) {
      for (const v of s.ext) {
        this.geo.w = Math.min(this.geo.w, v[1]); this.geo.e = Math.max(this.geo.e, v[1]);
        this.geo.s = Math.min(this.geo.s, v[0]); this.geo.n = Math.max(this.geo.n, v[0]);
      }
      this.geo.lo = Math.min(this.geo.lo, s.zb); this.geo.hi = Math.max(this.geo.hi, s.zt);
      // Rings in local ENU; exterior CCW, holes CW (seen from above).
      const toLocal = (r: Ring, z: number) => r.map(v => frame.toEnu(ecef(v[0], v[1], z)));
      const area = (r: number[][]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
      const rings: { bot: number[][]; top: number[][] }[] = [];
      [s.ext, ...s.holes].forEach((r, k) => {
        let bot = toLocal(r, s.zb), top = toLocal(r, s.zt);
        const ccw = area(bot) > 0;
        if ((k === 0) !== ccw) { bot = bot.reverse(); top = top.reverse(); }
        rings.push({ bot, top });
      });
      const nv = rings.reduce((a, r) => a + 2 * r.bot.length, 0);
      if (nv > MAX_VERTS) continue;
      const p = this.prim(nv);
      const tops: number[] = [];
      for (const { bot, top } of rings) {
        const bi = bot.map(v => this.vert(p, v, id)), ti = top.map(v => this.vert(p, v, id));
        tops.push(...ti);
        for (let i = 0; i < bot.length; i++) {
          const j = (i + 1) % bot.length;
          if (Math.hypot(bot[j][0] - bot[i][0], bot[j][1] - bot[i][1]) < 1e-3) continue;
          p.idx.push(bi[i], bi[j], ti[j], bi[i], ti[j], ti[i]);
        }
      }
      // roof (CCW from above)
      const flat: number[] = [], holes: number[] = [];
      rings.forEach((r, k) => { if (k) holes.push(flat.length / 2); for (const q of r.top) flat.push(q[0], q[1]); });
      const tri = earcut(flat, holes);
      for (const t of tri) p.idx.push(tops[t]);
    }
    this.props.name.push(b.name); this.props.h.push(Math.round(b.h * 10) / 10); this.props.t.push(temple?.rel ?? 0);
    this.attrs.id.push(b.id); this.attrs.s.push(b.s); this.attrs.u.push(b.u); this.attrs.addr.push(b.addr); this.attrs.tn.push(temple?.name ?? '');
  }

  /** Arbitrary planar 3D polygons (LOD2 surfaces), each triangulated in its own plane. */
  addSurfaces(polys: Poly[], b: Bldg, frame: ReturnType<typeof enuFrame>, id: number) {
    for (const b0 of b.solids) this.geo.lo = Math.min(this.geo.lo, b0.zb);
    for (const poly of polys) {
      const rings = [poly.ext, ...poly.holes].filter((r) => r.length >= 3);
      const loc = rings.map((r) => r.map((v) => {
        this.geo.w = Math.min(this.geo.w, v[1]); this.geo.e = Math.max(this.geo.e, v[1]);
        this.geo.s = Math.min(this.geo.s, v[0]); this.geo.n = Math.max(this.geo.n, v[0]);
        this.geo.lo = Math.min(this.geo.lo, v[2]); this.geo.hi = Math.max(this.geo.hi, v[2]);
        return frame.toEnu(ecef(v[0], v[1], v[2]));
      }));
      // Newell normal of the exterior picks the projection plane
      const nrm = [0, 0, 0], ex = loc[0];
      for (let i = 0; i < ex.length; i++) {
        const p = ex[i], q = ex[(i + 1) % ex.length];
        nrm[0] += (p[1] - q[1]) * (p[2] + q[2]); nrm[1] += (p[2] - q[2]) * (p[0] + q[0]); nrm[2] += (p[0] - q[0]) * (p[1] + q[1]);
      }
      if (Math.hypot(nrm[0], nrm[1], nrm[2]) < 1e-6) continue;
      const ax = [Math.abs(nrm[0]), Math.abs(nrm[1]), Math.abs(nrm[2])];
      const drop = ax[0] > ax[1] && ax[0] > ax[2] ? 0 : ax[1] > ax[2] ? 1 : 2;
      const [i0, i1] = [[1, 2], [2, 0], [0, 1]][drop];
      const flat: number[] = [], holes: number[] = [], all: number[][] = [];
      loc.forEach((r, k) => { if (k) holes.push(flat.length / 2); for (const v of r) { flat.push(v[i0], v[i1]); all.push(v); } });
      if (all.length > MAX_VERTS) continue;
      const tri = earcut(flat, holes);
      if (!tri.length) continue;
      const p = this.prim(all.length);
      const vi = all.map((v) => this.vert(p, v, id));
      // keep the source orientation (outward normal) for every triangle
      for (let t = 0; t < tri.length; t += 3) {
        const a = all[tri[t]], c1 = all[tri[t + 1]], c2 = all[tri[t + 2]];
        const u = [c1[0] - a[0], c1[1] - a[1], c1[2] - a[2]], w = [c2[0] - a[0], c2[1] - a[1], c2[2] - a[2]];
        const d = (u[1] * w[2] - u[2] * w[1]) * nrm[0] + (u[2] * w[0] - u[0] * w[2]) * nrm[1] + (u[0] * w[1] - u[1] * w[0]) * nrm[2];
        if (d >= 0) p.idx.push(vi[tri[t]], vi[tri[t + 1]], vi[tri[t + 2]]);
        else p.idx.push(vi[tri[t]], vi[tri[t + 2]], vi[tri[t + 1]]);
      }
    }
  }

  glb(): Buffer {
    const parts: Buffer[] = [], views: any[] = [], accessors: any[] = [], primitives: any[] = [];
    let off = 0;
    const view = (buf: Buffer, stride: number | undefined, target: number) => {
      const padded = buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf;
      views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, ...(stride ? { byteStride: stride } : {}), target });
      parts.push(padded); off += padded.length;
      return views.length - 1;
    };
    for (const p of this.prims) {
      const nv = p.pos.length / 3;
      const posB = Buffer.alloc(nv * 8), bidB = Buffer.alloc(nv * 4);
      for (let i = 0; i < nv; i++) {
        posB.writeInt16LE(p.pos[3 * i], 8 * i); posB.writeInt16LE(p.pos[3 * i + 1], 8 * i + 2); posB.writeInt16LE(p.pos[3 * i + 2], 8 * i + 4);
        bidB.writeUInt16LE(p.bid[i], 4 * i);
      }
      const a = accessors.length;
      accessors.push(
        { bufferView: view(posB, 8, 34962), componentType: 5122, count: nv, type: 'VEC3', min: p.min, max: p.max },
        { bufferView: view(bidB, 4, 34962), componentType: 5123, count: nv, type: 'SCALAR' },
        { bufferView: view(Buffer.from(new Uint16Array(p.idx).buffer), undefined, 34963), componentType: 5123, count: p.idx.length, type: 'SCALAR' },
      );
      primitives.push({ attributes: { POSITION: a, _BATCHID: a + 1 }, indices: a + 2, material: 0, mode: 4 });
    }
    const bin = Buffer.concat(parts);
    const json = {
      asset: { version: '2.0', generator: 'osaka_viewer' },
      extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'],
      scene: 0, scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, scale: [POS_SCALE, POS_SCALE, POS_SCALE] }],
      meshes: [{ primitives }],
      // double-sided: LOD2 surfaces are not always consistently oriented in the source data
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors,
    };
    let js = Buffer.from(JSON.stringify(json));
    if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]);
    const total = 12 + 8 + js.length + 8 + bin.length;
    const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(total, 8);
    const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
    return Buffer.concat([h, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]);
  }

  b3dm(): Buffer {
    const pad8 = (s: string, startAt: number) => { let b = Buffer.from(s); const r = (startAt + b.length) % 8; if (r) b = Buffer.concat([b, Buffer.alloc(8 - r, 0x20)]); return b; };
    const ft = pad8(JSON.stringify({ BATCH_LENGTH: this.count }), 28);
    const bt = pad8(JSON.stringify(this.props), 28 + ft.length);
    const glb = this.glb();
    const h = Buffer.alloc(28);
    h.write('b3dm', 0); h.writeUInt32LE(1, 4); h.writeUInt32LE(28 + ft.length + bt.length + glb.length, 8);
    h.writeUInt32LE(ft.length, 12); h.writeUInt32LE(0, 16); h.writeUInt32LE(bt.length, 20); h.writeUInt32LE(0, 24);
    return Buffer.concat([h, ft, bt, glb]);
  }

  region() { const g = this.geo; return [g.w * RAD, g.s * RAD, g.e * RAD, g.n * RAD, g.lo, g.hi]; }
}

// Japanese standard 3rd-level mesh code -> SW corner + size (deg)
export function meshBounds(code: string) {
  const p = +code.slice(0, 2), u = +code.slice(2, 4), q = +code[4], v = +code[5], r = +code[6], w = +code[7];
  const s = p / 1.5 + q / 12 + r / 120, west = u + 100 + v / 8 + w / 80;
  return { s, w: west, n: s + 1 / 120, e: west + 1 / 80 };
}

