// Download peaks, landmarks, temples/shrines/castles and the buildings inside their
// grounds from OpenStreetMap (Overpass API) into build/osm/.
// Data © OpenStreetMap contributors, ODbL.
//
//   node scripts/fetch-osm.ts [--force]
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build/osm');
// osaka.tif extent (peaks) and Osaka City
const DEM_BBOX = '34.169,134.996,35.091,136.062';
const CITY_BBOX = '34.57,135.37,34.78,135.61';
// temples and shrines with a Wikipedia article or Wikidata item (many Osaka temples,
// e.g. Hozen-ji, only have the latter), and castle grounds (the keep is a building inside)
const TEMPLES = `(
    nwr["amenity"="place_of_worship"]["name"]["wikipedia"];
    nwr["amenity"="place_of_worship"]["name"]["wikidata"];
    nwr["landuse"="religious"]["name"]["wikipedia"];
    nwr["historic"="castle"]["name"]["wikipedia"][!"building"];
  )`;

const queries: Record<string, string> = {
  peaks: `[out:json][timeout:120];node["natural"~"^(peak|volcano)$"]["name"](${DEM_BBOX});out;`,
  landmarks: `[out:json][timeout:240][bbox:${CITY_BBOX}];(
    way["building"]["name"];
    nwr["tourism"~"^(attraction|museum|viewpoint|zoo|aquarium|theme_park|gallery)$"]["name"];
    nwr["historic"~"^(castle|monument|memorial|archaeological_site|tomb|palace|city_gate)$"]["name"];
    nwr["man_made"~"^(tower|bridge)$"]["name"];
    node["railway"="station"]["name"];
    nwr["leisure"~"^(park|garden|stadium)$"]["name"]["wikidata"];
  );out geom tags;`,
  temples: `[out:json][timeout:240][bbox:${CITY_BBOX}];${TEMPLES};out geom tags;`,
  // building footprints inside temple grounds, used where PLATEAU has no buildings
  'temple-buildings': `[out:json][timeout:300][bbox:${CITY_BBOX}];${TEMPLES}->.t;.t map_to_area->.a;(
    way["building"](area.a);
    way["building:part"](area.a);
  );out geom tags;`,
};

// The public servers are often busy (429/504): retry, alternating mirrors.
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
async function overpass(name: string, q: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = SERVERS[attempt % SERVERS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'osaka_viewer-preprocess/0.1', Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{') && !/"remark":\s*"runtime error/.test(text)) return text;
      console.warn(`${name}: ${new URL(url).host} HTTP ${res.status}, retrying`);
    } catch (e) { console.warn(`${name}: ${new URL(url).host} ${(e as Error).message}, retrying`); }
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw new Error(`${name}: Overpass failed`);
}

mkdirSync(OUT, { recursive: true });
for (const [name, q] of Object.entries(queries)) {
  const file = join(OUT, `${name}.json`);
  if (existsSync(file) && !process.argv.includes('--force')) { console.log(`${name}: cached`); continue; }
  const text = await overpass(name, q);
  writeFileSync(file, text);
  console.log(`${name}: ${JSON.parse(text).elements.length} elements`);
}
