// Rasterize the PLATEAU terrain TIN (udx/dem, a bare-earth model) onto the
// osaka.tif grid by averaging TIN vertex heights per 1" cell. build-terrain.ts
// uses the result in place of the DEM inside Osaka City.
//
//   node scripts/build-ground.ts      -> build/plateau-dem.json + build/plateau-dem.bin (Float32, NaN = no data)
import { createReadStream, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, '../27100_osaka-shi_city_2025_citygml_1_op/udx/dem');
// sub-grid of the osaka.tif grid that covers Osaka City
const DEM = { west: 134.99597222226396, north: 35.09097222221892, res: 1 / 3600 };
const C0 = Math.floor((135.33 - DEM.west) / DEM.res), R0 = Math.floor((DEM.north - 34.82) / DEM.res);
const W = Math.ceil(0.34 / DEM.res), H = Math.ceil(0.30 / DEM.res);

async function processFile(file: string) {
  const sum = new Float64Array(W * H), cnt = new Uint32Array(W * H);
  let tail = '';
  const re = /<gml:posList>([^<]*)<\/gml:posList>/g;
  for await (const chunk of createReadStream(join(SRC, file), { encoding: 'utf8', highWaterMark: 1 << 24 })) {
    const s = tail + chunk;
    re.lastIndex = 0;
    let m: RegExpExecArray | null, end = 0;
    while ((m = re.exec(s))) {
      end = re.lastIndex;
      const v = m[1].trim().split(/\s+/);
      // triangles are closed rings of 4 points; skip the repeated closing point
      for (let i = 0; i + 2 < v.length - 3; i += 3) {
        const lat = +v[i], lon = +v[i + 1], z = +v[i + 2];
        const r = Math.floor((DEM.north - lat) / DEM.res) - R0, c = Math.floor((lon - DEM.west) / DEM.res) - C0;
        if (r < 0 || c < 0 || r >= H || c >= W) continue;
        sum[r * W + c] += z; cnt[r * W + c]++;
      }
    }
    // keep an unfinished element for the next chunk
    const open = s.lastIndexOf('<gml:posList>');
    tail = open >= end ? s.slice(open) : '';
  }
  return { sum, cnt };
}

if (!isMainThread) {
  parentPort!.on('message', async (f: string) => {
    const r = await processFile(f);
    parentPort!.postMessage(r, [r.sum.buffer, r.cnt.buffer]);
  });
} else {
  const files = readdirSync(SRC).filter((f) => f.endsWith('_op.gml')).sort();
  const queue = [...files];
  const sum = new Float64Array(W * H), cnt = new Uint32Array(W * H);
  let done = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(cpus().length - 1, 8) }, () => new Promise<void>((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url));
    const next = () => { const f = queue.shift(); if (!f) { w.terminate(); resolve(); return; } w.postMessage(f); };
    w.on('message', (r: { sum: Float64Array; cnt: Uint32Array }) => {
      for (let i = 0; i < W * H; i++) { sum[i] += r.sum[i]; cnt[i] += r.cnt[i]; }
      process.stdout.write(`\r${++done}/${files.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
      next();
    });
    w.on('error', reject);
    next();
  })));
  const out = new Float32Array(W * H);
  let n = 0;
  for (let i = 0; i < W * H; i++) { out[i] = cnt[i] ? sum[i] / cnt[i] : NaN; if (cnt[i]) n++; }
  mkdirSync(join(ROOT, 'build'), { recursive: true });
  writeFileSync(join(ROOT, 'build/plateau-dem.bin'), out);
  writeFileSync(join(ROOT, 'build/plateau-dem.json'), JSON.stringify({ row0: R0, col0: C0, width: W, height: H }));
  console.log(`\ncells with PLATEAU ground: ${n} of ${W * H}`);
}
