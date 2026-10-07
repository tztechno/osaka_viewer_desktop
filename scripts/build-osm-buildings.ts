// Fill the grounds of temples, shrines and castles with OpenStreetMap buildings where
// PLATEAU has none, and observation towers PLATEAU leaves out (Tsutenkaku). Footprints are extruded to the OSM height
// (or a default) and get a simple roof: hipped, gabled or pyramidal.
//
//   node scripts/build-osm-buildings.ts    (run fetch-osm, build-buildings, build-terrain first)
//
// Output:
//   public/data/osmbldg/tileset.json, <mesh>.b3dm, <mesh>.json (same layout as public/data/bldg)
//   build/osm-bldg-index.bin   lat, lon, base, top per building (Float64)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemples, templeIndex, pointInRing, type Temple } from './temples.ts';
import { Geom, enuFrame, meshBounds, RAD, type Bldg, type Poly, type Ring } from './tiles.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/data/osmbldg');
const B = (f: string) => join(ROOT, 'build', f);
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

// ---------- terrain sampling (corrected DEM, decimetres) ----------
const TDIR = join(ROOT, 'public/data/terrain');
const meta = json(join(TDIR, 'meta.json'));
const chunks = new Map<string, Int16Array>();
function groundAt(lat: number, lon: number) {
  const row = Math.max(0, Math.min(meta.height - 1, Math.floor((meta.north - lat) / meta.res)));
  const col = Math.max(0, Math.min(meta.width - 1, Math.floor((lon - meta.west) / meta.res)));
  const S = meta.chunk.size, r = Math.floor(row / S), c = Math.floor(col / S), key = `${r}_${c}`;
  let a = chunks.get(key);
  if (!a) { const b = readFileSync(join(TDIR, `c_${key}.bin`)); a = new Int16Array(b.buffer, b.byteOffset, b.length / 2); chunks.set(key, a); }
  return a[(row - r * S) * (S + 1) + (col - c * S)] * meta.scale;
}

// ---------- PLATEAU coverage ----------
type Pt = [number, number];
const G = 0.001;
const cellKey = (lat: number, lon: number) => `${Math.floor(lat / G)}_${Math.floor(lon / G)}`;
function gridOf<T>(items: T[], box: (t: T) => [number, number, number, number]) {
  const grid = new Map<string, T[]>();
  for (const it of items) {
    const [s, w, n, e] = box(it);
    for (let a = Math.floor(s / G); a <= Math.floor(n / G); a++) for (let b = Math.floor(w / G); b <= Math.floor(e / G); b++) {
      const k = `${a}_${b}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(it);
    }
  }
  return grid;
}
const bboxOf = (r: Pt[]): [number, number, number, number] => [Math.min(...r.map(p => p[0])), Math.min(...r.map(p => p[1])), Math.max(...r.map(p => p[0])), Math.max(...r.map(p => p[1]))];
const footprints: Pt[][] = json(B('temple-footprints.json'));
const fpGrid = gridOf(footprints, bboxOf);
const ib = readFileSync(B('bldg-index.bin'));
const idx = new Float64Array(ib.buffer, ib.byteOffset, ib.length / 8); // lat, lon, base, top
const centroids: Pt[] = [];
for (let i = 0; i < idx.length; i += 4) centroids.push([idx[i], idx[i + 1]]);
const cGrid = gridOf(centroids, p => [p[0], p[1], p[0], p[1]]);
/** True if PLATEAU already has a building here. */
function coveredByPlateau(ring: Pt[], lat: number, lon: number) {
  if ((fpGrid.get(cellKey(lat, lon)) ?? []).some(f => pointInRing(lat, lon, f))) return true;
  const [s, w, n, e] = bboxOf(ring);
  for (let a = Math.floor(s / G); a <= Math.floor(n / G); a++) for (let b = Math.floor(w / G); b <= Math.floor(e / G); b++)
    for (const c of cGrid.get(`${a}_${b}`) ?? []) if (pointInRing(c[0], c[1], ring)) return true;
  return false;
}

// ---------- heights ----------
const len = (v?: string) => { const x = Number.parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : undefined; };
const DEFAULT_H: Record<string, number> = { temple: 10, shrine: 8, church: 10, pagoda: 20, gate: 7, castle: 15, roof: 5, toilets: 3.5, shed: 3, kiosk: 3, hut: 3, garage: 3, carport: 3 };
function heights(t: Record<string, string>) {
  const lv = len(t['building:levels']), minLv = len(t['building:min_level']);
  const type = t.building && t.building !== 'yes' ? t.building : t['building:part'] ?? 'yes';
  const h = len(t.height) ?? (lv ? lv * 3.5 + 2 : DEFAULT_H[type] ?? 6);
  const minH = Math.min(h - 0.5, len(t.min_height) ?? (minLv ? minLv * 3.5 : 0));
  // traditional buildings: hipped roof unless tagged otherwise (parts are usually tagged in detail)
  const shape = t['roof:shape'] ?? (t['building:part'] ? 'flat' : 'hipped');
  const roofLv = len(t['roof:levels']);
  const rhTag = len(t['roof:height']) ?? (roofLv ? roofLv * 3 : undefined);
  const rh = shape === 'flat' ? 0 : Math.min(rhTag ?? (h - minH) * 0.4, h - minH);
  return { h, minH, shape, rh, levels: lv ?? 0 };
}

// ---------- footprint helpers (local metres) ----------
const M_LAT = 111000, M_LON = 111000 * Math.cos(34.68 * RAD);
/** Drop the closing point and nearly collinear vertices. */
function simplify(ring: Pt[]): Pt[] {
  let r = ring.slice(0, -1);
  for (let changed = true; changed && r.length > 3;) {
    changed = false;
    for (let i = 0; i < r.length && r.length > 3; i++) {
      const a = r[(i + r.length - 1) % r.length], b = r[i], c = r[(i + 1) % r.length];
      const ux = (b[1] - a[1]) * M_LON, uy = (b[0] - a[0]) * M_LAT, vx = (c[1] - b[1]) * M_LON, vy = (c[0] - b[0]) * M_LAT;
      const cross = Math.abs(ux * vy - uy * vx), lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 0.2 || cross / (lu * lv || 1) < 0.05) { r.splice(i, 1); changed = true; }
    }
  }
  return r;
}
const dist = (a: Pt, b: Pt) => Math.hypot((a[0] - b[0]) * M_LAT, (a[1] - b[1]) * M_LON);
const lerp = (a: Pt, b: Pt, f: number): Pt => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
const z3 = (p: Pt, z: number) => [p[0], p[1], z];

/** Walls and roof as planar polygons ([lat, lon, z] rings). */
/** Observation tower: legs tapering to a shaft, an observation deck and a spire. */
function towerPolys(ring: Pt[], base: number, top: number): Poly[] {
  const out: Poly[] = [];
  const c: Pt = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
  const h = top - base;
  // [height fraction, footprint scale] from the ground up
  const prof: [number, number][] = [[0, 1], [0.25, 0.45], [0.75, 0.42], [0.78, 0.6], [0.86, 0.6], [0.88, 0.3]];
  const at = (f: number, k: number) => ring.map(p => z3(lerp(c, p, k), base + f * h));
  for (let j = 0; j + 1 < prof.length; j++) {
    const lo = at(...prof[j]), hi = at(...prof[j + 1]);
    for (let i = 0; i < ring.length; i++) { const k = (i + 1) % ring.length; out.push({ ext: [lo[i], lo[k], hi[k], hi[i]], holes: [] }); }
  }
  // deck floor and spire
  out.push({ ext: at(0.78, 0.6).reverse(), holes: [] });
  const cap = at(...prof[prof.length - 1]), apex = z3(c, top);
  for (let i = 0; i < ring.length; i++) out.push({ ext: [cap[i], cap[(i + 1) % ring.length], apex], holes: [] });
  return out;
}

function shapePolys(ring: Pt[], base: number, top: number, shape: string, rh: number, across: boolean): Poly[] {
  const out: Poly[] = [];
  const quad = ring.length === 4;
  const roofy = rh > 0.3 && shape !== 'flat' && shape !== 'skillion';
  const eave = roofy ? top - rh : top;
  const wall = (a: Pt, b: Pt) => out.push({ ext: [z3(a, base), z3(b, base), z3(b, eave), z3(a, eave)], holes: [] });
  const poly = (pts: number[][]) => out.push({ ext: pts, holes: [] });
  for (let i = 0; i < ring.length; i++) wall(ring[i], ring[(i + 1) % ring.length]);
  if (!roofy) { poly(ring.map(p => z3(p, eave))); return out; }

  if (quad && (shape === 'hipped' || shape === 'gabled' || shape === 'half-hipped' || shape === 'gambrel' || shape === 'mansard')) {
    // order corners so c0-c1 and c2-c3 are the long (eave) sides
    let c = ring;
    const longFirst = dist(c[0], c[1]) + dist(c[2], c[3]) >= dist(c[1], c[2]) + dist(c[3], c[0]);
    if (longFirst === across) c = [c[1], c[2], c[3], c[0]];
    const m1 = lerp(c[1], c[2], 0.5), m3 = lerp(c[3], c[0], 0.5);
    const L = dist(m1, m3), w = (dist(c[1], c[2]) + dist(c[3], c[0])) / 2;
    if (shape === 'gabled') {
      poly([z3(c[0], eave), z3(c[1], eave), z3(m1, top), z3(m3, top)]);
      poly([z3(c[2], eave), z3(c[3], eave), z3(m3, top), z3(m1, top)]);
      poly([z3(c[1], eave), z3(c[2], eave), z3(m1, top)]);
      poly([z3(c[3], eave), z3(c[0], eave), z3(m3, top)]);
      return out;
    }
    // hipped: ridge inset by half the width from each end (a point for squares)
    const f = L > w ? w / 2 / L : 0.5;
    const ra = lerp(m3, m1, f), rb = lerp(m1, m3, f);
    poly([z3(c[0], eave), z3(c[1], eave), z3(rb, top), z3(ra, top)]);
    poly([z3(c[2], eave), z3(c[3], eave), z3(ra, top), z3(rb, top)]);
    poly([z3(c[1], eave), z3(c[2], eave), z3(rb, top)]);
    poly([z3(c[3], eave), z3(c[0], eave), z3(ra, top)]);
    return out;
  }
  if (ring.length <= 12) {
    // pyramidal (also used for domes, round roofs and hipped roofs on non-rectangular footprints)
    const apex: Pt = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
    for (let i = 0; i < ring.length; i++) poly([z3(ring[i], eave), z3(ring[(i + 1) % ring.length], eave), z3(apex, top)]);
    return out;
  }
  poly(ring.map(p => z3(p, eave)));
  return out;
}

function meshCode(lat: number, lon: number) {
  const p = Math.floor(lat * 1.5), u = Math.floor(lon - 100);
  const q = Math.floor((lat * 1.5 - p) * 8), v = Math.floor((lon - 100 - u) * 8);
  const r = Math.floor(((lat * 1.5 - p) * 8 - q) * 10), w = Math.floor(((lon - 100 - u) * 8 - v) * 10);
  return `${p}${u}${q}${v}${r}${w}`;
}

// ---------- main ----------
const templeAt = templeIndex(loadTemples());
const ways = (json(B('osm/temple-buildings.json')).elements as any[]).filter(e => e.type === 'way' && e.geometry?.length >= 4);
interface Item { e: any; ring: Pt[]; lat: number; lon: number; temple?: Temple; part: boolean }
const items: Item[] = [];
for (const e of ways) {
  const ring: Pt[] = e.geometry.map((p: any) => [p.lat, p.lon]);
  if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) continue;
  const open = ring.slice(0, -1);
  const lat = open.reduce((a, p) => a + p[0], 0) / open.length, lon = open.reduce((a, p) => a + p[1], 0) / open.length;
  const temple = templeAt(lat, lon);
  if (!temple) continue;
  items.push({ e, ring, lat, lon, temple, part: !!e.tags['building:part'] });
}
// observation towers outside temple grounds (PLATEAU has no towers)
for (const e of json(B('osm/landmarks.json')).elements as any[]) {
  const t = e.tags ?? {};
  if (e.type !== 'way' || !t.building || t.man_made !== 'tower' || t['tower:type'] !== 'observation' || !((len(t.height) ?? 0) >= 30)) continue;
  const ring: Pt[] = e.geometry.map((p: any) => [p.lat, p.lon]);
  const open = ring.slice(0, -1);
  const lat = open.reduce((a, p) => a + p[0], 0) / open.length, lon = open.reduce((a, p) => a + p[1], 0) / open.length;
  if (!templeAt(lat, lon)) items.push({ e, ring, lat, lon, part: false });
}
// an outline with building:part ways inside is drawn by its parts
const parts = items.filter(i => i.part);
const partGrid = gridOf(parts, i => [i.lat, i.lon, i.lat, i.lon]);
const hasParts = (o: Item) => {
  const [s, w, n, e] = bboxOf(o.ring);
  for (let a = Math.floor(s / G); a <= Math.floor(n / G); a++) for (let b = Math.floor(w / G); b <= Math.floor(e / G); b++)
    if ((partGrid.get(`${a}_${b}`) ?? []).some(p => p !== o && pointInRing(p.lat, p.lon, o.ring))) return true;
  return false;
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const meshes = new Map<string, { geom: Geom; frame: ReturnType<typeof enuFrame> }>();
const index: number[] = [];
let skippedPlateau = 0, skippedOutline = 0;
const perTemple = new Map<string, number>();
const towers: string[] = [];
for (const it of items) {
  const t = it.e.tags as Record<string, string>;
  if (!it.part && hasParts(it)) { skippedOutline++; continue; }
  if (coveredByPlateau(it.ring, it.lat, it.lon)) { skippedPlateau++; continue; }
  const ring = simplify(it.ring);
  if (ring.length < 3) continue;
  const hs = heights(t);
  const ground = Math.min(...ring.map(p => groundAt(p[0], p[1])));
  const base = ground + hs.minH, top = ground + hs.h;
  const polys = it.temple ? shapePolys(ring, base, top, hs.shape, hs.rh, t['roof:orientation'] === 'across') : towerPolys(ring, base, top);
  const code = meshCode(it.lat, it.lon);
  let m = meshes.get(code);
  if (!m) { const mb = meshBounds(code); m = { geom: new Geom(), frame: enuFrame((mb.s + mb.n) / 2, (mb.w + mb.e) / 2) }; meshes.set(code, m); }
  const ext: Ring = ring.map(p => [p[0], p[1], base]);
  const b: Bldg = { id: `osm:way/${it.e.id}`, name: t.name ?? '', h: Math.round((top - ground) * 10) / 10, s: hs.levels, u: '', addr: '', solids: [{ ext, holes: [], zb: base, zt: top }] };
  m.geom.add(b, m.frame, it.temple, polys);
  index.push(it.lat, it.lon, ground, top);
  if (it.temple) perTemple.set(it.temple.name, (perTemple.get(it.temple.name) ?? 0) + 1);
  else towers.push(t.name);
}

const children: any[] = [];
for (const [code, { geom, frame }] of [...meshes].sort()) {
  writeFileSync(join(OUT, `${code}.b3dm`), geom.b3dm());
  writeFileSync(join(OUT, `${code}.json`), JSON.stringify(geom.attrs));
  children.push({ boundingVolume: { region: geom.region() }, geometricError: 0, transform: frame.matrix, content: { uri: `${code}.b3dm` } });
}
const union = (rs: number[][]) => [Math.min(...rs.map(r => r[0])), Math.min(...rs.map(r => r[1])), Math.max(...rs.map(r => r[2])), Math.max(...rs.map(r => r[3])), Math.min(...rs.map(r => r[4])), Math.max(...rs.map(r => r[5]))];
const tileset = {
  asset: { version: '1.0', tilesetVersion: new Date().toISOString().slice(0, 10) },
  geometricError: 5000,
  root: { boundingVolume: { region: union(children.map(c => c.boundingVolume.region)) }, geometricError: 2000, refine: 'ADD', children },
};
writeFileSync(join(OUT, 'tileset.json'), JSON.stringify(tileset));
writeFileSync(B('osm-bldg-index.bin'), new Float64Array(index));
const top = [...perTemple].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`OSM buildings: ${index.length / 4} added in ${perTemple.size} temple grounds (skipped: ${skippedPlateau} covered by PLATEAU, ${skippedOutline} outlines drawn by parts), ${meshes.size} tiles`);
console.log(`most added: ${top}`);
console.log(`towers: ${towers.join(', ') || '-'}`);
