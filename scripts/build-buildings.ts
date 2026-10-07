// Convert PLATEAU CityGML buildings to 3D Tiles (b3dm), plus building labels
// and ground-height samples used to correct the terrain. Buildings are LOD1
// blocks, except those inside the grounds of a temple or shrine (see temples.ts),
// which use their LOD2 roof and wall surfaces where PLATEAU has them.
//
//   node scripts/build-buildings.ts [--limit N] [--lod2-all]
//   (run fetch-osm.ts first)
//
// Output:
//   public/data/bldg/tileset.json, public/data/bldg/<mesh>_{t,d}.b3dm
//   public/data/bldg/<mesh>_{t,d}.json    per-feature details (id, storeys, usage, address) loaded on click
//   public/data/labels/buildings.json
//   build/ground.json
//   build/temple-footprints.json   footprints of PLATEAU buildings in temple grounds
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { loadTemples, templeIndex } from './temples.ts';
import { Geom, enuFrame, meshBounds, type Bldg, type Poly, type Ring } from './tiles.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, '../27100_osaka-shi_city_2025_citygml_1_op/udx/bldg');
const OUT = join(ROOT, 'public/data/bldg');
const LABEL_OUT = join(ROOT, 'public/data/labels');
const BUILD = join(ROOT, 'build');

// Buildings at least this tall go into the always-loaded "tall" tile of each mesh.
const TALL_M = 25;
// DEM grid (osaka.tif) for ground samples.
const DEM = { ox: 134.99597222226396, oy: 35.09097222221892, res: 1 / 3600, w: 3839, h: 3318 };
// --lod2-all: LOD2 for every building that has it, not only temples and shrines
const LOD2_ALL = process.argv.includes('--lod2-all') || !!(workerData as { lod2All?: boolean } | null)?.lod2All;

// ---------- GML parsing ----------

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

/** LOD2 roof/wall polygons (ground surfaces are never visible and are skipped). */
function parseLod2(xml: string): Poly[] {
  const out: Poly[] = [];
  const surfRe = /<bldg:(RoofSurface|WallSurface|OuterCeilingSurface|OuterFloorSurface)[ >]([\s\S]*?)<\/bldg:\1>/g;
  let m: RegExpExecArray | null;
  while ((m = surfRe.exec(xml))) {
    const msRe = /<bldg:lod2MultiSurface>([\s\S]*?)<\/bldg:lod2MultiSurface>/g;
    let ms: RegExpExecArray | null;
    while ((ms = msRe.exec(m[2]))) {
      const polyRe = /<gml:Polygon[^>]*>([\s\S]*?)<\/gml:Polygon>/g;
      let p: RegExpExecArray | null;
      while ((p = polyRe.exec(ms[1]))) {
        const ext = parsePosList(tag(p[1], /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([^<]*)</));
        const holes: Ring[] = [];
        const holeRe = /<gml:interior>[\s\S]*?<gml:posList[^>]*>([^<]*)</g;
        let h: RegExpExecArray | null;
        while ((h = holeRe.exec(p[1]))) holes.push(parsePosList(h[1]));
        if (ext.length >= 3) out.push({ ext, holes });
      }
    }
  }
  return out;
}

// ---------- worker ----------
let templeAt: ReturnType<typeof templeIndex> | undefined;
function processFile(file: string) {
  templeAt ??= templeIndex(loadTemples());
  const mesh = file.split('_')[0];
  const mb = meshBounds(mesh);
  const frame = enuFrame((mb.s + mb.n) / 2, (mb.w + mb.e) / 2);
  const xml = readFileSync(join(SRC, file), 'utf8');
  const tall = new Geom(), detail = new Geom();
  const labels: any[] = [];
  const ground: [number, number][] = [];
  const index: number[] = []; // lat, lon, base, top per building
  const footprints: number[][][] = []; // [lat, lon][] of buildings in temple grounds
  let n = 0, skipped = 0, nTemple = 0, nLod2 = 0;
  const re = /<bldg:Building[ >][\s\S]*?<\/bldg:Building>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const b = parseBuilding(m[0]);
    if (!b) { skipped++; continue; }
    n++;
    const zb = Math.min(...b.solids.map(s => s.zb)), zt = Math.max(...b.solids.map(s => s.zt));
    // centroid of the largest solid's footprint
    const ext = b.solids.reduce((a, s) => (s.ext.length > a.ext.length ? s : a)).ext;
    const lat = ext.reduce((a, v) => a + v[0], 0) / ext.length, lon = ext.reduce((a, v) => a + v[1], 0) / ext.length;
    const temple = templeAt(lat, lon);
    const lod2 = (temple || LOD2_ALL) && m[0].includes('<bldg:lod2Solid') ? parseLod2(m[0]) : undefined;
    if (temple) { nTemple++; footprints.push(ext.map(v => [+v[0].toFixed(7), +v[1].toFixed(7)])); }
    if (lod2?.length) nLod2++;
    // temple buildings go into the always-loaded tile too
    (zt - zb >= TALL_M || temple ? tall : detail).add(b, frame, temple, lod2);
    const col = Math.floor((lon - DEM.ox) / DEM.res), row = Math.floor((DEM.oy - lat) / DEM.res);
    ground.push([row * DEM.w + col, zb]);
    index.push(lat, lon, zb, zt);
    if (b.name) labels.push({ name: b.name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), top: +zt.toFixed(1), base: +zb.toFixed(1), u: b.u, id: b.id });
  }
  const tiles: any = { mesh, n, skipped, nTemple, nLod2, matrix: frame.matrix };
  for (const [k, g] of [['t', tall], ['d', detail]] as const) {
    if (!g.count) continue;
    writeFileSync(join(OUT, `${mesh}_${k}.b3dm`), g.b3dm());
    writeFileSync(join(OUT, `${mesh}_${k}.json`), JSON.stringify(g.attrs)); // per-feature details, same order as batch ids
    tiles[k] = { region: g.region(), count: g.count };
  }
  return { tiles, labels, ground, index, footprints };
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
    const w = new Worker(fileURLToPath(import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 4096 }, workerData: { lod2All: LOD2_ALL } });
    const next = () => { const f = queue.shift(); if (!f) { w.terminate(); resolve(); return; } w.postMessage(f); };
    w.on('message', (r) => { results.push(r); process.stdout.write(`\r${results.length}/${files.length} ${r.tiles.mesh} (${r.tiles.n} bldgs)   `); next(); });
    w.on('error', reject);
    next();
  })));
  console.log(`\nparsed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // tileset: root -> per-mesh tall tile (refine ADD) -> detail tile
  const union = (rs: number[][]) => [Math.min(...rs.map(r => r[0])), Math.min(...rs.map(r => r[1])), Math.max(...rs.map(r => r[2])), Math.max(...rs.map(r => r[3])), Math.min(...rs.map(r => r[4])), Math.max(...rs.map(r => r[5]))];
  const children: any[] = [];
  let total = 0, temples = 0, lod2 = 0;
  for (const { tiles: t } of results.sort((a, b) => a.tiles.mesh.localeCompare(b.tiles.mesh))) {
    total += t.n; temples += t.nTemple; lod2 += t.nLod2;
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
  writeFileSync(join(BUILD, 'temple-footprints.json'), JSON.stringify(results.flatMap(r => r.footprints)));

  const acc = new Map<number, number[]>();
  for (const r of results) for (const [cell, z] of r.ground) { const a = acc.get(cell); a ? a.push(z) : acc.set(cell, [z]); }
  const ground: [number, number][] = [];
  for (const [cell, zs] of acc) { zs.sort((a, b) => a - b); ground.push([cell, +zs[zs.length >> 1].toFixed(2)]); }
  writeFileSync(join(BUILD, 'ground.json'), JSON.stringify(ground));
  console.log(`buildings: ${total} (in temple grounds ${temples}, LOD2 ${lod2}), tiles: ${children.length}, named: ${labels.length}, ground cells: ${ground.length}`);
}
