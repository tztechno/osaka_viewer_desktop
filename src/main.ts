import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import {
  Cartesian2, Cartesian3, Cartographic, Cesium3DTileFeature, Cesium3DTileset, Cesium3DTileStyle, Color, Credit, CustomShader, LightingModel,
  ImageryLayer, JulianDate, Rectangle, Math as CMath, Matrix4, PerspectiveFrustum, ScreenSpaceEventHandler, ScreenSpaceEventType,
  Transforms, UrlTemplateImageryProvider, Viewer,
} from 'cesium';
import { Dem } from './terrain';
import { Labels, type Kind, type LabelData } from './labels';
import { DeviceFollower } from './orientation';
import { getLang, onLang, setLang, t, usageName, type Key, type Lang } from './i18n';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const isMobile = matchMedia('(pointer: coarse)').matches;
const EYE = 1.6;
const DEFAULT_VIEW = { lon: 135.385, lat: 34.6, h: 2200, heading: 52, pitch: -14 };

// ---------------- viewer ----------------
const dem = await Dem.load('./data/terrain');
const gsiCredit = new Credit('<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>');
// GSI tiles only cover Japan; don't request anything outside it
const japan = Rectangle.fromDegrees(122, 20, 154, 46);
const photoLayer = new ImageryLayer(new UrlTemplateImageryProvider({
  url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', minimumLevel: 5, maximumLevel: 18, rectangle: japan, credit: gsiCredit,
}));
const mapLayer = new ImageryLayer(new UrlTemplateImageryProvider({
  url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', minimumLevel: 5, maximumLevel: 18, rectangle: japan, credit: gsiCredit,
}), { show: false });

const viewer = new Viewer('cesium', {
  baseLayer: photoLayer,
  terrainProvider: dem.provider(),
  animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false,
  selectionIndicator: false, requestRenderMode: true, maximumRenderTimeChange: Infinity,
  msaaSamples: isMobile ? 1 : 4,
});
viewer.imageryLayers.add(mapLayer);
const scene = viewer.scene, camera = viewer.camera, canvas = scene.canvas;
const ssc = scene.screenSpaceCameraController;
viewer.creditDisplay.addStaticCredit(new Credit('PLATEAU (国土交通省)'));
viewer.creditDisplay.addStaticCredit(new Credit('© OpenStreetMap contributors'));
// fixed midday sun (JST) for consistent building shading
viewer.clock.currentTime = JulianDate.fromDate(new Date(new Date().toISOString().slice(0, 10) + 'T03:00:00Z'));
viewer.clock.shouldAnimate = false;
scene.globe.depthTestAgainstTerrain = true;
scene.globe.baseColor = Color.fromCssColorString('#1c3346');
scene.globe.maximumScreenSpaceError = isMobile ? 3 : 2;
scene.fog.density = 1.0e-4;
if (scene.moon) scene.moon.show = false;
ssc.minimumZoomDistance = 1;
(camera.frustum as PerspectiveFrustum).fov = CMath.toRadians(60);

// ---------------- buildings ----------------
// PLATEAU buildings, plus OSM buildings filling temple grounds PLATEAU lacks
const tileset = await Cesium3DTileset.fromUrl('./data/bldg/tileset.json', {
  maximumScreenSpaceError: isMobile ? 24 : 16,
});
const osmTileset = await Cesium3DTileset.fromUrl('./data/osmbldg/tileset.json', {
  maximumScreenSpaceError: isMobile ? 24 : 16,
});
// t: 1 = temple, 2 = shrine, 3 = other place of worship, 4 = castle (see scripts/tiles.ts)
const TEMPLE_CSS = ['', '#c9874f', '#e2583e', '#b9a3d6', '#6fa58c'];
const buildingStyle = () => new Cesium3DTileStyle({
  color: {
    conditions: [
      ['${t} === 1', `color('${TEMPLE_CSS[1]}')`],
      ['${t} === 2', `color('${TEMPLE_CSS[2]}')`],
      ['${t} === 3', `color('${TEMPLE_CSS[3]}')`],
      ['${t} === 4', `color('${TEMPLE_CSS[4]}')`],
      ["${name} !== ''", "color('#ffe2b0')"],
      ['${h} >= 60', "color('#dfe8f5')"],
      ['true', "color('#f3f0ea')"],
    ],
  },
});
tileset.style = buildingStyle();
osmTileset.style = buildingStyle();
// simple architectural-model shading: ambient + sun diffuse, no PBR/IBL tint
tileset.customShader = new CustomShader({
  lightingModel: LightingModel.UNLIT,
  fragmentShaderText: `
    void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      // tiles carry no normals: flat face normal from screen-space derivatives
      vec3 pe = fsInput.attributes.positionEC;
      vec3 n = normalize(cross(dFdx(pe), dFdy(pe)));
      vec3 up = normalize(czm_normal * vec3(0.0, 0.0, 1.0)); // tile frame is east-north-up
      vec3 sun = normalize(czm_sunDirectionEC);
      vec3 key = normalize(sun - 0.75 * dot(sun, up) * up);   // lowered sun: lights walls, not only roofs
      float d = max(dot(n, key), 0.0);
      float sky = 0.5 + 0.5 * dot(n, up);
      material.diffuse *= 0.5 + 0.22 * sky + 0.38 * d;
    }`,
});
osmTileset.customShader = new CustomShader({ lightingModel: LightingModel.UNLIT, fragmentShaderText: tileset.customShader!.fragmentShaderText });
scene.primitives.add(tileset);
scene.primitives.add(osmTileset);

// ---------------- labels ----------------
const labels = new Labels(scene, dem);
await labels.load('./data/labels/labels.json');

// ---------------- i18n ----------------
function applyI18n() {
  document.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => (el.textContent = t(el.dataset.t as Key)));
  document.title = t('title');
  field('heading').placeholder = t('headingBlank');
  showHeading();
  $('#q-lang').textContent = getLang() === 'ja' ? 'EN' : '日本';
  $('#q-locate').title = t('myLocation');
  $('#q-compass').title = t('compass');
  $('#q-labels').title = t('labels');
  document.querySelectorAll<HTMLButtonElement>('#lang-seg button').forEach((b) => b.classList.toggle('on', b.dataset.lang === getLang()));
  labels.applyLang();
  if (infoState) showInfo(infoState);
}
onLang(applyI18n);

// ---------------- toast / info ----------------
let toastTimer = 0;
function toast(msg: string) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3000);
}

interface BldgAttrs { id: string; s: number; u: string; addr: string; tn: string }
type InfoState = { kind: 'bldg'; f: Cesium3DTileFeature; a?: BldgAttrs } | { kind: 'label'; d: LabelData };

// Per-feature details live next to each tile (<mesh>_{t,d}.json), fetched on demand.
const attrCache = new Map<string, Promise<Record<keyof BldgAttrs, unknown[]>>>();
async function buildingAttrs(f: Cesium3DTileFeature): Promise<BldgAttrs | undefined> {
  // `content` is a runtime getter Cesium marks @private (absent from the typings)
  const url = String((f as unknown as { content?: { url?: string } }).content?.url ?? '').replace(/\.b3dm(\?.*)?$/, '.json');
  if (!url.endsWith('.json')) return undefined;
  let p = attrCache.get(url);
  if (!p) { p = fetch(url).then((r) => r.json()); attrCache.set(url, p); }
  try {
    const cols = await p, i = f.featureId;
    return { id: cols.id[i] as string, s: cols.s[i] as number, u: cols.u[i] as string, addr: cols.addr[i] as string, tn: (cols.tn?.[i] as string) ?? '' };
  } catch { attrCache.delete(url); return undefined; }
}
function showBuilding(f: Cesium3DTileFeature) {
  showInfo({ kind: 'bldg', f });
  void buildingAttrs(f).then((a) => { if (a && infoState?.kind === 'bldg' && infoState.f === f) showInfo({ kind: 'bldg', f, a }); });
}
let infoState: InfoState | undefined;
let highlighted: Cesium3DTileFeature | undefined;
function showInfo(s: InfoState | undefined) {
  infoState = s;
  const el = $('#info');
  if (highlighted) { try { highlighted.color = Color.WHITE; } catch { /* tile unloaded */ } highlighted = undefined; }
  if (!s) { el.hidden = true; scene.requestRender(); return; }
  const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const rows: [string, string][] = [];
  let title = '', sub = '', link: LabelData | undefined;
  const templeKind = (g?: number) => (g === 1 ? t('temple') : g === 2 ? t('shrine') : g === 4 ? t('castle') : t('worship'));
  if (s.kind === 'bldg') {
    const { f, a } = s;
    highlighted = f; f.color = Color.fromCssColorString('#ffb347');
    const temple = a?.tn ? labels.find('t', a.tn) : undefined;
    const tName = temple ? (getLang() === 'ja' ? temple.ja : temple.en) : a?.tn;
    title = f.getProperty('name') || (tName && (getLang() === 'ja' ? `${tName}の建物` : `Building at ${tName}`)) || (a && usageName(a.u)) || '—';
    sub = a ? [a.addr, a.id].filter(Boolean).join(' · ') : '…';
    if (tName && f.getProperty('name')) rows.push([templeKind(f.getProperty('t')), tName]);
    if (f.getProperty('h')) rows.push([t('height'), `${f.getProperty('h')} m`]);
    if (a?.s) rows.push([t('storeys'), `${a.s}`]);
    if (a?.u) rows.push([t('usage'), usageName(a.u)]);
    if (a?.id.startsWith('osm:')) rows.push([t('source'), t('srcOsm')]);
    link = temple;
  } else {
    const d = s.d;
    title = getLang() === 'ja' ? d.ja : d.en;
    sub = getLang() === 'ja' ? d.en : d.ja;
    if (d.k === 't') { sub = `${templeKind(d.g)}${d.r === 1 && d.g !== 4 ? ` · ${t('heritageWhc')}` : ''} · ${sub}`; link = d; }
    if (d.e) rows.push([d.k === 'p' ? t('elevation') : d.k === 't' ? t('tallest') : t('height'), `${d.e} m`]);
    rows.push([t('lat') + ' / ' + t('lon'), `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}`]);
  }
  const wiki = link?.w?.match(/^([a-z-]+):(.+)$/);
  const wikiHtml = wiki ? `<a class="wiki" href="https://${wiki[1]}.wikipedia.org/wiki/${encodeURIComponent(wiki[2])}" target="_blank" rel="noopener">${esc(t('wikipedia'))}: ${esc(wiki[2])} ↗</a>` : '';
  el.innerHTML = `<h3>${esc(title)}</h3><div class="sub">${esc(sub)}</div><table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>${wikiHtml}`;
  el.hidden = false;
  scene.requestRender();
}

// ---------------- camera helpers ----------------
interface View { lon: number; lat: number; h: number; heading: number; pitch: number }
function currentView(): View {
  const c = camera.positionCartographic;
  return { lon: CMath.toDegrees(c.longitude), lat: CMath.toDegrees(c.latitude), h: c.height, heading: CMath.toDegrees(camera.heading), pitch: CMath.toDegrees(camera.pitch) };
}
function setView(v: View, fly = false) {
  const destination = Cartesian3.fromDegrees(v.lon, v.lat, v.h);
  const orientation = { heading: CMath.toRadians(v.heading), pitch: CMath.toRadians(v.pitch), roll: 0 };
  if (fly) camera.flyTo({ destination, orientation, duration: 2 });
  else camera.setView({ destination, orientation });
  scene.requestRender();
}

// ---------------- look-around mode ----------------
let look = false;
let badgeTimer = 0;
let aboveGround = EYE;
function setLook(on: boolean) {
  look = on;
  ssc.enableInputs = !on;
  const badge = $('#look-badge');
  badge.hidden = !on;
  clearTimeout(badgeTimer);
  if (on) badgeTimer = window.setTimeout(() => (badge.hidden = true), 4000);
  $('#btn-exit-look').hidden = !on;
  if (!on) {
    (camera.frustum as PerspectiveFrustum).fov = CMath.toRadians(60);
    if (follower.active) { follower.stop(); syncCompassUi(); }
  }
  scene.requestRender();
}

/** Put the eye at lon/lat, `above` metres over the ground (or sea level), looking horizontally. */
async function gotoPoint(lon: number, lat: number, above: number, opts: { sea?: boolean; heading?: number; fly?: boolean } = {}) {
  if (!dem.contains(lon, lat)) toast(t('outside'));
  const ground = await dem.heightAt(lon, lat);
  if (opts.sea && above < ground + 1) toast(t('belowGround'));
  const h = opts.sea ? Math.max(above, ground + 1) : ground + above;
  aboveGround = h - ground;
  const heading = opts.heading ?? currentView().heading;
  setView({ lon, lat, h, heading, pitch: 0 }, opts.fly);
  setLook(true);
  setFormTarget(lon, lat, ground, h);
}

// drag to look, wheel / pinch to zoom (field of view)
const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
canvas.addEventListener('pointerdown', (e) => {
  if (!look) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); }
});
canvas.addEventListener('pointermove', (e) => {
  if (!look || !pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId)!;
  const cur = { x: e.clientX, y: e.clientY };
  pointers.set(e.pointerId, cur);
  const frustum = camera.frustum as PerspectiveFrustum;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) setFov(fov() * (pinchDist / d));
    pinchDist = d;
    return;
  }
  if (follower.active) return; // the device decides the direction
  const k = (frustum.fovy ?? fov()) / canvas.clientHeight;
  camera.setView({
    orientation: {
      heading: camera.heading - (cur.x - prev.x) * k,
      pitch: CMath.clamp(camera.pitch + (cur.y - prev.y) * k, -CMath.PI_OVER_TWO + 0.01, CMath.PI_OVER_TWO - 0.01),
      roll: 0,
    },
  });
  scene.requestRender();
});
const endPointer = (e: PointerEvent) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchDist = 0; };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  if (!look) return;
  e.preventDefault();
  setFov(fov() * (1 + e.deltaY * 0.0015));
}, { passive: false });
const fov = () => (camera.frustum as PerspectiveFrustum).fov ?? CMath.toRadians(60);
function setFov(v: number) {
  (camera.frustum as PerspectiveFrustum).fov = CMath.clamp(v, CMath.toRadians(1), CMath.toRadians(100));
  labels.invalidate();
}

// WASD / arrows: walk, Q/E: up/down, Shift: faster
addEventListener('keydown', (e) => {
  if (!look || (e.target as HTMLElement).tagName === 'INPUT') return;
  const step = e.shiftKey ? 50 : 5;
  const v = currentView();
  const h = CMath.toRadians(v.heading);
  let de = 0, dn = 0, du = 0;
  switch (e.key.toLowerCase()) {
    case 'w': case 'arrowup': de = Math.sin(h) * step; dn = Math.cos(h) * step; break;
    case 's': case 'arrowdown': de = -Math.sin(h) * step; dn = -Math.cos(h) * step; break;
    case 'a': case 'arrowleft': de = -Math.cos(h) * step; dn = Math.sin(h) * step; break;
    case 'd': case 'arrowright': de = Math.cos(h) * step; dn = -Math.sin(h) * step; break;
    case 'e': du = step; break;
    case 'q': du = -step; break;
    default: return;
  }
  e.preventDefault();
  const lat = v.lat + dn / 111320, lon = v.lon + de / (111320 * Math.cos(CMath.toRadians(v.lat)));
  aboveGround = Math.max(1, aboveGround + du);
  camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, dem.heightNow(lon, lat) + aboveGround), orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 } });
  scene.requestRender();
});

// ---------------- click: pick viewpoint or show info ----------------
let picking = false;
function setPicking(on: boolean) {
  picking = on;
  document.body.classList.toggle('picking', on);
  $('#btn-pick').classList.toggle('on', on);
  if (on) { toast(t('pickHint')); if (isMobile) $('#panel').hidden = true; }
}
const handler = new ScreenSpaceEventHandler(canvas);
handler.setInputAction((ev: { position: Cartesian2 }) => {
  if (picking) {
    const p = scene.pickPosition(ev.position);
    setPicking(false);
    if (!p) return;
    const c = Cartographic.fromCartesian(p);
    void gotoPoint(CMath.toDegrees(c.longitude), CMath.toDegrees(c.latitude), c.height + EYE, { sea: true });
    return;
  }
  const picked = scene.pick(ev.position);
  if (picked instanceof Cesium3DTileFeature) showBuilding(picked);
  else if (picked?.id && typeof picked.id === 'object' && 'k' in picked.id) showInfo({ kind: 'label', d: picked.id as LabelData });
  else showInfo(undefined);
}, ScreenSpaceEventType.LEFT_CLICK);

// ---------------- geolocation ----------------
function locate() {
  if (!navigator.geolocation) return toast(t('geoError'));
  navigator.geolocation.getCurrentPosition(
    (p) => void gotoPoint(p.coords.longitude, p.coords.latitude, EYE, { fly: false }),
    () => toast(t('geoError')),
    { enableHighAccuracy: true, timeout: 15000 },
  );
}
let watchId: number | undefined;
function setGps(on: boolean) {
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  watchId = undefined;
  if (on && navigator.geolocation) {
    let first = true;
    watchId = navigator.geolocation.watchPosition(async (p) => {
      const { longitude: lon, latitude: lat } = p.coords;
      if (first) { first = false; await gotoPoint(lon, lat, aboveGround); return; }
      const ground = await dem.heightAt(lon, lat);
      camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, ground + aboveGround), orientation: { direction: camera.direction, up: camera.up } });
      scene.requestRender();
    }, () => { toast(t('geoError')); ($('#chk-gps') as HTMLInputElement).checked = false; }, { enableHighAccuracy: true });
  }
  ($('#chk-gps') as HTMLInputElement).checked = on && watchId !== undefined;
}

// ---------------- device orientation ----------------
const follower = new DeviceFollower();
follower.onUpdate = ({ dir, up }) => {
  const m = Transforms.eastNorthUpToFixedFrame(camera.positionWC);
  const d = Matrix4.multiplyByPointAsVector(m, new Cartesian3(...dir), new Cartesian3());
  const u = Matrix4.multiplyByPointAsVector(m, new Cartesian3(...up), new Cartesian3());
  camera.setView({ destination: Cartesian3.clone(camera.positionWC), orientation: { direction: d, up: u } });
  scene.requestRender();
};
function syncCompassUi() {
  ($('#chk-compass') as HTMLInputElement).checked = follower.active;
  $('#q-compass').classList.toggle('on', follower.active);
  $('#calib').hidden = !follower.active;
}
async function setCompass(on: boolean) {
  if (on) {
    if (!look) {
      // standing on the ground is the natural way to use the compass
      const v = currentView();
      if (v.h - dem.heightNow(v.lon, v.lat) > 400) await gotoPoint(v.lon, v.lat, EYE);
      else setLook(true);
    }
    if (!(await follower.start())) toast(t('orientError'));
  } else follower.stop();
  syncCompassUi();
}
document.querySelectorAll<HTMLButtonElement>('#calib button').forEach((b) => b.addEventListener('click', () => {
  follower.offsetDeg += Number(b.dataset.off);
  $('#calib-val').textContent = `${follower.offsetDeg}°`;
}));

// ---------------- HUD + URL state ----------------
const DIRS = { ja: ['北', '北東', '東', '南東', '南', '南西', '西', '北西'], en: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] };
scene.postRender.addEventListener(() => {
  const v = currentView();
  const hd = (v.heading + 360) % 360;
  $('#compass-dir').textContent = DIRS[getLang()][Math.round(hd / 45) % 8];
  $('#compass-deg').textContent = `${Math.round(hd)}°`;
  const ground = dem.heightNow(v.lon, v.lat);
  $('#coords').textContent = `${v.lat.toFixed(5)}, ${v.lon.toFixed(5)} · ${Math.round(v.h)} m · ${t('agl')} ${Math.round(v.h - ground)} m`;
});
let hashTimer = 0;
camera.changed.addEventListener(() => {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const v = currentView();
    const s = [v.lat.toFixed(6), v.lon.toFixed(6), v.h.toFixed(1), v.heading.toFixed(1), v.pitch.toFixed(1)].join(',');
    history.replaceState(null, '', `#v=${s}${look ? '&look=1' : ''}`);
    updateLatLonPlaceholders();
  }, 400);
});
camera.percentageChanged = 0.01;
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const v = p.get('v')?.split(',').map(Number);
  if (v?.length === 5 && v.every(Number.isFinite)) {
    setView({ lat: v[0], lon: v[1], h: v[2], heading: v[3], pitch: v[4] });
    if (p.get('look') === '1') { aboveGround = Math.max(1, v[2] - dem.heightNow(v[1], v[0])); setLook(true); }
    return true;
  }
  return false;
}

// ---------------- UI wiring ----------------
const panel = $('#panel');
$('#menu-btn').addEventListener('click', () => (panel.hidden = !panel.hidden));
$('#panel-close').addEventListener('click', () => (panel.hidden = true));
$('#q-lang').addEventListener('click', () => setLang(getLang() === 'ja' ? 'en' : 'ja'));
document.querySelectorAll<HTMLButtonElement>('#lang-seg button').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang as Lang)));
$('#q-locate').addEventListener('click', locate);
$('#btn-locate').addEventListener('click', locate);
$('#q-compass').addEventListener('click', () => void setCompass(!follower.active));
($('#chk-compass') as HTMLInputElement).addEventListener('change', (e) => void setCompass((e.target as HTMLInputElement).checked));
($('#chk-gps') as HTMLInputElement).addEventListener('change', (e) => setGps((e.target as HTMLInputElement).checked));
$('#btn-pick').addEventListener('click', () => setPicking(!picking));
$('#btn-overview').addEventListener('click', () => { setLook(false); setView(DEFAULT_VIEW, true); });
$('#btn-exit-look').addEventListener('click', () => setLook(false));

const lblAll = $('#lbl-all') as HTMLInputElement;
const syncLabelsUi = () => { lblAll.checked = labels.all; $('#q-labels').classList.toggle('on', labels.all); };
lblAll.addEventListener('change', () => { labels.all = lblAll.checked; syncLabelsUi(); });
$('#q-labels').addEventListener('click', () => { labels.all = !labels.all; syncLabelsUi(); });
document.querySelectorAll<HTMLInputElement>('[data-kind]').forEach((c) => c.addEventListener('change', () => labels.setKind(c.dataset.kind as Kind, c.checked)));

($('#chk-bldg') as HTMLInputElement).addEventListener('change', (e) => { tileset.show = osmTileset.show = (e.target as HTMLInputElement).checked; scene.requestRender(); });
document.querySelectorAll<HTMLButtonElement>('#imagery-seg button').forEach((b) => b.addEventListener('click', () => {
  photoLayer.show = b.dataset.img === 'photo';
  mapLayer.show = !photoLayer.show;
  document.querySelectorAll('#imagery-seg button').forEach((x) => x.classList.toggle('on', x === b));
  scene.requestRender();
}));

// Viewpoint form: one height value, measured either from the ground or from sea
// level. Switching the reference converts the value via the ground elevation.
const form = $('#goto') as HTMLFormElement;
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const num = (el: HTMLInputElement) => Number.parseFloat(el.value.trim());
const fmt1 = (v: number) => String(Math.round(v * 10) / 10);
/** Where a blank lat/lon field points: the eye in look-around mode, else the ground at screen centre. */
function viewTarget() {
  if (!look) {
    const ray = camera.getPickRay(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    const p = ray && scene.globe.pick(ray, scene);
    if (p) { const c = Cartographic.fromCartesian(p); return { lat: CMath.toDegrees(c.latitude), lon: CMath.toDegrees(c.longitude) }; }
  }
  const v = currentView();
  return { lat: v.lat, lon: v.lon };
}
/** Entered lat/lon; a blank field falls back to its placeholder (the current view target). */
function formLatLon() {
  const pick = (name: string) => { const v = num(field(name)); return Number.isFinite(v) ? v : Number.parseFloat(field(name).placeholder); };
  return { lat: pick('lat'), lon: pick('lon') };
}
/** Fill the form with the viewpoint just moved to, so editing one value keeps the others. */
function setFormTarget(lon: number, lat: number, ground: number, h: number) {
  field('lat').value = lat.toFixed(5);
  field('lon').value = lon.toFixed(5);
  field('height').value = fmt1(heightRef === 'agl' ? h - ground : h);
  clearTimeout(groundTimer);
  formGround = ground;
  showGround();
}
function updateLatLonPlaceholders() {
  const v = viewTarget();
  field('lat').placeholder = v.lat.toFixed(5);
  field('lon').placeholder = v.lon.toFixed(5);
  if (!field('lat').value.trim() || !field('lon').value.trim()) refreshGround();
}
let heightRef: 'agl' | 'asl' = 'agl';
let formGround: number | undefined;
function showGround() {
  const out = $('#ground-elev');
  if (formGround === undefined) { out.textContent = ''; return; }
  let text = `${t('groundElev')}: ${fmt1(formGround)} m`;
  const v = num(field('height'));
  if (Number.isFinite(v)) text += heightRef === 'agl' ? ` → ${t('aslRef')} ${fmt1(formGround + v)} m` : ` → ${t('agl')} ${fmt1(v - formGround)} m`;
  out.textContent = text;
}
function setHeightRef(ref: 'agl' | 'asl') {
  if (ref === heightRef) return;
  const v = num(field('height'));
  if (formGround !== undefined && Number.isFinite(v)) field('height').value = fmt1(ref === 'asl' ? formGround + v : v - formGround);
  heightRef = ref;
  document.querySelectorAll<HTMLButtonElement>('#height-ref button').forEach((b) => b.classList.toggle('on', b.dataset.ref === ref));
  showGround();
}
document.querySelectorAll<HTMLButtonElement>('#height-ref button').forEach((b) => b.addEventListener('click', () => setHeightRef(b.dataset.ref as 'agl' | 'asl')));
let groundTimer = 0;
function refreshGround() {
  clearTimeout(groundTimer);
  groundTimer = window.setTimeout(async () => {
    const { lat, lon } = formLatLon();
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { formGround = undefined; showGround(); return; }
    const g = await dem.heightAt(lon, lat);
    const now = formLatLon();
    if (now.lat !== lat || now.lon !== lon) return; // edited meanwhile
    formGround = g;
    showGround();
  }, 250);
}
field('lat').addEventListener('input', refreshGround);
field('lon').addEventListener('input', refreshGround);
field('height').addEventListener('input', showGround);
function showHeading() {
  const v = num(field('heading'));
  const deg = ((v % 360) + 360) % 360;
  $('#heading-hint').textContent = Number.isFinite(v) ? `→ ${t('points').split(',')[Math.round(deg / 22.5) % 16]}` : '';
}
field('heading').addEventListener('input', showHeading);
onLang(refreshGround);
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!field('lat').value.trim() || !field('lon').value.trim()) updateLatLonPlaceholders();
  const { lat, lon } = formLatLon();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const height = num(field('height'));
  const heading = Number.isFinite(num(field('heading'))) ? num(field('heading')) : undefined;
  if (heightRef === 'asl' && Number.isFinite(height)) void gotoPoint(lon, lat, height, { sea: true, heading, fly: true });
  else void gotoPoint(lon, lat, Number.isFinite(height) ? height : EYE, { heading, fly: true });
  if (isMobile) panel.hidden = true;
});
$('#btn-share').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); toast(t('copied')); } catch { toast(location.href); }
});

// ---------------- start ----------------
applyI18n();
syncLabelsUi();
if (!readHash()) setView(DEFAULT_VIEW);
// expose for debugging in the console
Object.assign(window, { viewer, dem, labels, tileset, osmTileset });
