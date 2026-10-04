// Convert osaka.tif to web heightmap files. The source DEM is a surface model
// (trees, large structures); inside Osaka City it is replaced by the PLATEAU
// bare-earth TIN, and near other PLATEAU buildings it is nudged to their base heights.
//
//   node scripts/build-terrain.ts      (run build-buildings.ts and build-ground.ts first)
//
// Output (Int16, decimetres, little-endian, row 0 = north):
//   public/data/terrain/meta.json
//   public/data/terrain/overview.bin           whole extent, downsampled by OVERVIEW
//   public/data/terrain/c_<row>_<col>.bin      full-res CHUNK x CHUNK blocks, +1 px overlap
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/data/terrain');
const OVERVIEW = 4, CHUNK = 512;

const tiff = await fromFile(join(ROOT, '../osaka.tif'));
const img = await tiff.getImage();
const W = img.getWidth(), H = img.getHeight();
const [ox, oy] = img.getOrigin();
const res = img.getResolution()[0];
const [raw] = (await img.readRasters()) as unknown as Int16Array[];
const dem = new Float32Array(W * H);
for (let i = 0; i < raw.length; i++) dem[i] = raw[i] === -32768 ? 0 : Math.max(raw[i], -5);

// --- correction from PLATEAU building base heights ---
const groundFile = join(ROOT, 'build/ground.json');
if (existsSync(groundFile)) {
  const ground: [number, number][] = JSON.parse(readFileSync(groundFile, 'utf8'));
  const sum = new Float32Array(W * H), cnt = new Float32Array(W * H);
  for (const [cell, z] of ground) { sum[cell] += z - dem[cell]; cnt[cell] += 1; }
  const blur = (a: Float32Array, r: number) => {
    const t = new Float32Array(W * H);
    for (let y = 0; y < H; y++) { let s = 0; for (let x = -r; x < W + r; x++) { if (x + r < W) s += a[y * W + x + r]; if (x - r - 1 >= 0) s -= a[y * W + x - r - 1]; if (x >= 0 && x < W) t[y * W + x] = s; } }
    const o = new Float32Array(W * H);
    for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y < H + r; y++) { if (y + r < H) s += t[(y + r) * W + x]; if (y - r - 1 >= 0) s -= t[(y - r - 1) * W + x]; if (y >= 0 && y < H) o[y * W + x] = s; } }
    return o;
  };
  let S = sum, C = cnt;
  for (let k = 0; k < 2; k++) { S = blur(S, 3); C = blur(C, 3); }
  let n = 0, meanAbs = 0;
  for (let i = 0; i < W * H; i++) {
    if (C[i] <= 0) continue;
    const wgt = Math.min(1, C[i] / 20);
    const d = (S[i] / C[i]) * wgt;
    dem[i] += d; n++; meanAbs += Math.abs(d);
  }
  console.log(`ground correction applied to ${n} cells, mean |delta| ${(meanAbs / n).toFixed(2)} m`);
} else console.warn('build/ground.json missing: terrain left uncorrected');

// --- PLATEAU bare-earth TIN (build-ground.ts) replaces the DEM where available ---
const pdMetaFile = join(ROOT, 'build/plateau-dem.json');
if (existsSync(pdMetaFile)) {
  const pm = JSON.parse(readFileSync(pdMetaFile, 'utf8'));
  const b = readFileSync(join(ROOT, 'build/plateau-dem.bin'));
  const pd = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  let n = 0;
  for (let r = 0; r < pm.height; r++) for (let c = 0; c < pm.width; c++) {
    const v = pd[r * pm.width + c], R = r + pm.row0, C = c + pm.col0;
    if (Number.isNaN(v) || R < 0 || C < 0 || R >= H || C >= W) continue;
    dem[R * W + C] = v; n++;
  }
  console.log(`PLATEAU ground used for ${n} cells`);
} else console.warn('build/plateau-dem.json missing: run build-ground.ts for bare-earth heights in Osaka City');

mkdirSync(OUT, { recursive: true });
const dm = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * 10)));

// overview
const OW = Math.ceil(W / OVERVIEW), OH = Math.ceil(H / OVERVIEW);
const ov = new Int16Array(OW * OH);
for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
  let s = 0, c = 0;
  for (let j = 0; j < OVERVIEW; j++) for (let i = 0; i < OVERVIEW; i++) {
    const yy = y * OVERVIEW + j, xx = x * OVERVIEW + i;
    if (yy < H && xx < W) { s += dem[yy * W + xx]; c++; }
  }
  ov[y * OW + x] = dm(s / c);
}
writeFileSync(join(OUT, 'overview.bin'), ov);

// full-res chunks with 1 px overlap on the east/south edges
const CR = Math.ceil(H / CHUNK), CC = Math.ceil(W / CHUNK), CS = CHUNK + 1;
for (let r = 0; r < CR; r++) for (let c = 0; c < CC; c++) {
  const a = new Int16Array(CS * CS);
  for (let y = 0; y < CS; y++) for (let x = 0; x < CS; x++) {
    const yy = Math.min(H - 1, r * CHUNK + y), xx = Math.min(W - 1, c * CHUNK + x);
    a[y * CS + x] = dm(dem[yy * W + xx]);
  }
  writeFileSync(join(OUT, `c_${r}_${c}.bin`), a);
}

const meta = { width: W, height: H, west: ox, north: oy, res, scale: 0.1, overview: { factor: OVERVIEW, width: OW, height: OH }, chunk: { size: CHUNK, rows: CR, cols: CC } };
writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
console.log('terrain written', meta);
