// Convert PLATEAU CityGML LOD1 buildings to 3D Tiles (b3dm), plus building labels
// and ground-height samples used to correct the terrain.
//
//   node scripts/build-buildings.ts [--limit N]
//
// Output:
//   public/data/bldg/tileset.json, public/data/bldg/<mesh>_{t,d}.b3dm
//   public/data/bldg/<mesh>_{t,d}.json    per-feature details (id, storeys, usage, address) loaded on click
//   public/data/labels/buildings.json
//   build/ground.json
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import earcut from 'earcut';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, '../27100_osaka-shi_city_2025_citygml_1_op/udx/bldg');
const OUT = join(ROOT, 'public/data/bldg');
const LABEL_OUT = join(ROOT, 'public/data/labels');
const BUILD = join(ROOT, 'build');

// Buildings at least this tall go into the always-loaded "tall" tile of each mesh.
const TALL_M = 25;
// KHR_mesh_quantization: positions stored as int16 * POS_SCALE metres (±1638 m).
const POS_SCALE = 0.05;
// DEM grid (osaka.tif) for ground samples.
const DEM = { ox: 134.99597222226396, oy: 35.09097222221892, res: 1 / 3600, w: 3839, h: 3318 };

// ---------- geodesy ----------
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F);
const RAD = Math.PI / 180;
function ecef(lat: number, lon: number, h: number): [number, number, number] {
  const sl = Math.sin(lat * RAD), cl = Math.cos(lat * RAD);
  const N = A / Math.sqrt(1 - E2 * sl * sl);
  return [(N + h) * cl * Math.cos(lon * RAD), (N + h) * cl * Math.sin(lon * RAD), (N * (1 - E2) + h) * sl];
}
function enuFrame(lat: number, lon: number) {
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

// ---------- GML parsing ----------
type Ring = number[][]; // [lat, lon, z][]
interface Bldg {
  id: string; name: string; h: number; s: number; u: string; addr: string;
  solids: { ext: Ring; holes: Ring[]; zb: number; zt: number }[];
}

const tag = (s: string, re: RegExp) => { const m = re.exec(s); return m ? m[1] : ''; };
function parsePosList(s: string): Ring {
  const v = s.trim().split(/\s+/).map(Number);
  const r: Ring = [];
  for (let i = 0; i + 2 < v.length; i += 3) r.push([v[i], v[i + 1], v[i + 2]]);
  if (r.length > 1) { const a = r[0], b = r[r.length - 1]; if (a[0] === b[0] && a[1] === b[1]) r.pop(); }
  return r;
}

function parseBuilding(xml: string): Bldg | null {
  const solids: Bldg['solids'] = [];
  const solidRe = /<bldg:lod1Solid>([\s\S]*?)<\/bldg:lod1Solid>/g;
  let m: RegExpExecArray | null;
  while ((m = solidRe.exec(xml))) {
    const polys: { ext: Ring; holes: Ring[] }[] = [];
    const polyRe = /<gml:Polygon[^>]*>([\s\S]*?)<\/gml:Polygon>/g;
    let p: RegExpExecArray | null;
    while ((p = polyRe.exec(m[1]))) {
      const ext = parsePosList(tag(p[1], /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([^<]*)</));
      const holes: Ring[] = [];
      const holeRe = /<gml:interior>[\s\S]*?<gml:posList[^>]*>([^<]*)</g;
      let h: RegExpExecArray | null;
      while ((h = holeRe.exec(p[1]))) holes.push(parsePosList(h[1]));
      if (ext.length >= 3) polys.push({ ext, holes });
    }
    if (!polys.length) continue;
    let zb = Infinity, zt = -Infinity;
    for (const q of polys) for (const v of q.ext) { if (v[2] < zb) zb = v[2]; if (v[2] > zt) zt = v[2]; }
    const flat = (q: { ext: Ring }, z: number) => q.ext.every(v => Math.abs(v[2] - z) < 1e-3);
    const bottom = polys.find(q => flat(q, zb)) ?? polys.find(q => flat(q, zt));
    if (!bottom || zt - zb < 0.1) continue;
    solids.push({ ext: bottom.ext, holes: bottom.holes, zb, zt });
  }
  if (!solids.length) return null;
  const head = xml.slice(0, xml.search(/<bldg:(lod0|lod1|lod2|consistsOf|boundedBy)/) >>> 0);
  const ward = tag(xml, /name="区名"><gen:value>([^<]*)/);
  const town = tag(xml, /name="町丁目名称"><gen:value>([^<]*)/);
  return {
    id: tag(xml, /<uro:buildingID>([^<]*)/),
    name: tag(head, /<gml:name>([^<]*)/).trim(),
    h: Number(tag(xml, /<bldg:measuredHeight[^>]*>([^<]*)/)) || 0,
    s: Number(tag(xml, /<bldg:storeysAboveGround>([^<]*)/)) || 0,
    u: tag(xml, /<bldg:usage[^>]*>([^<]*)/),
    addr: ward + town,
    solids,
  };
}

// ---------- geometry / b3dm ----------
// Walls and roof share vertices and carry no normals: the viewer derives flat
// normals from screen-space derivatives. Primitives are capped at 65535 vertices
// so all index buffers are 16-bit.
const MAX_VERTS = 65535;
interface Prim { pos: number[]; bid: number[]; idx: number[]; min: number[]; max: number[] }

class Geom {
  prims: Prim[] = [];
  // batch table: only what styling and labels-on-map need; the rest is fetched on click
  props = { name: [] as string[], h: [] as number[] };
  attrs = { id: [] as string[], s: [] as number[], u: [] as string[], addr: [] as string[] };
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

  add(b: Bldg, frame: ReturnType<typeof enuFrame>) {
    const id = this.count;
    for (const s of b.solids) {
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
    this.props.name.push(b.name); this.props.h.push(Math.round(b.h * 10) / 10);
    this.attrs.id.push(b.id); this.attrs.s.push(b.s); this.attrs.u.push(b.u); this.attrs.addr.push(b.addr);
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
      asset: { version: '2.0', generator: 'osaka_viewer build-buildings' },
      extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'],
      scene: 0, scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, scale: [POS_SCALE, POS_SCALE, POS_SCALE] }],
      meshes: [{ primitives }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
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
function meshBounds(code: string) {
  const p = +code.slice(0, 2), u = +code.slice(2, 4), q = +code[4], v = +code[5], r = +code[6], w = +code[7];
  const s = p / 1.5 + q / 12 + r / 120, west = u + 100 + v / 8 + w / 80;
  return { s, w: west, n: s + 1 / 120, e: west + 1 / 80 };
}

// ---------- worker ----------
function processFile(file: string) {
  const mesh = file.split('_')[0];
  const mb = meshBounds(mesh);
  const frame = enuFrame((mb.s + mb.n) / 2, (mb.w + mb.e) / 2);
  const xml = readFileSync(join(SRC, file), 'utf8');
  const tall = new Geom(), detail = new Geom();
  const labels: any[] = [];
  const ground: [number, number][] = [];
  const index: number[] = []; // lat, lon, base, top per building
  let n = 0, skipped = 0;
  const re = /<bldg:Building[ >][\s\S]*?<\/bldg:Building>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const b = parseBuilding(m[0]);
    if (!b) { skipped++; continue; }
    n++;
    const zb = Math.min(...b.solids.map(s => s.zb)), zt = Math.max(...b.solids.map(s => s.zt));
    (zt - zb >= TALL_M ? tall : detail).add(b, frame);
    // centroid of the largest solid's footprint
    const ext = b.solids.reduce((a, s) => (s.ext.length > a.ext.length ? s : a)).ext;
    const lat = ext.reduce((a, v) => a + v[0], 0) / ext.length, lon = ext.reduce((a, v) => a + v[1], 0) / ext.length;
    const col = Math.floor((lon - DEM.ox) / DEM.res), row = Math.floor((DEM.oy - lat) / DEM.res);
    ground.push([row * DEM.w + col, zb]);
    index.push(lat, lon, zb, zt);
    if (b.name) labels.push({ name: b.name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), top: +zt.toFixed(1), base: +zb.toFixed(1), u: b.u, id: b.id });
  }
  const tiles: any = { mesh, n, skipped, matrix: frame.matrix };
  for (const [k, g] of [['t', tall], ['d', detail]] as const) {
    if (!g.count) continue;
    writeFileSync(join(OUT, `${mesh}_${k}.b3dm`), g.b3dm());
    writeFileSync(join(OUT, `${mesh}_${k}.json`), JSON.stringify(g.attrs)); // per-feature details, same order as batch ids
    tiles[k] = { region: g.region(), count: g.count };
  }
  return { tiles, labels, ground, index };
}

if (!isMainThread) {
  parentPort!.on('message', (file: string) => parentPort!.postMessage(processFile(file)));
} else {
  mkdirSync(OUT, { recursive: true }); mkdirSync(LABEL_OUT, { recursive: true }); mkdirSync(BUILD, { recursive: true });
  const li = process.argv.indexOf('--limit');
  let files = readdirSync(SRC).filter(f => f.endsWith('_op.gml')).sort();
  if (li > 0) files = files.slice(0, +process.argv[li + 1]);
  const queue = [...files];
  const results: ReturnType<typeof processFile>[] = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(cpus().length - 1, 8, files.length) }, () => new Promise<void>((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    const next = () => { const f = queue.shift(); if (!f) { w.terminate(); resolve(); return; } w.postMessage(f); };
    w.on('message', (r) => { results.push(r); process.stdout.write(`\r${results.length}/${files.length} ${r.tiles.mesh} (${r.tiles.n} bldgs)   `); next(); });
    w.on('error', reject);
    next();
  })));
  console.log(`\nparsed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // tileset: root -> per-mesh tall tile (refine ADD) -> detail tile
  const union = (rs: number[][]) => [Math.min(...rs.map(r => r[0])), Math.min(...rs.map(r => r[1])), Math.max(...rs.map(r => r[2])), Math.max(...rs.map(r => r[3])), Math.min(...rs.map(r => r[4])), Math.max(...rs.map(r => r[5]))];
  const children: any[] = [];
  let total = 0;
  for (const { tiles: t } of results.sort((a, b) => a.tiles.mesh.localeCompare(b.tiles.mesh))) {
    total += t.n;
    const regions = [t.t?.region, t.d?.region].filter(Boolean);
    if (!regions.length) continue;
    const node: any = { boundingVolume: { region: union(regions) }, geometricError: 80, refine: 'ADD', transform: t.matrix };
    if (t.t) node.content = { uri: `${t.mesh}_t.b3dm`, boundingVolume: { region: t.t.region } };
    if (t.d) node.children = [{ boundingVolume: { region: t.d.region }, geometricError: 0, content: { uri: `${t.mesh}_d.b3dm` } }];
    children.push(node);
  }
  const tileset = {
    asset: { version: '1.0', tilesetVersion: new Date().toISOString().slice(0, 10) },
    geometricError: 5000,
    root: { boundingVolume: { region: union(children.map(c => c.boundingVolume.region)) }, geometricError: 2000, refine: 'ADD', children },
  };
  writeFileSync(join(OUT, 'tileset.json'), JSON.stringify(tileset));

  const labels = results.flatMap(r => r.labels);
  writeFileSync(join(BUILD, 'buildings-labels-raw.json'), JSON.stringify(labels));
  writeFileSync(join(BUILD, 'bldg-index.bin'), new Float64Array(results.flatMap(r => r.index)));

  const acc = new Map<number, number[]>();
  for (const r of results) for (const [cell, z] of r.ground) { const a = acc.get(cell); a ? a.push(z) : acc.set(cell, [z]); }
  const ground: [number, number][] = [];
  for (const [cell, zs] of acc) { zs.sort((a, b) => a - b); ground.push([cell, +zs[zs.length >> 1].toFixed(2)]); }
  writeFileSync(join(BUILD, 'ground.json'), JSON.stringify(ground));
  console.log(`buildings: ${total}, tiles: ${children.length}, named: ${labels.length}, ground cells: ${ground.length}`);
}
