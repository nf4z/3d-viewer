import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { buildAvatar, buildAsset, buildAssetEffects, loadSlotClip, loadAssetClip, isWearableType, isAccessoryType } from "./reconstruct.js";

const $ = (id) => document.getElementById(id);
const KEY_STORAGE = "roblox3d.apiKey";

// ---- Three.js scene ------------------------------------------------------------

const canvas = $("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 5000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;
controls.enablePan = false;

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a40, 1.5));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
keyLight.position.set(1.2, 2, -1.6);
scene.add(keyLight);
const fill = new THREE.DirectionalLight(0xdfe8ff, 0.6);
fill.position.set(-2, 1, -1);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.9);
rim.position.set(0, 2, 3);
scene.add(rim);

// Soft contact shadow under the model.
const shadowTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(0,0,0,0.55)");
  grd.addColorStop(0.5, "rgba(0,0,0,0.2)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
})();
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
shadow.rotation.x = -Math.PI / 2;
shadow.visible = false;
scene.add(shadow);

let model = null;
let homeView = null;
let appear = 1;
let appearStart = 0;

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / Math.max(window.innerHeight, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

const clock = new THREE.Clock();
const matsOf = (o) => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []);

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (model && appear < 1) {
    // Time-based so throttled/background frames still finish the fade.
    appear = Math.min(1, (performance.now() - appearStart) / 450);
    const e = 1 - Math.pow(1 - appear, 3);
    if (!model.userData.keepScale) model.scale.setScalar(0.92 + 0.08 * e);
    model.traverse((o) => {
      if (o.userData.noFade) return;
      matsOf(o).forEach((m, i) => { m.opacity = (o.userData.baseOpacity?.[i] ?? 1) * e; });
    });
  }
  if (model && model.userData.tick) model.userData.tick(dt, camera, renderer.domElement.height);
  controls.update();
  renderer.render(scene, camera);
});

function clearModel() {
  shadow.visible = false;
  if (!model) return;
  scene.remove(model);
  model.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of matsOf(o)) { if (m.map) m.map.dispose(); m.dispose(); }
    if (o.isLight && o.dispose) o.dispose();
  });
  model = null;
}

function frameModel(obj, pad = 1.08) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3();
  // Bounds from meshes only (particles/lights would skew framing).
  obj.traverse((o) => { if (o.isMesh && o.visible) box.expandByObject(o); });
  if (box.isEmpty()) box.setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.01);
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * pad;
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  // Roblox models face -Z; view from the front, slightly above.
  const dir = new THREE.Vector3(0, 0.12, -1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  controls.target.copy(center);
  controls.minDistance = dist * 0.25;
  controls.maxDistance = dist * 4;
  controls.update();
  homeView = { pos: camera.position.clone(), target: center.clone() };

  const s = Math.max(size.x, size.z) * 1.6;
  shadow.scale.set(s, s, 1);
  shadow.position.set(center.x, box.min.y - size.y * 0.005, center.z);
  shadow.visible = true;
}

function setModel(obj, { keepCamera = false } = {}) {
  clearModel();
  model = obj;
  obj.traverse((o) => {
    if (o.userData.noFade) return;
    const mats = matsOf(o);
    if (!mats.length) return;
    o.userData.baseOpacity = mats.map((m) => m.opacity);
    o.userData.restoreOpaque = mats.map((m) => { const was = !m.transparent; m.transparent = true; return was; });
  });
  scene.add(obj);
  // Rigged models get extra room so animated limbs stay in frame.
  if (keepCamera && homeView) obj.userData.keepScale = true;
  else frameModel(obj, obj.userData.animatable ? 1.3 : 1.08);
  appear = 0;
  appearStart = performance.now();
  clock.getDelta();
  // Restore opaque materials once the fade-in finishes (avoids sorting artifacts).
  setTimeout(() => obj.traverse((o) => {
    if (!o.userData.restoreOpaque) return;
    matsOf(o).forEach((m, i) => { if (o.userData.restoreOpaque[i]) { m.transparent = false; m.opacity = 1; } });
  }), 700);
}

// ---- Official render (OBJ/MTL) ---------------------------------------------------------
// Mirrors Roblox's own web viewer (Thumbnails3d.js): Kd x vertex color x map_Kd, map_d ignored,
// matte (metalness 0, roughness 1); cut-out alpha only for rbx_alphamode transparent or when an
// object's RGBA vertex colors carry alpha < 1, in which case the texture's RGBA is used as-is.

function parseMtl(text) {
  const mats = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const i = line.indexOf(" ");
    const key = (i < 0 ? line : line.slice(0, i)).toLowerCase(), val = i < 0 ? "" : line.slice(i + 1).trim();
    if (key === "newmtl") { cur = mats[val] = {}; continue; }
    if (cur) cur[key] = val;
  }
  return mats;
}

// Objects whose faces reference a vertex with alpha < 1 ("v x y z r g b a").
function objectsWithVertexAlpha(text) {
  const alpha = [], out = new Set();
  let name = "";
  for (const line of text.split(/\r?\n/)) {
    const c = line.charCodeAt(0);
    if (c === 118 && line[1] === " ") { // v
      const p = line.trim().split(/\s+/);
      alpha.push(p.length >= 8 ? parseFloat(p[7]) : 1);
    } else if ((c === 111 || c === 103) && line[1] === " ") { // o / g
      name = line.slice(2).trim();
    } else if (c === 102 && line[1] === " " && !out.has(name)) { // f
      for (const tok of line.slice(2).trim().split(/\s+/)) {
        let vi = parseInt(tok, 10);
        vi = vi < 0 ? alpha.length + vi : vi - 1;
        if (alpha[vi] < 1) { out.add(name); break; }
      }
    }
  }
  return out;
}

function useTextureRGBA(m) {
  m.alphaTest = 0.05;
  m.transparent = true;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>",
      "#ifdef USE_MAP\n  vec4 sampledDiffuseColor = texture2D( map, vMapUv );\n  diffuseColor.rgba = sampledDiffuseColor.rgba;\n#endif");
  };
  m.customProgramCacheKey = () => "rbx-rgba";
}

async function loadOfficial(meta) {
  const [mtlText, objText] = await Promise.all([
    fetch(`/cdn/${meta.mtl}`).then((r) => { if (!r.ok) throw new Error("material file unavailable"); return r.text(); }),
    fetch(`/cdn/${meta.obj}`).then((r) => { if (!r.ok) throw new Error("mesh file unavailable"); return r.text(); }),
  ]);
  const infos = parseMtl(mtlText);
  const texLoader = new THREE.TextureLoader();
  const texCache = {};
  const tex = (v, srgb) => {
    const hash = v.split(/\s+/).pop().split(/[\\/]/).pop();
    const key = hash + srgb;
    if (!texCache[key]) {
      texCache[key] = texLoader.load(`/cdn/${hash}`);
      if (srgb) texCache[key].colorSpace = THREE.SRGBColorSpace;
    }
    return texCache[key];
  };
  const make = (name) => {
    const info = infos[name] || {};
    const num3 = (v) => v.split(/\s+/).slice(0, 3).map(Number);
    const m = new THREE.MeshStandardMaterial({ name, metalness: 0, roughness: 1, side: info.rbx_doublesided === "1" ? THREE.DoubleSide : THREE.FrontSide });
    if (info.kd) m.color.setRGB(...num3(info.kd), THREE.SRGBColorSpace);
    if (info.ke) m.emissive.setRGB(...num3(info.ke), THREE.SRGBColorSpace);
    if (info.map_kd) m.map = tex(info.map_kd, true);
    if (info.map_ke) m.emissiveMap = tex(info.map_ke, true);
    const normal = info.norm || info.map_bump || info.bump;
    if (normal) m.normalMap = tex(normal, false);
    const spec = info.map_ks || info.map_ns;
    if (spec) m.roughnessMap = tex(spec, false);
    const d = info.d !== undefined ? parseFloat(info.d) : 1;
    if (d < 1) { m.opacity = d; m.transparent = true; }
    m.userData.rbxAlphaMode = info.rbx_alphamode;
    if (info.rbx_alphamode === "transparent") useTextureRGBA(m);
    return m;
  };
  const loader = new OBJLoader();
  loader.setMaterials({ create: make }); // OBJLoader only calls materials.create(name)
  const obj = loader.parse(objText);
  const alphaObjects = objectsWithVertexAlpha(objText);
  obj.traverse((o) => {
    if (!o.isMesh) return;
    // OBJLoader only enables vertex colors on materials it creates itself.
    if (o.geometry.getAttribute("color")) for (const m of matsOf(o)) m.vertexColors = true;
    if (!alphaObjects.has(o.name)) return;
    for (const m of matsOf(o)) {
      if (m.userData.rbxAlphaMode === "transparent") continue;
      useTextureRGBA(m);
      if (m.map) { m.map.wrapS = m.map.wrapT = THREE.ClampToEdgeWrapping; m.map.needsUpdate = true; }
    }
  });
  return obj;
}

// ---- UI state --------------------------------------------------------------------

let current = null; // last /api/resolve result
let loadToken = 0;

const island = $("island");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const apiKey = () => localStorage.getItem(KEY_STORAGE) || "";
// Mirror the key into a same-origin cookie so texture <img> requests to /api/raw carry it.
function syncKeyCookie() {
  const k = apiKey();
  document.cookie = k ? `rbxkey=${encodeURIComponent(k)}; path=/; SameSite=Strict` : "rbxkey=; path=/; max-age=0";
}
syncKeyCookie();

function setIsland(state, { title = "", sub = "", thumb = null, trail = "", trailWarn = false } = {}) {
  island.dataset.state = state;
  if (state === "search" || state === "idle") return;
  $("islandTitle").textContent = title;
  $("islandSub").textContent = sub;
  const img = $("islandThumb");
  if (thumb) { img.src = thumb; img.onload = () => img.classList.add("show"); }
  else if (thumb === null && state === "loading") img.classList.remove("show");
  $("islandTrail").textContent = trail;
  $("islandTrail").classList.toggle("warn", trailWarn);
}

let lastDone = null; // island content to restore after searching
function openSearch() {
  setIsland("search");
  renderHistory();
  $("q").focus();
  $("q").select();
}
island.addEventListener("click", () => {
  if (island.dataset.state !== "search" && island.dataset.state !== "loading") openSearch();
});
let typedSinceFocus = false;
$("q").addEventListener("focus", () => { typedSinceFocus = false; setIsland("search"); renderHistory(); });
$("q").addEventListener("input", () => { typedSinceFocus = true; renderHistory(); });
$("q").addEventListener("blur", () => setTimeout(() => {
  $("history").hidden = true;
  if (island.dataset.state !== "search") return;
  if (lastDone) setIsland(lastDone.state, lastDone.opts); else setIsland("idle");
}, 120));
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== $("q") && !$("sheet").contains(document.activeElement)) { e.preventDefault(); openSearch(); }
  if (e.key === "Escape") { $("q").blur(); closeSettings(); $("files").hidden = true; }
});

function finish(state, opts) {
  lastDone = { state, opts };
  setIsland(state, opts);
}

async function thumbFor(type, id, headshot = false) {
  const r = await fetch(`/api/2d?type=${type}&id=${id}${headshot ? "&headshot=1" : ""}`).then((x) => x.json()).catch(() => null);
  return r && r.imageUrl;
}

// ---- Segmented control (ID matches both a user and an asset) ----------------------------

function renderSegment() {
  const seg = $("segment");
  const { user, asset } = current;
  seg.hidden = !(user && asset);
  if (seg.hidden) return;
  seg.innerHTML = `<span class="segment-label">${current.outfit && current.outfit.add.length ? "Try-on" : "ID matches"}</span>`;
  for (const [kind, label] of [["user", `@${user.name}`], ["asset", asset.name]]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = kind === "user" ? `User ${user.id}` : `${asset.assetType} ${asset.id}`;
    b.className = current.pick === kind ? "active" : "";
    b.onclick = () => { if (current.pick !== kind) show(kind); };
    seg.append(b);
  }
}

// ---- Info card -------------------------------------------------------------------

function renderCard(kind, { method, info, warnings, effects, note }) {
  const card = $("card");
  const subject = kind === "user" ? current.user : current.asset;
  $("cardTitle").textContent = kind === "user" ? subject.displayName : subject.name;
  $("cardSub").textContent = kind === "user"
    ? `@${subject.name} · ${subject.id}`
    : `${subject.assetType}${subject.creator ? ` by ${subject.creator}` : ""} · ${subject.id}`;
  $("cardThumb").removeAttribute("src");
  thumbFor(kind, subject.id, kind === "user").then((u) => { if (u) $("cardThumb").src = u; });

  const badges = [`<span class="badge">${kind === "user" ? "Avatar" : esc(subject.assetType)}</span>`];
  if (info) badges.push(`<span class="badge">${esc(info)}</span>`);
  badges.push(method === "official"
    ? `<span class="badge green" title="Roblox's own 3D render (static)">Official 3D</span>`
    : `<span class="badge blue" title="Rebuilt from the item files (animatable)">Rebuilt</span>`);
  if (effects) badges.push(`<span class="badge">✦ Effects</span>`);
  if (note) badges.push(`<span class="badge orange" title="${esc(note)}">Official render unavailable</span>`);
  $("cardBadges").innerHTML = badges.join("");

  const box = $("warnBox");
  box.hidden = !warnings.length;
  box.open = false;
  if (warnings.length) {
    $("warnSummary").textContent = `${warnings.length} item${warnings.length > 1 ? "s" : ""} unavailable`;
    const keyLacksScope = warnings.some((w) => /missing the legacy-asset/i.test(w));
    const needsKey = warnings.some((w) => /authentication required|Protected item/i.test(w));
    $("warnings").innerHTML = warnings.map((w) => {
      const i = w.indexOf(": ");
      const name = i > 0 ? w.slice(0, i) : w, why = i > 0 ? w.slice(i + 2) : "";
      const short = /missing the legacy-asset/i.test(why) ? "Key can't download item files"
        : /authentication required|Protected item/i.test(why) ? "Protected item (needs an API key)" : why;
      return `<li><b>${esc(name)}</b><br>${esc(short)}</li>`;
    }).join("");
    // Explain the fix up front instead of hiding it in the list.
    const hint = keyLacksScope
      ? `Your API key works for official renders but not for downloading item files, which rebuilt models and try-on need. In Creator Hub → API Keys → edit the key → Access Permissions, add <b>legacy-asset</b> (operation <b>manage</b>), save, then reload.`
      : needsKey
        ? `These items are protected by Roblox. Add an API key with the <b>legacy-asset</b> permission in Settings to include them.`
        : "";
    if (hint) $("warnings").insertAdjacentHTML("afterbegin", `<li class="warn-hint callout">${hint}</li>`);
    if (keyLacksScope || warnings.length >= 3) box.open = true;
  }
  card.hidden = false;
  card.style.animation = "none"; void card.offsetWidth; card.style.animation = "";
}

// ---- Loading -----------------------------------------------------------------------
// Modes: "auto" rebuilds from item files (animatable, with effects) and falls back to Roblox's
// official render when items are missing; "rebuilt" / "official" force one method.

const MODE_STORAGE = "roblox3d.mode";
const getMode = () => localStorage.getItem(MODE_STORAGE) || "auto";
let serverCfg = null;
const hasCredentials = async () => {
  serverCfg = serverCfg || await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  return Boolean(apiKey() || serverCfg.serverHasKey || serverCfg.serverHasCookie);
};

async function tryOfficial(kind, id) {
  const headers = apiKey() ? { "x-roblox-api-key": apiKey() } : {};
  const res = await fetch(`/api/3d?type=${kind}&id=${id}`, { headers });
  const meta = await res.json();
  if (!res.ok) return { error: meta };
  return { meta, obj: await loadOfficial(meta) };
}

function showFiles(kind, id, meta) {
  $("files").innerHTML = meta
    ? `<a href="/cdn/${meta.obj}" download="${kind}-${id}.obj">Model (.obj)</a>` +
      `<a href="/cdn/${meta.mtl}" download="${kind}-${id}.mtl">Materials (.mtl)</a>` +
      (meta.textures || []).map((t, i) => `<a href="/cdn/${t}" download="${kind}-${id}-texture${i + 1}.png">Texture ${i + 1} (.png)</a>`).join("")
    : "";
  $("download").disabled = !meta;
}

// opts.mode overrides the saved mode; opts.anim plays an animation slot once loaded.
async function show(kind, opts = {}) {
  current.pick = kind;
  renderSegment();
  const token = ++loadToken;
  const subject = kind === "user" ? current.user : current.asset;
  const id = subject.id;
  const title = kind === "user" ? subject.displayName : subject.name;
  const typeLabel = kind === "user" ? "Avatar" : subject.assetType;
  const outfit = kind === "user" ? current.outfit : null;
  const tried = outfit && outfit.add[0];
  history.replaceState(null, "", `?${kind}=${id}${tried ? `&tryon=${tried.id}` : ""}`);

  $("empty").classList.add("gone");
  $("fallback").hidden = true;
  $("files").hidden = true;
  $("animMenu").hidden = true;
  showFiles();
  if (!opts.keepCamera) { $("card").hidden = true; clearModel(); setAnimState(null); }

  const thumbP = thumbFor(kind, id, kind === "user");
  setIsland("loading", { title, sub: "Preparing 3D model…", thumb: null });
  thumbP.then((t) => {
    if (token === loadToken && t) setIsland(island.dataset.state, { title: $("islandTitle").textContent, sub: $("islandSub").textContent, thumb: t, trail: $("islandTrail").textContent, trailWarn: $("islandTrail").classList.contains("warn") });
  });

  // Outfit edits / try-ons only exist in the rebuilt model.
  const edited = outfit && (outfit.add.length || outfit.remove.size);
  const mode = opts.mode || (edited ? "rebuilt" : getMode());
  const rebuild = () => (kind === "user"
    ? buildAvatar(id, undefined, outfit ? { add: outfit.add, remove: outfit.remove } : {})
    : buildAsset(id, current.asset.assetTypeId));

  try {
    let result = null; // { obj, method, meta?, built? }
    let officialError = null;

    if (mode === "official") {
      setIsland("loading", { title, sub: "Requesting official render…" });
      const off = await tryOfficial(kind, id);
      if (token !== loadToken) return;
      if (off.obj) result = { obj: off.obj, method: "official", meta: off.meta };
      else officialError = off.error;
    }
    if (!result) {
      setIsland("loading", { title, sub: kind === "user" ? "Rebuilding avatar from items…" : "Rebuilding from item files…" });
      let built = null, rebuildError = null;
      try { built = await rebuild(); } catch (e) { rebuildError = e; }
      if (token !== loadToken) return;
      if (built) result = { obj: built.object, method: "rebuilt", built };
      // Rebuild failed or has missing items -> use the official render when credentials allow it.
      const wantOfficial = mode !== "official" && (rebuildError || (mode === "auto" && built.warnings.length));
      if (wantOfficial && await hasCredentials()) {
        setIsland("loading", { title, sub: rebuildError ? "Item files unavailable · trying official render…" : `${built.warnings.length} item(s) missing · trying official render…` });
        const off = await tryOfficial(kind, id).catch((e) => ({ error: { message: e.message } }));
        if (token !== loadToken) return;
        if (off.obj) result = { obj: off.obj, method: "official", meta: off.meta, built };
        else officialError = off.error;
      }
      if (!result) throw rebuildError;
    }

    // Official renders have no particles: overlay the item's own effects (single items).
    if (result.method === "official" && kind === "asset") {
      const fx = await buildAssetEffects(id, current.asset.assetTypeId).catch(() => null);
      if (token !== loadToken) return;
      if (fx) {
        const box = new THREE.Box3().setFromObject(result.obj);
        box.getCenter(fx.position);
        result.obj.add(fx);
        result.obj.userData.tick = fx.userData.tick;
        result.obj.userData.hasEffects = true;
      }
    }

    setModel(result.obj, { keepCamera: opts.keepCamera });
    showFiles(kind, id, result.meta);
    const warnings = result.method === "rebuilt" ? result.built.warnings : [];
    renderCard(kind, {
      method: result.method,
      info: result.built && result.built.info,
      warnings,
      effects: result.obj.userData.hasEffects,
      note: officialError && officialError.error !== "NO_API_KEY" && mode !== "rebuilt" ? officialError.message : null,
    });
    renderOutfit(kind === "user" && result.built ? result.built.items : null);
    $("tryOnBtn").hidden = !(kind === "asset" && isWearableType(subject.assetTypeId));
    const n = warnings.length;
    const thumb = await thumbP;
    finish("done", {
      title,
      sub: tried ? (result.built && result.built.items.some((i) => i.tried && i.failed) ? `Couldn't download ${tried.name} · see card` : `Trying on ${tried.name}`)
        : result.method === "official" ? `${typeLabel} · official render` : `${typeLabel}${result.built.info ? ` · ${result.built.info}` : ""}`,
      thumb,
      trail: n ? `${n} missing` : "3D",
      trailWarn: n > 0,
    });
    if (!opts.keepCamera) addHistory({ kind, id: String(id), title, sub: kind === "user" ? `@${subject.name}` : typeLabel, thumb });

    // Animation: requested slot, an animation asset's own clip, or the last chosen slot.
    const autoplay = result.obj.userData.autoplay;
    if (autoplay) playAnim(autoplay.slot, autoplay.assetId);
    else if (opts.anim) playAnim(opts.anim);
    else if (activeAnim && activeAnim !== "none" && result.obj.userData.animatable) playAnim(activeAnim);
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    finish("error", { title: "Couldn't build 3D model", sub: err.message || String(err) });
    const t = await thumbFor(kind, id);
    if (t && token === loadToken) { $("fallback").src = t; $("fallback").hidden = false; }
  }
}

// ---- Animation ----------------------------------------------------------------------

let activeAnim = "none";
let animToken = 0;

function setAnimState(slot, loading = false) {
  document.querySelectorAll("#animMenu button").forEach((b) => {
    b.classList.toggle("active", !loading && b.dataset.anim === (slot || "none"));
    b.classList.toggle("loading", loading && b.dataset.anim === slot);
  });
  $("animBtn").classList.toggle("playing", Boolean(slot && slot !== "none" && !loading));
}

async function playAnim(slot, assetId) {
  const token = ++animToken;
  if (!model) return;
  if (slot === "none") {
    activeAnim = "none";
    model.userData.player && model.userData.player.stop();
    setAnimState("none");
    setAnimBadge(null);
    return;
  }
  // Official renders are static meshes: switch to the rebuilt (rigged) model first.
  if (!model.userData.animatable) {
    activeAnim = slot;
    if (current) show(current.pick, { mode: "rebuilt", anim: slot });
    return;
  }
  setAnimState(slot, true);
  try {
    const { clip, source, note } = assetId
      ? await loadAssetClip(assetId, slot)
      : await loadSlotClip(slot, model.userData.animPacks && model.userData.animPacks[slot]);
    if (token !== animToken || !model || !model.userData.player) return;
    model.userData.player.play(clip);
    activeAnim = assetId ? activeAnim : slot;
    setAnimState(assetId ? null : slot);
    $("animBtn").classList.add("playing");
    setAnimBadge(`${assetId ? "Previewing animation" : slot[0].toUpperCase() + slot.slice(1)}${source === "avatar" ? " · avatar's pack" : source === "default" ? " · Roblox default" : ""}`, note);
  } catch (e) {
    if (token !== animToken) return;
    setAnimState(activeAnim);
    setAnimBadge(`Animation unavailable: ${e.message}`, null, true);
  }
}

function setAnimBadge(text, note, warn = false) {
  let b = $("animBadge");
  if (!text) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement("span"); b.id = "animBadge"; $("cardBadges").append(b); }
  b.className = `badge ${warn ? "orange" : "green"}`;
  b.textContent = text;
  b.title = note ? `Avatar's pack failed (${note}); using Roblox default` : "";
}

$("animBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("files").hidden = true;
  $("animMenu").hidden = !$("animMenu").hidden;
});
document.querySelectorAll("#animMenu button").forEach((b) => b.addEventListener("click", (e) => {
  e.stopPropagation();
  $("animMenu").hidden = true;
  if (!model) { activeAnim = b.dataset.anim; setAnimState(activeAnim); return; }
  playAnim(b.dataset.anim);
}));

async function lookup(q, extra = {}) {
  const token = ++loadToken;
  $("q").blur();
  $("segment").hidden = true;
  setIsland("loading", { title: "Searching…", sub: q, thumb: null });
  const res = await fetch(`/api/resolve?q=${encodeURIComponent(q)}`).catch(() => null);
  const data = res ? await res.json().catch(() => ({ error: "Bad response" })) : { error: "Server unreachable" };
  if (token !== loadToken) return;
  if (!res || !res.ok) {
    finish("error", { title: "Nothing found", sub: data.error || "Lookup failed" });
    return;
  }
  current = data;
  if (extra.tryon && data.user) {
    const a = await fetch(`/api/resolve?q=${encodeURIComponent(`https://www.roblox.com/catalog/${extra.tryon}`)}`).then((r) => r.json()).catch(() => ({}));
    if (token !== loadToken) return;
    if (a.asset) {
      current = { user: data.user, asset: a.asset, pick: "user", outfit: { add: [{ id: String(a.asset.id), name: a.asset.name, typeId: a.asset.assetTypeId }], remove: new Set() } };
    }
  }
  show(current.pick === "asset" && !data.asset ? "user" : current.pick);
}

$("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (q) lookup(q);
});
document.querySelectorAll(".chips button").forEach((b) => b.addEventListener("click", () => {
  $("q").value = b.dataset.q;
  lookup(b.dataset.q);
}));

// ---- Controls -----------------------------------------------------------------------

$("rotate").addEventListener("click", () => {
  controls.autoRotate = !controls.autoRotate;
  $("rotate").classList.toggle("on", controls.autoRotate);
});
$("resetView").addEventListener("click", () => {
  if (!homeView) return;
  const from = camera.position.clone(), fromT = controls.target.clone();
  let t = 0;
  const step = () => {
    t = Math.min(1, t + 0.06);
    const e = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(from, homeView.pos, e);
    controls.target.lerpVectors(fromT, homeView.target, e);
    if (t < 1) requestAnimationFrame(step);
  };
  step();
});
$("download").addEventListener("click", (e) => { e.stopPropagation(); $("animMenu").hidden = true; $("files").hidden = !$("files").hidden; });
document.addEventListener("click", (e) => {
  if (!$("files").contains(e.target)) $("files").hidden = true;
  if (!$("animMenu").contains(e.target)) $("animMenu").hidden = true;
});

// ---- Settings sheet ----------------------------------------------------------------

function openSettings() { $("sheet").hidden = false; refreshKeyStatus(); renderModePicker(); }
function closeSettings() { $("sheet").hidden = true; }
$("openSettings").addEventListener("click", openSettings);
$("closeSettings").addEventListener("click", closeSettings);
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSettings(); });

const MODE_HINTS = {
  auto: "Rebuilds from item files (animations + effects). Uses Roblox's official render when items can't be downloaded.",
  rebuilt: "Always rebuild from item files. Supports animations and effects; protected items need an API key.",
  official: "Roblox's own 3D render. Most accurate, but static: no animations or particle effects. Needs an API key.",
};
function renderModePicker() {
  const mode = getMode();
  document.querySelectorAll("#modePicker button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("modeHint").textContent = MODE_HINTS[mode];
}
document.querySelectorAll("#modePicker button").forEach((b) => b.addEventListener("click", () => {
  localStorage.setItem(MODE_STORAGE, b.dataset.mode);
  renderModePicker();
  if (current) show(current.pick);
}));
localStorage.removeItem("roblox3d.forceRebuild"); // replaced by render mode

async function refreshKeyStatus() {
  serverCfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  $("keyStatus").textContent = serverCfg.serverHasKey ? "Using ROBLOX_API_KEY from the server's .env."
    : serverCfg.serverHasCookie ? "Using ROBLOX_COOKIE from the server's .env."
    : apiKey() ? "A key is saved in this browser." : "No key set. Protected items are skipped.";
}
$("saveKey").addEventListener("click", () => {
  const v = $("apiKey").value.trim();
  if (v) localStorage.setItem(KEY_STORAGE, v); else localStorage.removeItem(KEY_STORAGE);
  syncKeyCookie();
  $("apiKey").value = "";
  refreshKeyStatus();
  if (current) show(current.pick);
});

// ---- Deep links: ?user=123, ?asset=456, ?q=anything -----------------------------------

(() => {
  const p = new URLSearchParams(location.search);
  const q = p.get("user") ? `https://www.roblox.com/users/${p.get("user")}/profile`
    : p.get("asset") ? `https://www.roblox.com/catalog/${p.get("asset")}`
    : p.get("q");
  if (q) { $("q").value = p.get("user") || p.get("asset") || q; lookup(q, { tryon: p.get("tryon") }); }
})();

// ---- Search history -------------------------------------------------------------------

const HISTORY_KEY = "roblox3d.history";
const getHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } };
function addHistory(entry) {
  const list = getHistory().filter((h) => !(h.kind === entry.kind && h.id === entry.id));
  list.unshift({ ...entry, t: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20)));
}
function renderHistory() {
  const box = $("history"), ul = $("historyList");
  // Filter only once the user types (the box is pre-filled with the current item).
  const q = typedSinceFocus ? $("q").value.trim().toLowerCase() : "";
  const all = getHistory();
  const list = q ? all.filter((h) => `${h.title} ${h.sub} ${h.id}`.toLowerCase().includes(q)) : all;
  if (island.dataset.state !== "search" || (!all.length)) { box.hidden = true; return; }
  box.hidden = false;
  $("segment").hidden = true;
  ul.innerHTML = list.length ? "" : `<li class="history-empty">No matches. Press Enter to search.</li>`;
  for (const h of list.slice(0, 12)) {
    const li = document.createElement("li");
    li.innerHTML = `<img alt="" ${h.thumb ? `src="${esc(h.thumb)}"` : ""}><span class="h-text"><div class="h-title">${esc(h.title)}</div>` +
      `<div class="h-sub">${h.kind === "user" ? "User" : "Item"} · ${esc(h.sub || "")} · ${esc(h.id)}</div></span><button class="h-del" title="Remove">×</button>`;
    // mousedown so it fires before the input's blur hides the list
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (e.target.classList.contains("h-del")) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(getHistory().filter((x) => !(x.kind === h.kind && x.id === h.id))));
        renderHistory();
        return;
      }
      $("history").hidden = true;
      $("q").value = h.title;
      lookup(h.kind === "user" ? `https://www.roblox.com/users/${h.id}/profile` : `https://www.roblox.com/catalog/${h.id}`);
    });
    ul.append(li);
  }
}
$("clearHistory").addEventListener("mousedown", (e) => {
  e.preventDefault();
  localStorage.removeItem(HISTORY_KEY);
  $("history").hidden = true;
});

// ---- Lock view ----------------------------------------------------------------------

let locked = false;
$("lockBtn").addEventListener("click", () => {
  locked = !locked;
  controls.enabled = !locked;
  if (locked) { controls.autoRotate = false; $("rotate").classList.remove("on"); }
  $("lockBtn").classList.toggle("on", locked);
  $("lockBtn").title = locked ? "Unlock view" : "Lock view";
  $("rotate").disabled = locked;
});

// ---- Outfit list (take items off / put back on) -----------------------------------------

function renderOutfit(items) {
  const box = $("outfitBox");
  box.hidden = !items || !items.length;
  if (box.hidden) return;
  const worn = items.filter((i) => !i.removed).length;
  $("outfitSummary").textContent = `Wearing ${worn} of ${items.length} items`;
  $("outfitReset").hidden = !(current.outfit && current.outfit.remove.size);
  const ul = $("outfit");
  ul.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.className = it.removed ? "off" : "";
    li.innerHTML = `<img alt=""><span class="o-text"><div class="o-name">${esc(it.name)}${it.tried ? `<span class="o-tag">TRYING ON</span>` : ""}</div>` +
      `<div class="o-type">${esc(it.typeName || "")}${it.replaced ? " · replaced by try-on" : ""}${it.failed ? " · unavailable" : ""}</div></span>`;
    const sw = document.createElement("input");
    sw.type = "checkbox";
    sw.className = "switch";
    sw.checked = !it.removed;
    sw.disabled = it.replaced;
    sw.addEventListener("change", () => toggleItem(it, sw.checked, li, items));
    li.append(sw);
    ul.append(li);
    thumbFor("asset", it.id).then((u) => { if (u) li.querySelector("img").src = u; });
  }
}

function toggleItem(it, on, li, items) {
  current.outfit = current.outfit || { add: [], remove: new Set() };
  if (on) current.outfit.remove.delete(it.id); else current.outfit.remove.add(it.id);
  it.removed = !on;
  li.classList.toggle("off", !on);
  $("outfitSummary").textContent = `Wearing ${items.filter((i) => !i.removed).length} of ${items.length} items`;
  $("outfitReset").hidden = !current.outfit.remove.size;
  // Accessories fade in place; clothing/body/head changes need a quick rebuild.
  if (isAccessoryType(it.typeId) && model && model.userData.setItemVisible) {
    if (it.failed || model.userData.setItemVisible(it.id, on)) return;
  }
  show("user", { keepCamera: true });
}
$("outfitReset").addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!current.outfit) return;
  current.outfit.remove.clear();
  show("user", { keepCamera: true });
});

// ---- Try-on ------------------------------------------------------------------------

function openTryOn() {
  const a = current.asset;
  $("tryOnItem").textContent = `Put “${a.name}” (${a.assetType}) on any avatar. You can take their other items off afterwards.`;
  $("tryOnError").textContent = "";
  $("tryOnUser").value = "";
  const users = getHistory().filter((h) => h.kind === "user").slice(0, 8);
  $("tryOnRecent").innerHTML = "";
  for (const u of users) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<img alt="" ${u.thumb ? `src="${esc(u.thumb)}"` : ""}>${esc(u.title)}`;
    b.addEventListener("click", () => applyTryOn(u.id, true));
    $("tryOnRecent").append(b);
  }
  $("tryOnSheet").hidden = false;
  setTimeout(() => $("tryOnUser").focus(), 50);
}
function closeTryOn() { $("tryOnSheet").hidden = true; }

async function applyTryOn(q, isId = false) {
  $("tryOnError").textContent = "";
  const query = isId ? `https://www.roblox.com/users/${q}/profile` : q;
  const data = await fetch(`/api/resolve?q=${encodeURIComponent(query)}`).then((r) => r.json()).catch(() => ({}));
  if (!data.user) { $("tryOnError").textContent = data.error || "No user found."; return; }
  const a = current.asset;
  closeTryOn();
  current = { user: data.user, asset: a, pick: "user", outfit: { add: [{ id: String(a.id), name: a.name, typeId: a.assetTypeId }], remove: new Set() } };
  show("user");
}

$("tryOnBtn").addEventListener("click", openTryOn);
$("closeTryOn").addEventListener("click", closeTryOn);
$("tryOnSheet").addEventListener("click", (e) => { if (e.target === $("tryOnSheet")) closeTryOn(); });
$("tryOnForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("tryOnUser").value.trim();
  if (v) applyTryOn(/^\d+$/.test(v) ? v : v, /^\d+$/.test(v));
});

// Debug handle for the browser console.
window.__viewer = { get model() { return model; }, scene, camera };
