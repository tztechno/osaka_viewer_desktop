// Build public/data/labels/labels.json from OSM peaks/temples/landmarks and PLATEAU building names.
// Run after build-buildings.ts, build-terrain.ts, fetch-osm.ts and build-osm-buildings.ts.
//
// Label kinds: p = peak, t = temple/shrine/castle (OSM, with a Wikipedia article or Wikidata item),
// l = landmark (OSM), s = station, f = facility (PLATEAU gml:name)
// Rank 1 = visible from far away, 3 = only nearby.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemples, templeIndex } from './temples.ts';
import Kuroshiro from 'kuroshiro';
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const B = (f: string) => join(ROOT, 'build', f);
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

// ---------- terrain sampling (corrected DEM, decimetres) ----------
const TDIR = join(ROOT, 'public/data/terrain');
const meta = json(join(TDIR, 'meta.json'));
const chunks = new Map<string, Int16Array>();
function demAt(row: number, col: number) {
  row = Math.max(0, Math.min(meta.height - 1, row)); col = Math.max(0, Math.min(meta.width - 1, col));
  const S = meta.chunk.size, r = Math.floor(row / S), c = Math.floor(col / S), key = `${r}_${c}`;
  let a = chunks.get(key);
  if (!a) { const b = readFileSync(join(TDIR, `c_${key}.bin`)); a = new Int16Array(b.buffer, b.byteOffset, b.length / 2); chunks.set(key, a); }
  return a[(row - r * S) * (S + 1) + (col - c * S)] * meta.scale;
}
const cell = (lat: number, lon: number) => [Math.floor((meta.north - lat) / meta.res), Math.floor((lon - meta.west) / meta.res)];
const groundAt = (lat: number, lon: number) => { const [r, c] = cell(lat, lon); return demAt(r, c); };
function maxAround(lat: number, lon: number, rad: number) {
  const [r0, c0] = cell(lat, lon); let best = { z: -1e9, r: r0, c: c0 };
  for (let r = r0 - rad; r <= r0 + rad; r++) for (let c = c0 - rad; c <= c0 + rad; c++) { const z = demAt(r, c); if (z > best.z) best = { z, r, c }; }
  return best;
}

// ---------- PLATEAU building index ----------
// PLATEAU buildings plus the OSM buildings added in temple grounds and for towers
const ib = Buffer.concat([readFileSync(B('bldg-index.bin')), readFileSync(B('osm-bldg-index.bin'))]);
const idx = new Float64Array(ib.buffer, ib.byteOffset, ib.length / 8); // lat, lon, base, top
const G = 0.001, grid = new Map<string, number[]>();
for (let i = 0; i < idx.length / 4; i++) {
  const k = `${Math.floor(idx[4 * i] / G)}_${Math.floor(idx[4 * i + 1] / G)}`;
  (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
}
function bldgsIn(s: number, w: number, n: number, e: number) {
  const out: number[] = [];
  for (let a = Math.floor(s / G); a <= Math.floor(n / G); a++) for (let b = Math.floor(w / G); b <= Math.floor(e / G); b++)
    for (const i of grid.get(`${a}_${b}`) ?? []) { const la = idx[4 * i], lo = idx[4 * i + 1]; if (la >= s && la <= n && lo >= w && lo <= e) out.push(i); }
  return out;
}
const M_LAT = 111000, M_LON = 111000 * Math.cos(34.68 * Math.PI / 180);
const dist = (a: number, b: number, c: number, d: number) => Math.hypot((a - c) * M_LAT, (b - d) * M_LON);
function nearestBldg(lat: number, lon: number, maxM: number) {
  const d = maxM / M_LAT * 1.5; let best = -1, bd = maxM;
  for (const i of bldgsIn(lat - d, lon - d, lat + d, lon + d)) { const x = dist(lat, lon, idx[4 * i], idx[4 * i + 1]); if (x < bd) { bd = x; best = i; } }
  return best;
}
function pip(lat: number, lon: number, ring: { lat: number; lon: number }[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > lat) !== (b.lat > lat) && lon < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}

// ---------- romanization ----------
const K = (Kuroshiro as any).default ?? Kuroshiro, KA = (KuromojiAnalyzer as any).default ?? KuromojiAnalyzer;
const kuro = new K(); await kuro.init(new KA());
// readings that the morphological analyser gets wrong for Osaka place names
const READINGS: Record<string, string> = {
  平野: 'ひらの', 天王寺: 'てんのうじ', 生野: 'いくの', 城東: 'じょうとう', 都島: 'みやこじま', 此花: 'このはな', 浪速: 'なにわ',
  阿倍野: 'あべの', 住吉: 'すみよし', 西成: 'にしなり', 東成: 'ひがしなり', 鶴見: 'つるみ', 旭: 'あさひ', 淀川: 'よどがわ', 大正: 'たいしょう',
  天満: 'てんま', 梅田: 'うめだ', 難波: 'なんば', 心斎橋: 'しんさいばし', 本町: 'ほんまち', 京橋: 'きょうばし', 森ノ宮: 'もりのみや',
  東住吉: 'ひがしすみよし', 東淀川: 'ひがしよどがわ', 東大阪: 'ひがしおおさか', 天下茶屋: 'てんがちゃや', 岸里: 'きしのさと', 中之島: 'なかのしま', 堺筋: 'さかいすじ', 谷町: 'たにまち', 上本町: 'うえほんまち',
  長居: 'ながい', 喜連: 'きれ', 加美: 'かみ', 瓜破: 'うりわり', 杭全: 'くまた', 我孫子: 'あびこ', 長吉: 'ながよし', 放出: 'はなてん',
  十三: 'じゅうそう', 御幣島: 'みてじま', 柴島: 'くにじま', 野江: 'のえ', 蒲生: 'がもう', 今里: 'いまざと', 鶴橋: 'つるはし', 玉造: 'たまつくり',
  四天王寺: 'してんのうじ', 恵美須: 'えびす', 新世界: 'しんせかい', 南港: 'なんこう', 咲洲: 'さきしま', 舞洲: 'まいしま', 夢洲: 'ゆめしま',
  六甲: 'ろっこう', 生駒: 'いこま', 金剛: 'こんごう', 葛城: 'かつらぎ', 比叡: 'ひえい', 愛宕: 'あたご', 交野: 'かたの', 箕面: 'みのお',
  // names with characters the dictionary does not know (readings from Wikipedia / OSM name:ja-Hira where available)
  灯明: 'とうみょう', 船谷: 'ふなたに', 掃雲: 'そううん', 逢ヶ: 'おうが', 馳渡: 'かけわたり', 満灯: 'まんどう', 万灯: 'まんどう', 雨引: 'あまびき',
  摩利支天: 'まりしてん', 金胎寺: 'こんたいじ', 胎金寺: 'たいこんじ', 靱本町: 'うつぼほんまち', 医専: 'いせん', 成蹊: 'せいけい', 新聞舗: 'しんぶんほ',
  吾彦: 'あびこ', 思温: 'しおん', 偕星: 'かいせい', 海遊館: 'かいゆうかん', 止止呂支比売命: 'とどろきひめみこと', 花乃井: 'はなのい', 思斉: 'しせい',
  応典院: 'おうてんいん', 金台: 'こんたい', 安楽: 'あんらく', 素盞嗚尊: 'すさのおのみこと', 貴布祢: 'きふね', 一乗: 'いちじょう', 長宝: 'ちょうほう',
  方違: 'ほうちがい', 西証: 'さいしょう', 阿麻美許曽: 'あまみこそ', 発光院: 'ほっこういん', 市正: 'いちのかみ',
  成蹊女子: 'せいけい じょし', 小林新聞舗: 'こばやし しんぶんほ', 万灯籠: 'まんとうろう', 広徳: 'こうとく', 広済: 'こうさい', 生国魂: 'いくくにたま',
};
// readings are keyed on the new character forms
// old character forms (舊字體) that the dictionary does not know
const OLD_FORMS: Record<string, string> = {
  會: '会', 樂: '楽', 寶: '宝', 寳: '宝', 乘: '乗', 證: '証', 發: '発', 應: '応', 臺: '台', 舩: '船', 燈: '灯', 禰: '祢', 曾: '曽',
  國: '国', 學: '学', 舊: '旧', 圓: '円', 廣: '広', 濱: '浜', 澤: '沢', 邊: '辺', 櫻: '桜', 縣: '県', 驛: '駅', 龍: '竜', 德: '徳', 齋: '斎', 齊: '斉',
};
const OLD_RE = new RegExp(`[${Object.keys(OLD_FORMS).join('')}]`, 'g');
const JA_RE = /[぀-ヿ㐀-鿿]/;
// OSM name:en sometimes holds a kana reading or a Japanese middle dot; ignore the former, clean the latter
const osmEn = (s?: string) => { const v = (s ?? '').replace(/\s*[・･]\s*/g, ' ').trim(); return JA_RE.test(v) ? '' : v; };
// Common words translated instead of romanized (longest match first).
const TERMS: Record<string, string> = {
  株式会社: '', 有限会社: '', 本社: 'Head Office', 本店: 'Head Office', 支店: 'Branch', 支社: 'Branch', 営業所: 'Office', 事務所: 'Office', 出張所: 'Branch Office',
  大阪市立: 'Osaka City', 大阪府立: 'Osaka Prefectural', 市立: 'Municipal', 府立: 'Prefectural', 国立: 'National', 私立: '',
  大阪市: 'Osaka City', 大阪府: 'Osaka Prefecture', 大阪: 'Osaka', 関西: 'Kansai', 近畿: 'Kinki', 西日本: 'West Japan', 日本: 'Japan',
  総合医療センター: 'General Medical Center', 医療センター: 'Medical Center', 医学部附属病院: 'University Hospital', 附属病院: 'University Hospital', 病院: 'Hospital',
  大学: 'University', 短期大学: 'Junior College', 専門学校: 'Vocational School', 高等学校: 'High School', 中学校: 'Junior High School', 小学校: 'Elementary School', 学校: 'School', 学園: 'Gakuen', キャンパス: 'Campus',
  庁舎: 'Government Building', 区役所: 'Ward Office', 市役所: 'City Hall', 警察本部: 'Police Headquarters', 警察署: 'Police Station', 消防署: 'Fire Station', 消防局: 'Fire Department', 郵便局: 'Post Office', 税務署: 'Tax Office', 労働局: 'Labour Bureau', 裁判所: 'Court', 放送局: 'Broadcasting Station',
  美術館: 'Art Museum', 博物館: 'Museum', 資料館: 'Museum', 図書館: 'Library', 体育館: 'Gymnasium', 会館: 'Hall', 公会堂: 'Public Hall', 劇場: 'Theater', 水族館: 'Aquarium', 動物園: 'Zoo', 植物園: 'Botanical Garden',
  公園: 'Park', 神社: 'Shrine', 天満宮: 'Tenmangu Shrine', 八幡宮: 'Hachimangu Shrine', 神宮: 'Jingu Shrine', 大社: 'Grand Shrine', 寺: 'Temple', 城: 'Castle', 天守閣: 'Main Tower', 大橋: 'Bridge', 古墳: 'Kofun', 遺跡: 'Site', 跡: 'Site',
  南館: 'South Wing', 北館: 'North Wing', 東館: 'East Wing', 西館: 'West Wing', 本館: 'Main Building', 新館: 'Annex', 別館: 'Annex',
  ビルディング: 'Building', ビル: 'Building', タワーズ: 'Towers', タワー: 'Tower', プラザ: 'Plaza', センター: 'Center', ホテル: 'Hotel', パーク: 'Park', シティ: 'City', スクエア: 'Square',
  ゲート: 'Gate', ガーデン: 'Garden', ベイ: 'Bay', ノース: 'North', サウス: 'South', イースト: 'East', ウエスト: 'West', ウェスト: 'West', ハウス: 'House', ホール: 'Hall', ワールド: 'World',
  スカイ: 'Sky', グランド: 'Grand', グラン: 'Grand', フロント: 'Front', ヒルズ: 'Hills', レジデンス: 'Residence', テラス: 'Terrace', クロス: 'Cross', ツイン: 'Twin', ステーション: 'Station',
  モール: 'Mall', オフィス: 'Office', スタジアム: 'Stadium', ドーム: 'Dome', アリーナ: 'Arena', ブリッジ: 'Bridge', ザ: 'The', エアポート: 'Airport', ターミナル: 'Terminal', マーケット: 'Market',
  駅: 'Station', 曲輪: 'Kuruwa Bailey', プレミスト: 'Premist',
};
const READING_LIST = Object.entries(READINGS).sort((a, b) => b[0].length - a[0].length);
const TERM_RE = new RegExp(Object.keys(TERMS).sort((a, b) => b.length - a.length).join('|'), 'g');
const cap = (s: string) => s.replace(/(^|[\s(-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
const toRomaji = async (s: string): Promise<string> => kuro.convert(s, { to: 'romaji', romajiSystem: 'hepburn' });
// A hiragana reading comes out of the analyser garbled (じょう -> jiyou) and without macrons (とう -> tou), so after
// converting the whole name as before, swap that reading's raw romaji for a clean one (katakana, long vowels shortened
// like the macron-stripped kanji readings). The rest of the name keeps its context-dependent reading (天満橋 -> hashi).
const readingFix = new Map<string, [string, string]>();
async function fixReading(r: string, v: string) {
  if (!readingFix.has(v)) {
    const kata = v.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
    const raw = await toRomaji(v);
    // keep n/m before b, m, p as the hiragana reading had it (Namba, Tenma)
    let good = (await toRomaji(kata)).replace(/ou/g, 'o').replace(/uu/g, 'u');
    if (!/m[bmp]/.test(raw)) good = good.replace(/m(?=[bmp])/g, 'n');
    readingFix.set(v, [raw, good]);
  }
  const [raw, good] = readingFix.get(v)!;
  return r.split(raw).join(good);
}
async function roma(s: string) {
  if (!s) return '';
  s = s.normalize('NFKC');
  s = s.replace(OLD_RE, c => OLD_FORMS[c]);
  const parts: string[] = [];
  let last = 0;
  const flush = async (chunk: string) => {
    for (let piece of chunk.split(/[\s・･,、]+|(?=[()])|(?<=[()])/)) {
      if (!piece) continue;
      if (/^[\x00-\x7f]+$/.test(piece)) { parts.push(piece); continue; }
      const used: string[] = [];
      for (const [k, v] of READING_LIST) if (piece.includes(k)) { piece = piece.split(k).join(v); used.push(v); }
      let r = await toRomaji(piece);
      for (const v of used) r = await fixReading(r, v);
      parts.push(cap(r.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
    }
  };
  // a one-character term inside a word with a known reading stays part of it (寺 in the peak name 金胎寺山)
  const covered: [number, number][] = [];
  for (const [k] of READING_LIST) for (let i = s.indexOf(k); i >= 0; i = s.indexOf(k, i + 1)) covered.push([i, i + k.length]);
  for (const m of s.matchAll(TERM_RE)) {
    // single-character terms only at the end of a word (e.g. 橋 in 天満橋 stays part of the name)
    if (m[0].length === 1 && m.index! + 1 < s.length && !/[\s・()]/.test(s[m.index! + 1])) continue;
    if (m[0].length === 1 && covered.some(([b, e]) => b <= m.index! && m.index! < e)) continue;
    await flush(s.slice(last, m.index));
    if (TERMS[m[0]]) parts.push(TERMS[m[0]]);
    last = m.index! + m[0].length;
  }
  await flush(s.slice(last));
  return parts.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/\s+/g, ' ').trim();
}
const RULES: [RegExp, (m: string[]) => Promise<string>][] = [
  [/^(.*)警察署(.+)交番$/, async m => `${await roma(m[2])} Police Box`],
  [/^(.*)警察署$/, async m => `${await roma(m[1])} Police Station`],
  [/^大阪市消防局(.*)消防署(.+)出張所$/, async m => `${await roma(m[2])} Fire Station Branch`],
  [/^大阪市消防局(.+)消防署$/, async m => `${await roma(m[1])} Fire Station`],
  [/^大阪市消防局$/, async () => 'Osaka City Fire Department'],
  [/^(?:市立|府立|私立|国立)?(.+)小学校(.*)$/, async m => `${await roma(m[1])} Elementary School${m[2] ? ' ' + await roma(m[2]) : ''}`],
  [/^(?:市立|府立|私立|国立)?(.+)中学校(.*)$/, async m => `${await roma(m[1])} Junior High School${m[2] ? ' ' + await roma(m[2]) : ''}`],
  [/^(?:市立|府立|私立|国立)?(.+)高等学校(.*)$/, async m => `${await roma(m[1])} High School${m[2] ? ' ' + await roma(m[2]) : ''}`],
  [/^(?:市立|府立|私立|国立)?(.+)支援学校$/, async m => `${await roma(m[1])} Special Needs School`],
];
async function translate(name: string) {
  for (const [re, f] of RULES) { const m = re.exec(name); if (m) return f(m); }
  return roma(name);
}

// ---------- labels ----------
// g: temples only, 1 = Buddhist temple, 2 = Shinto shrine, 3 = other, 4 = castle; w: Wikipedia article ("ja:四天王寺")
interface Label { k: 'p' | 't' | 'l' | 's' | 'f'; ja: string; en: string; lat: number; lon: number; z: number; r: 1 | 2 | 3; e?: number; g?: number; w?: string }
const labels: Label[] = [];
const r6 = (x: number) => Math.round(x * 1e6) / 1e6, r1 = (x: number) => Math.round(x * 10) / 10;
const fixEn = (s: string) => s.replace(/^Mt\.(?=\S)/, 'Mt. ').replace(/^Mount /, 'Mt. ');

// peaks
for (const e of json(B('osm/peaks.json')).elements) {
  const t = e.tags;
  const top = maxAround(e.lat, e.lon, 2);
  if (top.z <= 0 && !t.ele) continue;
  const ele = Number.parseFloat(t.ele) || top.z;
  const base = t.name.replace(/(ヶ岳|ケ岳|が岳|岳|山|峰|嶺)$/, '');
  const en = osmEn(t['name:en']) ? fixEn(osmEn(t['name:en'])) : base === t.name ? await roma(t.name) : `Mt. ${await roma(base)}`;
  let r: 1 | 2 | 3 = ele >= 600 ? 1 : ele >= 250 ? 2 : 3;
  if (t.wikidata && r > 1) r = (r - 1) as 1 | 2;
  labels.push({ k: 'p', ja: t.name, en, lat: r6(e.lat), lon: r6(e.lon), z: r1(Math.max(top.z, 0) + 2), r, e: Math.round(ele) });
}
const nPeaks = labels.length;

// temples, shrines and castles: anchored on the tallest building in the grounds (main hall, pagoda, keep)
const temples = loadTemples();
for (const t of temples) {
  let bi = -1;
  if (t.rings.length) {
    for (const i of bldgsIn(t.bbox[0], t.bbox[1], t.bbox[2], t.bbox[3]))
      if (t.rings.some(r => pip(idx[4 * i], idx[4 * i + 1], r.map(p => ({ lat: p[0], lon: p[1] })))) && (bi < 0 || idx[4 * i + 3] > idx[4 * bi + 3])) bi = i;
  } else bi = nearestBldg(t.lat, t.lon, 30);
  const lat = bi >= 0 ? idx[4 * bi] : t.lat, lon = bi >= 0 ? idx[4 * bi + 1] : t.lon;
  const z = bi >= 0 ? idx[4 * bi + 3] + 3 : groundAt(lat, lon) + 8;
  const h = bi >= 0 ? idx[4 * bi + 3] - idx[4 * bi + 2] : 0;
  const en = osmEn(t.en) || await translate(t.name);
  // castles are landmarks seen from far away
  labels.push({ k: 't', ja: t.name, en, lat: r6(lat), lon: r6(lon), z: r1(z), r: t.rel === 4 ? 1 : t.r, e: h ? Math.round(h) : undefined, g: t.rel, w: t.wikipedia || undefined });
}
const templeNames = new Set(temples.map(t => t.name));
const templeAt = templeIndex(temples);

// OSM landmarks and stations
const osm = json(B('osm/landmarks.json')).elements as any[];
const enByName = new Map<string, { lat: number; lon: number; en: string }[]>();
const stations = new Map<string, Label>();
// names that mean nothing on their own (wings, numbered blocks)
const GENERIC = /^(.{0,2}[館棟]|.*号[館棟]|.{1,2}(棟|ウイング|ウィング))$/;
for (const e of osm) {
  const t = e.tags, name: string = t.name;
  const ring: { lat: number; lon: number }[] | undefined = e.type === 'way' ? e.geometry
    : e.type === 'relation' ? e.members?.filter((m: any) => m.role === 'outer' && m.geometry).flatMap((m: any) => m.geometry) : undefined;
  let lat = e.lat, lon = e.lon;
  if (ring?.length) { lat = ring.reduce((a, p) => a + p.lat, 0) / ring.length; lon = ring.reduce((a, p) => a + p.lon, 0) / ring.length; }
  if (lat == null) continue;
  if (osmEn(t['name:en'])) (enByName.get(name) ?? enByName.set(name, []).get(name)!).push({ lat, lon, en: osmEn(t['name:en']) });

  // height from PLATEAU: tallest building inside the polygon, else the nearest one
  let bi = -1;
  if (ring?.length && e.type === 'way' && t.building) {
    const b = e.bounds;
    for (const i of bldgsIn(b.minlat, b.minlon, b.maxlat, b.maxlon)) if (pip(idx[4 * i], idx[4 * i + 1], ring) && (bi < 0 || idx[4 * i + 3] > idx[4 * bi + 3])) bi = i;
  } else if (!ring) bi = nearestBldg(lat, lon, t.railway ? 60 : 15);
  const h = bi >= 0 ? idx[4 * bi + 3] - idx[4 * bi + 2] : 0;
  if (bi >= 0 && (t.building || !ring)) { lat = idx[4 * bi]; lon = idx[4 * bi + 1]; }
  const z = bi >= 0 ? idx[4 * bi + 3] + 3 : groundAt(lat, lon) + 8;
  const en = osmEn(t['name:en']);

  if (t.railway === 'station') {
    const prev = stations.get(name);
    if (prev && dist(prev.lat, prev.lon, lat, lon) < 500) continue;
    const ja = name.endsWith('駅') ? name : name + '駅';
    const enS = en ? (/station$/i.test(en) ? en : `${en} Station`) : await roma(ja);
    const L: Label = { k: 's', ja, en: enS, lat: r6(lat), lon: r6(lon), z: r1(z), r: 2 };
    stations.set(name, L); labels.push(L);
    continue;
  }
  if (GENERIC.test(name)) continue;
  if (templeNames.has(name) || t.amenity === 'place_of_worship') continue;
  const notable = !!(t.wikidata || t.wikipedia);
  // sightseeing spots (hotels and guest houses are not)
  const sight = /^(attraction|museum|viewpoint|zoo|aquarium|theme_park|gallery)$/.test(t.tourism ?? '') || !!t.historic || t.leisure === 'garden' || t.man_made === 'tower';
  // (a name:en that is only a kana reading still marks the sight as worth showing)
  if (!(notable || h >= 60 || (sight && t['name:en']))) continue;
  // well-known sights are seen from far away; museums, tombs etc. from closer
  const major = notable && (/^(attraction|zoo|aquarium|theme_park)$/.test(t.tourism ?? '') || /^(castle|palace)$/.test(t.historic ?? '') || t.man_made === 'tower');
  let r: 1 | 2 | 3 = h >= 150 || major ? 1 : h >= 60 || notable ? 2 : 3;
  // halls, turrets and gates inside temple and castle grounds only show nearby
  const inTemple = templeAt(lat, lon);
  if (inTemple) r = notable && name !== inTemple.name ? 3 : r === 1 ? 2 : 3;
  labels.push({ k: 'l', ja: name, en: en || await translate(name), lat: r6(lat), lon: r6(lon), z: r1(z), r, e: h ? Math.round(h) : undefined });
}

// PLATEAU named facilities
for (const b of json(B('buildings-labels-raw.json'))) {
  const near = labels.some(l => l.k !== 'p' && (dist(l.lat, l.lon, b.lat, b.lon) < 40 || (l.ja === b.name && dist(l.lat, l.lon, b.lat, b.lon) < 300)));
  if (near) continue;
  const match = (enByName.get(b.name) ?? enByName.get(b.name.replace(/駅$/, '')))?.find(o => dist(o.lat, o.lon, b.lat, b.lon) < 500);
  if (/駅$/.test(b.name) && labels.some(l => l.k === 's' && l.ja === b.name && dist(l.lat, l.lon, b.lat, b.lon) < 800)) continue;
  const kind = /駅$/.test(b.name) ? 's' : 'f';
  const h = b.top - b.base;
  labels.push({ k: kind, ja: b.name, en: match ? (kind === 's' && !/station$/i.test(match.en) ? `${match.en} Station` : match.en) : await translate(b.name), lat: b.lat, lon: b.lon, z: r1(b.top + 3), r: kind === 's' || h >= 60 ? 2 : 3, e: Math.round(h) });
}

// de-duplicate same-name labels close together (keep the better ranked one)
labels.sort((a, b) => a.r - b.r || (b.e ?? 0) - (a.e ?? 0));
const out: Label[] = [];
for (const l of labels) if (!out.some(o => o.ja === l.ja && dist(o.lat, o.lon, l.lat, l.lon) < 300)) out.push(l);

const leftover = out.filter(l => JA_RE.test(l.en));
if (leftover.length) console.warn(`WARNING: ${leftover.length} English names still contain Japanese (add a reading to READINGS):\n` + leftover.map(l => `  ${l.ja} -> ${l.en}`).join('\n'));

mkdirSync(join(ROOT, 'public/data/labels'), { recursive: true });
writeFileSync(join(ROOT, 'public/data/labels/labels.json'), JSON.stringify(out));
const count = (k: string) => out.filter(l => l.k === k).length;
console.log(`labels: ${out.length} (peaks ${count('p')}/${nPeaks}, temples ${count('t')}, landmarks ${count('l')}, stations ${count('s')}, facilities ${count('f')}); rank1 ${out.filter(l => l.r === 1).length}`);
