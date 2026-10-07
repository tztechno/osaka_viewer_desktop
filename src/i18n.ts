export type Lang = 'ja' | 'en';

const STRINGS = {
  title: { ja: '大阪 3D ビューア', en: 'Osaka 3D Viewer' },
  labels: { ja: 'ラベル', en: 'Labels' },
  peaks: { ja: '山', en: 'Peaks' },
  temples: { ja: '神社仏閣・城', en: 'Temples, shrines & castles' },
  landmarks: { ja: '観光・名所', en: 'Sights' },
  stations: { ja: '駅', en: 'Stations' },
  facilities: { ja: '施設', en: 'Facilities' },
  buildings: { ja: '建物', en: 'Buildings' },
  imagery: { ja: '背景', en: 'Base map' },
  photo: { ja: '航空写真', en: 'Aerial photo' },
  map: { ja: '地図', en: 'Map' },
  viewpoint: { ja: '視点', en: 'Viewpoint' },
  myLocation: { ja: '現在地', en: 'My location' },
  pick: { ja: '地点をクリック', en: 'Click a spot' },
  pickHint: { ja: '地図上の地点か建物の屋上をクリックしてください', en: 'Click a spot on the ground or a rooftop' },
  goto: { ja: '移動', en: 'Go' },
  lat: { ja: '緯度', en: 'Lat' },
  lon: { ja: '経度', en: 'Lon' },
  eyeHeight: { ja: '視点の高さ (m)', en: 'Eye height (m)' },
  aglRef: { ja: '地面から', en: 'Above ground' },
  aslRef: { ja: '海抜', en: 'Above sea level' },
  groundElev: { ja: 'この地点の標高', en: 'Ground here' },
  belowGround: { ja: '指定の海抜は地面より低いため、地上 1 m に置きました', en: 'That height is below the ground here, so the eye was placed 1 m above ground' },
  agl: { ja: '地上', en: 'AGL' },
  heading: { ja: '方位 (北=0° 時計回り)', en: 'Heading (N=0°, clockwise)' },
  headingBlank: { ja: '空欄=今の向き', en: 'Blank = keep current' },
  points: { ja: '北,北北東,北東,東北東,東,東南東,南東,南南東,南,南南西,南西,西南西,西,西北西,北西,北北西', en: 'N,NNE,NE,ENE,E,ESE,SE,SSE,S,SSW,SW,WSW,W,WNW,NW,NNW' },
  compass: { ja: '端末の向きに追従', en: 'Follow device direction' },
  gps: { ja: '位置を追従', en: 'Track position' },
  overview: { ja: '全体表示', en: 'Overview' },
  lookMode: { ja: '見回しモード（ドラッグで向きを変更）', en: 'Look-around mode (drag to turn)' },
  exitLook: { ja: '地図操作に戻る', en: 'Back to map controls' },
  height: { ja: '高さ', en: 'Height' },
  storeys: { ja: '地上階数', en: 'Storeys' },
  usage: { ja: '用途', en: 'Usage' },
  address: { ja: '所在', en: 'Address' },
  elevation: { ja: '標高', en: 'Elevation' },
  temple: { ja: '寺院', en: 'Buddhist temple' },
  shrine: { ja: '神社', en: 'Shinto shrine' },
  castle: { ja: '城', en: 'Castle' },
  worship: { ja: '宗教施設', en: 'Place of worship' },
  tallest: { ja: '最も高い建物', en: 'Tallest building' },
  wikipedia: { ja: 'Wikipedia', en: 'Wikipedia' },
  heritageWhc: { ja: '世界遺産', en: 'World Heritage' },
  source: { ja: '形状', en: 'Shape' },
  srcOsm: { ja: 'OpenStreetMap から推定', en: 'Estimated from OpenStreetMap' },
  legendTemple: { ja: '寺院の建物', en: 'Temple buildings' },
  legendShrine: { ja: '神社の建物', en: 'Shrine buildings' },
  legendCastle: { ja: '城の建物', en: 'Castle buildings' },
  outside: { ja: 'データ範囲外です', en: 'Outside the data area' },
  geoError: { ja: '現在地を取得できません', en: 'Could not get your location' },
  orientError: { ja: '端末の向きを取得できません（HTTPS と許可が必要です）', en: 'Device orientation unavailable (needs HTTPS and permission)' },
  calibrate: { ja: '方位補正', en: 'Heading offset' },
  share: { ja: 'URLをコピー', en: 'Copy link' },
  copied: { ja: 'コピーしました', en: 'Copied' },
  help: {
    ja: 'マウス: 左ドラッグ=移動, 右ドラッグ/ホイール=ズーム, Ctrl+ドラッグ=回転・傾き。見回しモードでは WASD/矢印で移動、Q/E で上下。',
    en: 'Mouse: left-drag = pan, right-drag/wheel = zoom, Ctrl+drag = rotate/tilt. In look-around mode use WASD/arrows to walk, Q/E for up/down.',
  },
} satisfies Record<string, Record<Lang, string>>;

export type Key = keyof typeof STRINGS;

let lang: Lang = (localStorage.getItem('lang') as Lang) || (navigator.language.startsWith('ja') ? 'ja' : 'en');
const listeners: (() => void)[] = [];

export const t = (k: Key) => STRINGS[k][lang];
export const getLang = () => lang;
export function setLang(l: Lang) {
  lang = l;
  try { localStorage.setItem('lang', l); } catch { /* storage may be unavailable */ }
  document.documentElement.lang = l;
  listeners.forEach((f) => f());
}
export const onLang = (f: () => void) => listeners.push(f);

export const USAGE: Record<string, [string, string]> = {
  '401': ['業務施設', 'Office'],
  '402': ['商業施設', 'Commercial'],
  '403': ['宿泊施設', 'Accommodation'],
  '404': ['商業系複合施設', 'Mixed commercial'],
  '411': ['住宅', 'House'],
  '412': ['共同住宅', 'Apartment'],
  '413': ['店舗等併用住宅', 'House with shop'],
  '414': ['店舗等併用共同住宅', 'Apartment with shops'],
  '415': ['作業所併用住宅', 'House with workshop'],
  '421': ['官公庁施設', 'Government'],
  '422': ['文教厚生施設', 'Education / welfare'],
  '431': ['運輸倉庫施設', 'Transport / warehouse'],
  '441': ['工場', 'Factory'],
  '451': ['農林漁業用施設', 'Agriculture / fishery'],
  '452': ['供給処理施設', 'Utility'],
  '453': ['防衛施設', 'Defence'],
  '454': ['その他', 'Other'],
  '461': ['不明', 'Unknown'],
};
export const usageName = (code: string) => USAGE[code]?.[lang === 'ja' ? 0 : 1] ?? '';
