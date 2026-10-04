// Terrain from the preprocessed DEM (see scripts/build-terrain.ts): a downsampled
// overview grid for distant tiles plus full-resolution chunks loaded on demand.
import { CustomHeightmapTerrainProvider, GeographicTilingScheme, Math as CMath } from 'cesium';

interface Meta {
  width: number; height: number; west: number; north: number; res: number; scale: number;
  overview: { factor: number; width: number; height: number };
  chunk: { size: number; rows: number; cols: number };
}

const TILE = 33; // heightmap samples per tile edge

export class Dem {
  private chunks = new Map<string, Promise<Int16Array>>();
  private loaded = new Map<string, Int16Array>();
  private constructor(private base: string, readonly meta: Meta, private overview: Int16Array) {}

  static async load(base: string) {
    const meta: Meta = await (await fetch(`${base}/meta.json`)).json();
    const overview = new Int16Array(await (await fetch(`${base}/overview.bin`)).arrayBuffer());
    return new Dem(base, meta, overview);
  }

  get bounds() {
    const m = this.meta;
    return { west: m.west, north: m.north, east: m.west + m.width * m.res, south: m.north - m.height * m.res };
  }

  contains(lon: number, lat: number) {
    const b = this.bounds;
    return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
  }

  private chunk(r: number, c: number) {
    const key = `${r}_${c}`;
    let p = this.chunks.get(key);
    if (!p) {
      p = fetch(`${this.base}/c_${key}.bin`).then((res) => res.arrayBuffer()).then((b) => {
        const a = new Int16Array(b);
        this.loaded.set(key, a);
        return a;
      });
      this.chunks.set(key, p);
    }
    return p;
  }

  /** Bilinear sample from the overview grid (metres). */
  sampleOverview(lon: number, lat: number) {
    const m = this.meta, f = m.overview.factor;
    const x = (lon - m.west) / (m.res * f) - 0.5, y = (m.north - lat) / (m.res * f) - 0.5;
    return bilinear(this.overview, m.overview.width, m.overview.height, x, y) * m.scale;
  }

  /** Bilinear sample at full resolution; undefined if the chunk is not loaded yet. */
  sampleFull(lon: number, lat: number): number | undefined {
    const m = this.meta, S = m.chunk.size;
    const x = (lon - m.west) / m.res - 0.5, y = (m.north - lat) / m.res - 0.5;
    const cx = Math.max(0, Math.min(m.width - 1, x)), cy = Math.max(0, Math.min(m.height - 1, y));
    const r = Math.min(m.chunk.rows - 1, Math.floor(cy / S)), c = Math.min(m.chunk.cols - 1, Math.floor(cx / S));
    const a = this.loaded.get(`${r}_${c}`);
    if (!a) return undefined;
    return bilinear(a, S + 1, S + 1, cx - c * S, cy - r * S) * m.scale;
  }

  /** Ground height (orthometric metres) at a point, 0 outside the DEM. */
  async heightAt(lon: number, lat: number) {
    if (!this.contains(lon, lat)) return 0;
    await this.ensure(lon, lon, lat, lat);
    return this.sampleFull(lon, lat) ?? this.sampleOverview(lon, lat);
  }

  /** Synchronous best-effort height (full res if loaded). */
  heightNow(lon: number, lat: number) {
    if (!this.contains(lon, lat)) return 0;
    return this.sampleFull(lon, lat) ?? this.sampleOverview(lon, lat);
  }

  private ensure(w: number, e: number, s: number, n: number) {
    const m = this.meta, S = m.chunk.size;
    const col = (lon: number) => Math.max(0, Math.min(m.chunk.cols - 1, Math.floor((lon - m.west) / m.res / S)));
    const row = (lat: number) => Math.max(0, Math.min(m.chunk.rows - 1, Math.floor((m.north - lat) / m.res / S)));
    const ps: Promise<Int16Array>[] = [];
    for (let r = row(n); r <= row(s); r++) for (let c = col(w); c <= col(e); c++) ps.push(this.chunk(r, c));
    return Promise.all(ps);
  }

  provider() {
    const tiling = new GeographicTilingScheme();
    const b = this.bounds;
    const fullResLimit = this.meta.res * this.meta.overview.factor; // deg per sample below which full res is used
    return new CustomHeightmapTerrainProvider({
      width: TILE,
      height: TILE,
      tilingScheme: tiling,
      callback: (x, y, level) => {
        const r = tiling.tileXYToRectangle(x, y, level);
        const w = CMath.toDegrees(r.west), e = CMath.toDegrees(r.east), s = CMath.toDegrees(r.south), n = CMath.toDegrees(r.north);
        const out = new Float32Array(TILE * TILE);
        if (e < b.west || w > b.east || n < b.south || s > b.north) return out;
        const step = (e - w) / (TILE - 1);
        const fill = (full: boolean) => {
          for (let j = 0; j < TILE; j++) {
            const lat = n - (j * (n - s)) / (TILE - 1);
            for (let i = 0; i < TILE; i++) {
              const lon = w + i * step;
              if (lon < b.west || lon > b.east || lat < b.south || lat > b.north) continue;
              out[j * TILE + i] = (full ? this.sampleFull(lon, lat) : undefined) ?? this.sampleOverview(lon, lat);
            }
          }
          return out;
        };
        if (step > fullResLimit) return fill(false);
        return this.ensure(Math.max(w, b.west), Math.min(e, b.east), Math.max(s, b.south), Math.min(n, b.north)).then(() => fill(true));
      },
    });
  }
}

function bilinear(a: Int16Array, w: number, h: number, x: number, y: number) {
  x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const top = a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx;
  const bot = a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx;
  return top * (1 - fy) + bot * fy;
}
