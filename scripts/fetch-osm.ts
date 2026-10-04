// Download peaks and landmarks from OpenStreetMap (Overpass API) into build/osm/.
// Data © OpenStreetMap contributors, ODbL.
//
//   node scripts/fetch-osm.ts [--force]
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build/osm');
const DEM_BBOX = '34.169,134.996,35.091,136.062';
const CITY_BBOX = '34.57,135.37,34.78,135.61';

const queries: Record<string, string> = {
  peaks: `[out:json][timeout:120];node["natural"~"^(peak|volcano)$"]["name"](${DEM_BBOX});out;`,
  landmarks: `[out:json][timeout:240][bbox:${CITY_BBOX}];(
    way["building"]["name"];
    nwr["tourism"~"^(attraction|museum|viewpoint|zoo|aquarium|theme_park)$"]["name"];
    nwr["historic"~"^(castle|monument|memorial|archaeological_site|tomb)$"]["name"];
    nwr["man_made"~"^(tower|bridge)$"]["name"];
    node["railway"="station"]["name"];
    nwr["amenity"="place_of_worship"]["name"]["wikidata"];
    nwr["leisure"~"^(park|stadium)$"]["name"]["wikidata"];
  );out geom tags;`,
};

mkdirSync(OUT, { recursive: true });
for (const [name, q] of Object.entries(queries)) {
  const file = join(OUT, `${name}.json`);
  if (existsSync(file) && !process.argv.includes('--force')) { console.log(`${name}: cached`); continue; }
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': 'osaka_viewer-preprocess/0.1', Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const text = await res.text();
  writeFileSync(file, text);
  console.log(`${name}: ${JSON.parse(text).elements.length} elements`);
}
