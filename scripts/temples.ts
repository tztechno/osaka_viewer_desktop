// Temples and shrines with a Wikipedia article or Wikidata item, and castles
// (build/osm/temples.json), with their grounds as polygons so buildings can be assigned to them.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Pt = [number, number]; // lat, lon
/** 1 = Buddhist temple, 2 = Shinto shrine, 3 = other place of worship, 4 = castle */
export type Religion = 1 | 2 | 3 | 4;
export interface Temple {
  i: number; name: string; en: string; rel: Religion; r: 1 | 2 | 3;
  lat: number; lon: number; rings: Pt[][]; bbox: [number, number, number, number]; area: number;
  wikipedia: string; heritage: string;
}

function religion(t: Record<string, string>): Religion {
  if (t.historic === 'castle') return 4;
  if (t.religion === 'buddhist') return 1;
  if (t.religion === 'shinto') return 2;
  if (t.religion) return 3;
  if (/(神社|神宮|大社|宮|稲荷)$/.test(t.name)) return 2;
  if (/(寺|院|堂|庵)$/.test(t.name)) return 1;
  return 3;
}

/** Join way segments (relation outer members) into closed rings. */
function assemble(segs: Pt[][]): Pt[][] {
  const key = (p: Pt) => `${p[0]},${p[1]}`;
  const rings: Pt[][] = [], open = segs.filter((s) => s.length > 1).map((s) => [...s]);
  while (open.length) {
    let cur = open.shift()!;
    for (let guard = 0; key(cur[0]) !== key(cur[cur.length - 1]) && guard < 1000; guard++) {
      const end = key(cur[cur.length - 1]);
      const k = open.findIndex((s) => key(s[0]) === end || key(s[s.length - 1]) === end);
      if (k < 0) break;
      const s = open.splice(k, 1)[0];
      cur = cur.concat((key(s[0]) === end ? s : s.reverse()).slice(1));
    }
    if (cur.length >= 4) rings.push(cur);
  }
  return rings;
}

const M_LAT = 111000, M_LON = 111000 * Math.cos(34.68 * Math.PI / 180);
function ringArea(r: Pt[]) {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[1] * M_LON * q[0] * M_LAT - q[1] * M_LON * p[0] * M_LAT; }
  return Math.abs(a / 2);
}
export function pointInRing(lat: number, lon: number, ring: Pt[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[0] > lat) !== (b[0] > lat) && lon < ((b[1] - a[1]) * (lat - a[0])) / (b[0] - a[0]) + a[1]) inside = !inside;
  }
  return inside;
}

export function loadTemples(): Temple[] {
  const els = JSON.parse(readFileSync(join(ROOT, 'build/osm/temples.json'), 'utf8')).elements as any[];
  const out: Temple[] = [];
  const seen = new Set<string>();
  for (const e of els) {
    const t = e.tags as Record<string, string>;
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let rings: Pt[][] = [];
    if (e.type === 'way' && e.geometry) rings = assemble([e.geometry.map((p: any) => [p.lat, p.lon])]);
    else if (e.type === 'relation') rings = assemble((e.members ?? []).filter((m: any) => m.role === 'outer' && m.geometry).map((m: any) => m.geometry.map((p: any) => [p.lat, p.lon])));
    let lat: number = e.lat, lon: number = e.lon, area = 0;
    const bbox: Temple['bbox'] = [Infinity, Infinity, -Infinity, -Infinity];
    if (rings.length) {
      // centroid of the largest ring's vertices; label anchor
      const big = rings.reduce((a, r) => (ringArea(r) > ringArea(a) ? r : a));
      lat = big.reduce((a, p) => a + p[0], 0) / big.length; lon = big.reduce((a, p) => a + p[1], 0) / big.length;
      for (const r of rings) { area += ringArea(r); for (const p of r) { bbox[0] = Math.min(bbox[0], p[0]); bbox[1] = Math.min(bbox[1], p[1]); bbox[2] = Math.max(bbox[2], p[0]); bbox[3] = Math.max(bbox[3], p[1]); } }
    }
    if (lat == null || lon == null) continue;
    const whc = t['heritage:operator'] === 'whc' || !!t['ref:whc'];
    const r: 1 | 2 | 3 = whc ? 1 : t.heritage || (t.wikidata && t['name:en']) ? 2 : 3;
    out.push({
      i: out.length, name: t.name, en: t['name:en'] ?? '', rel: religion(t), r, lat, lon, rings, bbox, area,
      wikipedia: t.wikipedia ?? '', heritage: whc ? 'whc' : t['heritage:type'] ?? (t.heritage ? 'heritage' : ''),
    });
  }
  return out;
}

/** Lookup of the innermost (smallest) temple ground containing a point. */
export function templeIndex(temples: Temple[]) {
  const G = 0.005, grid = new Map<string, Temple[]>();
  for (const t of temples) {
    if (!t.rings.length) continue;
    for (let a = Math.floor(t.bbox[0] / G); a <= Math.floor(t.bbox[2] / G); a++)
      for (let b = Math.floor(t.bbox[1] / G); b <= Math.floor(t.bbox[3] / G); b++) {
        const k = `${a}_${b}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(t);
      }
  }
  return (lat: number, lon: number): Temple | undefined => {
    let best: Temple | undefined;
    for (const t of grid.get(`${Math.floor(lat / G)}_${Math.floor(lon / G)}`) ?? []) {
      if (lat < t.bbox[0] || lat > t.bbox[2] || lon < t.bbox[1] || lon > t.bbox[3]) continue;
      if (best && t.area >= best.area) continue;
      if (t.rings.some((r) => pointInRing(lat, lon, r))) best = t;
    }
    return best;
  };
}
