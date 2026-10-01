// No-auth fallback: rebuild 3D models from raw Roblox asset files.
// Items are downloaded through the local server (/api/model, /api/raw), parsed,
// and assembled with Roblox's attachment system + classic clothing templates.
import * as THREE from "three";
import { parseMesh } from "./rbxmesh.js";
import { buildEffects, effectsTicker } from "./effects.js";
import { AnimationPlayer, resolveClip, DEFAULT_ANIMS, ANIM_TYPES } from "./animation.js";

const DEFAULT_COLOR = [163 / 255, 162 / 255, 165 / 255];
const DEFAULT_FACE_IMAGE = "144080495"; // classic "Smile" face texture
const BASEPARTS = new Set(["Part", "MeshPart", "WedgePart", "CornerWedgePart", "TrussPart", "Seat", "VehicleSeat", "SpawnLocation"]);
const ACCESSORY_TYPES = new Set([8, 41, 42, 43, 44, 45, 46, 47, 57, 58, 64, 65, 66, 67, 68, 69, 70, 71, 72, 76, 77]);
const BODY_PART_TYPES = { 27: "torso", 28: "rightArm", 29: "leftArm", 30: "leftLeg", 31: "rightLeg" };

// ---- loading helpers ---------------------------------------------------------------

export function assetIdOf(content) {
  if (content === null || content === undefined) return null;
  const s = String(content);
  if (/^rbxasset:\/\//i.test(s)) return null; // local client content, not downloadable
  const m = s.match(/(?:[?&]id=|rbxassetid:\/\/|^)(\d+)\s*$/i) || s.match(/[?&]id=(\d+)/i);
  return m ? m[1] : null;
}

const modelCache = new Map(), meshCache = new Map(), imageCache = new Map();
// Cache successes only, so items that failed (e.g. auth-blocked) retry after adding a key.
function cached(cache, id, make) {
  if (!cache.has(id)) cache.set(id, make().catch((e) => { cache.delete(id); throw e; }));
  return cache.get(id);
}

export function loadModel(id) {
  return cached(modelCache, id, () => fetch(`/api/model/${id}`).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || `HTTP ${r.status}`);
    return j;
  }));
}

function loadMesh(id) {
  return cached(meshCache, id, () => fetch(`/api/raw/${id}`).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `mesh ${id}: HTTP ${r.status}`);
    return parseMesh(await r.arrayBuffer());
  }));
}

function loadImage(id) {
  if (!id) return Promise.resolve(null);
  return cached(imageCache, id, () => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image ${id} could not be loaded`));
    img.src = `/api/raw/${id}`;
  }));
}

// Load an image but turn failures into warnings instead of aborting the build.
async function tryImage(id, ctx, label) {
  try { return await loadImage(id); } catch (e) { ctx.warn(`${label}: ${e.message}`); return null; }
}

function textureFrom(source) {
  const t = source instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source) : new THREE.Texture(source);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const css = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
const hexColor = (h) => (h ? [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255] : DEFAULT_COLOR);

// Roblox CFrame [x,y,z,R00..R22] -> Matrix4
function cfMatrix(cf) {
  const m = new THREE.Matrix4();
  if (!cf) return m;
  const [x, y, z, a, b, c, d, e, f, g, h, i] = cf;
  return m.set(a, b, c, x, d, e, f, y, g, h, i, z, 0, 0, 0, 1);
}

function findAll(nodes, pred, out = []) {
  for (const n of nodes) { if (pred(n)) out.push(n); findAll(n.children, pred, out); }
  return out;
}

function attachmentsOf(node) {
  const atts = {};
  for (const c of node.children) if (c.className === "Attachment") atts[c.name] = cfMatrix(c.props.CFrame);
  return atts;
}

// ---- geometry -----------------------------------------------------------------------

function roundedHead(radius, height) {
  // Rounded like Roblox's classic head so hats sized for it don't clip at the corners.
  const b = Math.min(radius, height / 2) * 0.62, pts = [];
  pts.push(new THREE.Vector2(0, -height / 2));
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(radius - b + Math.cos(a) * b, -height / 2 + b + Math.sin(a) * b)); }
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(radius - b + Math.cos(a) * b, height / 2 - b + Math.sin(a) * b)); }
  pts.push(new THREE.Vector2(0, height / 2));
  return new THREE.LatheGeometry(pts, 40);
}

function primitive(kind, size) {
  const [x, y, z] = size;
  switch (kind) {
    case "ball": { const g = new THREE.SphereGeometry(0.5, 32, 16); g.scale(x, y, z); return g; }
    case "cylinderX": { const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); g.rotateZ(Math.PI / 2); g.scale(x, y, z); return g; }
    case "cylinderY": { const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); g.scale(x, y, z); return g; }
    case "head": return roundedHead(Math.min(x, z) / 2, y);
    case "wedge": {
      const g = new THREE.BufferGeometry();
      const v = [-.5, -.5, -.5, .5, -.5, -.5, .5, -.5, .5, -.5, -.5, .5, .5, .5, .5, -.5, .5, .5].map((n, i) => n * size[i % 3]);
      g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
      g.setIndex([0, 2, 1, 0, 3, 2, 3, 4, 2, 3, 5, 4, 0, 1, 4, 0, 4, 5, 1, 2, 4, 0, 5, 3]);
      g.computeVertexNormals();
      return g.toNonIndexed();
    }
    default: return new THREE.BoxGeometry(x, y, z);
  }
}

// Classic 585x559 clothing template regions: [x, y, w, h]
const TEMPLATE_W = 585, TEMPLATE_H = 559;
const REGIONS = {
  torso: { F: [231, 74, 128, 128], B: [427, 74, 128, 128], PX: [165, 74, 64, 128], NX: [361, 74, 64, 128], U: [231, 8, 128, 64], D: [231, 204, 128, 64] },
  right: { F: [217, 355, 64, 128], B: [85, 355, 64, 128], PX: [151, 355, 64, 128], NX: [19, 355, 64, 128], U: [217, 289, 64, 64], D: [217, 485, 64, 64] },
  left: { F: [308, 355, 64, 128], B: [440, 355, 64, 128], NX: [374, 355, 64, 128], PX: [506, 355, 64, 128], U: [308, 289, 64, 64], D: [308, 485, 64, 64] },
};

// The six box faces: outward normal, image-up direction, template region key.
// Image-right is (-normal) x up, i.e. "right" as seen by a viewer facing that side.
const BOX_FACES = [
  { n: [0, 0, -1], u: [0, 1, 0], key: "F", slice: true },
  { n: [0, 0, 1], u: [0, 1, 0], key: "B", slice: true },
  { n: [1, 0, 0], u: [0, 1, 0], key: "PX", slice: true },
  { n: [-1, 0, 0], u: [0, 1, 0], key: "NX", slice: true },
  { n: [0, 1, 0], u: [0, 0, 1], key: "U" },
  { n: [0, -1, 0], u: [0, 0, -1], key: "D" },
].map((f) => {
  const n = new THREE.Vector3(...f.n), up = new THREE.Vector3(...f.u);
  return { ...f, nv: n, up, right: n.clone().negate().cross(up) };
});

// Template pixel rect for a face, sliced vertically to [t0,t1] for side faces.
function faceRect(face, regions, t0, t1) {
  let [rx, ry, rw, rh] = regions[face.key];
  if (face.slice) { ry += rh * t0; rh *= t1 - t0; }
  return [rx, ry, rw, rh];
}
// (sr, su) in [-1,1] across the face -> template UV
// Keep bilinear filtering inside each template island. Without this inset, the atlas
// samples adjacent white padding at clothing seams and produces bright hairlines.
const rectUV = ([rx, ry, rw, rh], sr, su) => {
  const inset = 0.75;
  const x = rx + inset + ((sr + 1) / 2) * Math.max(0, rw - inset * 2);
  const y = ry + inset + (1 - (su + 1) / 2) * Math.max(0, rh - inset * 2);
  return [x / TEMPLATE_W, 1 - y / TEMPLATE_H];
};

// Box whose faces are UV-mapped onto a template region; [t0,t1] selects a vertical slice.
function templateBox(size, regions, t0, t1) {
  const pos = [], uv = [], nrm = [], idx = [];
  const half = size.map((s) => s / 2);
  const ext = (v) => Math.abs(v.x) * half[0] + Math.abs(v.y) * half[1] + Math.abs(v.z) * half[2];
  for (const f of BOX_FACES) {
    const hn = ext(f.nv), hr = ext(f.right), hu = ext(f.up);
    const rect = faceRect(f, regions, t0, t1);
    const base = pos.length / 3;
    for (const [sr, su] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = f.nv.clone().multiplyScalar(hn).addScaledVector(f.right, sr * hr).addScaledVector(f.up, su * hu);
      pos.push(p.x, p.y, p.z);
      nrm.push(...f.n);
      uv.push(...rectUV(rect, sr, su));
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Darken face borders slightly so the blocky default body reads as separate blocks.
function edgeShade(g, group) {
  const regions = group === "torso" ? REGIONS.torso : group.startsWith("right") ? REGIONS.right : group.startsWith("left") ? REGIONS.left : null;
  if (!regions) return;
  for (const [x, y, w, h] of Object.values(regions)) {
    const e = 5;
    for (const [gx0, gy0, gx1, gy1, rx, ry, rw, rh] of [
      [x, 0, x + e, 0, x, y, e, h], [x + w, 0, x + w - e, 0, x + w - e, y, e, h],
      [0, y, 0, y + e, x, y, w, e], [0, y + h, 0, y + h - e, x, y + h - e, w, e],
    ]) {
      const grd = g.createLinearGradient(gx0, gy0, gx1, gy1);
      grd.addColorStop(0, "rgba(0,0,0,0.22)"); grd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grd; g.fillRect(rx, ry, rw, rh);
    }
  }
}

// Box-project the clothing template onto an arbitrary body mesh: each triangle picks the
// box face its normal points at, and vertices map into that face's template rect by
// their position within the mesh bounds. Returns a new non-indexed geometry.
function projectTemplate(geom, regions, t0, t1) {
  const g = geom.index ? geom.toNonIndexed() : geom.clone();
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  const c = min.clone().add(max).multiplyScalar(0.5), half = max.clone().sub(min).multiplyScalar(0.5);
  const pos = g.getAttribute("position"), uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3(), p = new THREE.Vector3();
  const rects = BOX_FACES.map((f) => faceRect(f, regions, t0, t1));
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); d.fromBufferAttribute(pos, i + 2);
    n.subVectors(b, a).cross(d.clone().sub(a)).normalize();
    let best = 0, bestDot = -Infinity;
    BOX_FACES.forEach((f, k) => { const dot = n.dot(f.nv); if (dot > bestDot) { bestDot = dot; best = k; } });
    const f = BOX_FACES[best];
    const hr = Math.abs(f.right.x) * half.x + Math.abs(f.right.y) * half.y + Math.abs(f.right.z) * half.z || 1;
    const hu = Math.abs(f.up.x) * half.x + Math.abs(f.up.y) * half.y + Math.abs(f.up.z) * half.z || 1;
    for (let k = 0; k < 3; k++) {
      p.fromBufferAttribute(pos, i + k).sub(c);
      const sr = THREE.MathUtils.clamp(p.dot(f.right) / hr, -1, 1), su = THREE.MathUtils.clamp(p.dot(f.up) / hu, -1, 1);
      const [u, v] = rectUV(rects[best], sr, su);
      uv[(i + k) * 2] = u; uv[(i + k) * 2 + 1] = v;
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

// ---- default blocky R15 rig ---------------------------------------------------------------
// Proportions match the classic blocky avatar; rig attachments line up joints.

const HEAD_ATTS = { NeckRigAttachment: [0, -0.5, 0], HatAttachment: [0, 0.6, 0], HairAttachment: [0, 0.6, 0], FaceFrontAttachment: [0, 0, -0.6], FaceCenterAttachment: [0, 0, 0] };
const DEFAULT_PARTS = {
  Head: { group: "head", size: [2, 1, 1], atts: HEAD_ATTS },
  UpperTorso: { group: "torso", size: [2, 1.6, 1], slice: [0, 0.8], regions: "torso", atts: {
    NeckRigAttachment: [0, 0.8, 0], WaistRigAttachment: [0, -0.8, 0],
    LeftShoulderRigAttachment: [-1, 0.5, 0], RightShoulderRigAttachment: [1, 0.5, 0],
    BodyFrontAttachment: [0, 0, -0.5], BodyBackAttachment: [0, 0, 0.5], NeckAttachment: [0, 0.8, 0],
    LeftCollarAttachment: [-1, 0.8, 0], RightCollarAttachment: [1, 0.8, 0] } },
  LowerTorso: { group: "torso", size: [2, 0.4, 1], slice: [0.8, 1], regions: "torso", atts: {
    WaistRigAttachment: [0, 0.2, 0], LeftHipRigAttachment: [-0.5, -0.2, 0], RightHipRigAttachment: [0.5, -0.2, 0],
    WaistCenterAttachment: [0, 0, 0], WaistFrontAttachment: [0, 0, -0.5], WaistBackAttachment: [0, 0, 0.5] } },
};
for (const [side, sx, prefix] of [["right", 1, "Right"], ["left", -1, "Left"]]) {
  DEFAULT_PARTS[`${prefix}UpperArm`] = { group: `${side}Arm`, size: [1, 1, 1], slice: [0, 0.5], regions: side, atts: {
    [`${prefix}ShoulderRigAttachment`]: [-0.5 * sx, 0.2, 0], [`${prefix}ElbowRigAttachment`]: [0, -0.5, 0], [`${prefix}ShoulderAttachment`]: [0, 0.5, 0] } };
  DEFAULT_PARTS[`${prefix}LowerArm`] = { group: `${side}Arm`, size: [1, 0.7, 1], slice: [0.5, 0.85], regions: side, atts: {
    [`${prefix}ElbowRigAttachment`]: [0, 0.35, 0], [`${prefix}WristRigAttachment`]: [0, -0.35, 0] } };
  DEFAULT_PARTS[`${prefix}Hand`] = { group: `${side}Arm`, size: [1, 0.3, 1], slice: [0.85, 1], regions: side, atts: {
    [`${prefix}WristRigAttachment`]: [0, 0.15, 0], [`${prefix}GripAttachment`]: [0, -0.15, 0] } };
  DEFAULT_PARTS[`${prefix}UpperLeg`] = { group: `${side}Leg`, size: [1, 1, 1], slice: [0, 0.5], regions: side, atts: {
    [`${prefix}HipRigAttachment`]: [0, 0.5, 0], [`${prefix}KneeRigAttachment`]: [0, -0.5, 0] } };
  DEFAULT_PARTS[`${prefix}LowerLeg`] = { group: `${side}Leg`, size: [1, 0.7, 1], slice: [0.5, 0.85], regions: side, atts: {
    [`${prefix}KneeRigAttachment`]: [0, 0.35, 0], [`${prefix}AnkleRigAttachment`]: [0, -0.35, 0] } };
  DEFAULT_PARTS[`${prefix}Foot`] = { group: `${side}Leg`, size: [1, 0.3, 1], slice: [0.85, 1], regions: side, atts: {
    [`${prefix}AnkleRigAttachment`]: [0, 0.15, 0], [`${prefix}FootAttachment`]: [0, -0.15, 0] } };
}
const PART_GROUP = Object.fromEntries(Object.entries(DEFAULT_PARTS).map(([k, v]) => [k, v.group]));
const COLOR_KEYS = { head: "headColor3", torso: "torsoColor3", rightArm: "rightArmColor3", leftArm: "leftArmColor3", rightLeg: "rightLegColor3", leftLeg: "leftLegColor3" };

// ---- part visuals ---------------------------------------------------------------------------

function standardMaterial(opts) {
  return new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide, ...opts });
}

// Visual for a Part/MeshPart node in part-local space.
async function partVisual(node, ctx, look = {}) {
  const p = node.props;
  const transparency = p.Transparency || 0;
  if (transparency >= 0.99 && !look.force) return null;
  const size = p.size || p.Size || [1, 1, 1];
  const color = look.color || p.Color3uint8 || p.Color || DEFAULT_COLOR;
  const special = node.children.find((c) => c.className === "SpecialMesh" || c.className === "FileMesh");
  const surface = node.children.find((c) => c.className === "SurfaceAppearance");

  let geom, texId = null, overlayColor = false, tint = null;
  if (node.className === "MeshPart") {
    const meshId = assetIdOf(p.MeshId || p.MeshContent);
    if (!meshId) return null;
    geom = (await loadMesh(meshId)).clone();
    geom.computeBoundingBox();
    const center = geom.boundingBox.getCenter(new THREE.Vector3()), bsize = geom.boundingBox.getSize(new THREE.Vector3());
    const init = p.InitialSize || [bsize.x, bsize.y, bsize.z];
    geom.translate(-center.x, -center.y, -center.z);
    geom.scale(size[0] / (init[0] || 1), size[1] / (init[1] || 1), size[2] / (init[2] || 1));
    texId = assetIdOf(surface && (surface.props.ColorMap || surface.props.ColorMapContent)) || assetIdOf(p.TextureID || p.TextureContent);
    overlayColor = true; // MeshPart textures show the part color through transparent pixels
  } else if (special) {
    const sp = special.props, scale = sp.Scale || [1, 1, 1], offset = sp.Offset || [0, 0, 0];
    const type = sp.MeshType ?? 5;
    const meshId = assetIdOf(sp.MeshId);
    if (type === 5 && meshId) {
      geom = (await loadMesh(meshId)).clone();
      geom.scale(...scale);
      texId = assetIdOf(sp.TextureId);
      tint = sp.VertexColor;
    } else {
      const scaled = size.map((s, i) => s * scale[i]);
      const kind = { 0: "head", 3: "ball", 4: "cylinderY", 2: "wedge" }[type] || "box";
      geom = kind === "head" ? primitive("head", [scaled[2], scaled[1], scaled[2]]) : primitive(kind, scaled);
    }
    geom.translate(...offset);
  } else {
    const shape = p.shape ?? p.Shape ?? 1;
    const kind = node.className === "WedgePart" ? "wedge" : shape === 0 ? "ball" : shape === 2 ? "cylinderX" : "box";
    geom = look.geometry || primitive(kind, size);
  }

  let material;
  if (look.canvasGroup) {
    // Body part: composite body color + clothing + part texture onto the template canvas.
    const img = texId ? await tryImage(texId, ctx, node.name) : null;
    material = standardMaterial({ map: textureFrom(await ctx.bodyCanvas(look.canvasGroup, img)) });
    const clothes = look.def && ctx.clothingCanvas(look.canvasGroup);
    if (clothes && look.def.regions) {
      // Clothing overlay: same surface, template box-projected (see projectTemplate).
      const overlay = new THREE.Mesh(projectTemplate(geom, REGIONS[look.def.regions], ...look.def.slice),
        standardMaterial({ map: textureFrom(clothes), transparent: true, alphaTest: 0.08, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.92 }));
      const base = new THREE.Mesh(geom, material);
      const grp = new THREE.Group();
      grp.name = node.name;
      grp.add(base, overlay);
      return grp;
    }
  } else if (texId) {
    const img = await tryImage(texId, ctx, node.name);
    if (img && overlayColor) {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.fillStyle = css(color); g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0);
      material = standardMaterial({ map: textureFrom(c) });
    } else if (img) {
      material = standardMaterial({ map: textureFrom(img), color: new THREE.Color(...(tint || [1, 1, 1])), alphaTest: 0.05, transparent: true });
    }
  }
  if (!material) material = standardMaterial({ color: new THREE.Color().setRGB(...color, THREE.SRGBColorSpace) });
  if (transparency > 0 && transparency < 0.99) { material.transparent = true; material.opacity = 1 - transparency; }

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = node.name;
  return mesh;
}

// ---- rendering parts with their effects -------------------------------------------------------

function makeCtx(onWarn) {
  const warnings = [];
  return { warnings, effects: [], itemObjects: [], warn: (m) => { warnings.push(m); onWarn && onWarn(m); } };
}

const EFFECT_CLASSES = /^(ParticleEmitter|Fire|Smoke|Sparkles|PointLight|SpotLight|SurfaceLight)$/;

// partVisual + any Fire/ParticleEmitter/Smoke/Sparkles/lights inside the part.
async function renderPart(node, ctx, look) {
  const obj = await partVisual(node, ctx, look);
  if (!obj) return null;
  if (findAll(node.children, (n) => EFFECT_CLASSES.test(n.className)).length) {
    try { ctx.effects.push(...await buildEffects(node, obj, loadImage, assetIdOf)); }
    catch (e) { ctx.warn(`${node.name} effects: ${e.message}`); }
  }
  return obj;
}

// Root group gets userData.tick(dt, camera, viewportH) that drives animation + effects.
function finishRoot(root, ctx, player) {
  const fx = effectsTicker(root, ctx.effects);
  const fades = [];
  // Quick fade + scale for accessories being taken off / put back on (no rebuild).
  root.userData.setItemVisible = (id, show) => {
    const objs = ctx.itemObjects.filter((o) => o.userData.assetId === String(id));
    for (const o of objs) {
      const mats = [];
      o.traverse((c) => { for (const m of Array.isArray(c.material) ? c.material : c.material ? [c.material] : []) if (!m.userData.noFade) mats.push(m); });
      for (const m of mats) {
        if (m.userData.fadeBase === undefined) m.userData.fadeBase = { opacity: m.opacity, transparent: m.transparent };
        m.transparent = true;
      }
      if (o.userData.baseScale === undefined) o.userData.baseScale = o.scale.clone();
      o.visible = true;
      const from = o.userData.fadeT ?? (show ? 0 : 1);
      for (let i = fades.length - 1; i >= 0; i--) if (fades[i].o === o) fades.splice(i, 1);
      fades.push({ o, mats, from, to: show ? 1 : 0, t: 0 });
    }
    return objs.length > 0;
  };
  const stepFades = (dt) => {
    for (let i = fades.length - 1; i >= 0; i--) {
      const f = fades[i];
      f.t = Math.min(1, f.t + dt / 0.22);
      const e = 1 - Math.pow(1 - f.t, 3);
      const v = f.from + (f.to - f.from) * e;
      f.o.userData.fadeT = v;
      for (const m of f.mats) m.opacity = m.userData.fadeBase.opacity * v;
      f.o.scale.copy(f.o.userData.baseScale).multiplyScalar(0.85 + 0.15 * v);
      if (f.t >= 1) {
        fades.splice(i, 1);
        if (f.to === 0) f.o.visible = false;
        else for (const m of f.mats) { m.transparent = m.userData.fadeBase.transparent; m.opacity = m.userData.fadeBase.opacity; }
      }
    }
  };
  root.userData.tick = (dt, camera, h) => { if (player) player.update(dt); stepFades(dt); fx(dt, camera, h); };
  root.userData.hasEffects = ctx.effects.length > 0;
  return root;
}

// ---- character rig ------------------------------------------------------------------------
// Motor6D hierarchy: Part1.CFrame = Part0.CFrame * C0 * Transform * C1:Inverse(),
// with C0/C1 taken from matching rig attachments on the two parts.

const JOINTS = [
  ["LowerTorso", "UpperTorso", "WaistRigAttachment"],
  ["UpperTorso", "Head", "NeckRigAttachment"],
  ["UpperTorso", "LeftUpperArm", "LeftShoulderRigAttachment"],
  ["LeftUpperArm", "LeftLowerArm", "LeftElbowRigAttachment"],
  ["LeftLowerArm", "LeftHand", "LeftWristRigAttachment"],
  ["UpperTorso", "RightUpperArm", "RightShoulderRigAttachment"],
  ["RightUpperArm", "RightLowerArm", "RightElbowRigAttachment"],
  ["RightLowerArm", "RightHand", "RightWristRigAttachment"],
  ["LowerTorso", "LeftUpperLeg", "LeftHipRigAttachment"],
  ["LeftUpperLeg", "LeftLowerLeg", "LeftKneeRigAttachment"],
  ["LeftLowerLeg", "LeftFoot", "LeftAnkleRigAttachment"],
  ["LowerTorso", "RightUpperLeg", "RightHipRigAttachment"],
  ["RightUpperLeg", "RightLowerLeg", "RightKneeRigAttachment"],
  ["RightLowerLeg", "RightFoot", "RightAnkleRigAttachment"],
];

function makeRig(parts) {
  const I = new THREE.Matrix4();
  const ut = parts.UpperTorso, lt = parts.LowerTorso;
  // Rest pose: UpperTorso at the origin.
  const ltRest = ut.atts.WaistRigAttachment && lt.atts.WaistRigAttachment
    ? ut.atts.WaistRigAttachment.clone().multiply(lt.atts.WaistRigAttachment.clone().invert())
    : new THREE.Matrix4().makeTranslation(0, -1, 0);
  const rootAtt = lt.atts.RootRigAttachment || I;
  const rootAttInv = rootAtt.clone().invert();
  const tmp = new THREE.Matrix4();

  function pose(transforms) {
    for (const p of Object.values(parts)) p.world = null;
    lt.world = ltRest.clone().multiply(rootAtt).multiply(transforms.LowerTorso || I).multiply(rootAttInv);
    for (const [p0, p1, att] of JOINTS) {
      const a = parts[p0], b = parts[p1];
      if (!a.world || !a.atts[att] || !b.atts[att]) continue;
      b.world = a.world.clone().multiply(a.atts[att]).multiply(transforms[p1] || I).multiply(tmp.copy(b.atts[att]).invert());
    }
    for (const p of Object.values(parts)) {
      if (!p.holder) continue;
      p.holder.visible = !!p.world;
      if (p.world) { p.holder.matrix.copy(p.world); p.holder.matrixWorldNeedsUpdate = true; }
    }
  }
  return { pose };
}

// spec: { colors, partNodes: {name: node}, classicHead, face, shirt, pants, tshirt, accessories: [{tree, meta}], scales }
async function buildCharacter(spec, ctx) {
  const root = new THREE.Group();
  const [shirtImg, pantsImg, tshirtImg, faceImg] = await Promise.all([
    tryImage(spec.shirt, ctx, "Shirt"), tryImage(spec.pants, ctx, "Pants"),
    tryImage(spec.tshirt, ctx, "T-Shirt"), tryImage(spec.face, ctx, "Face"),
  ]);

  const colorOf = (group) => spec.colors[group] || DEFAULT_COLOR;
  const drawClothing = (g, group) => {
    const legs = group.endsWith("Leg"), arms = group.endsWith("Arm");
    let drew = false;
    if (pantsImg && (legs || group === "torso")) { g.drawImage(pantsImg, 0, 0, TEMPLATE_W, TEMPLATE_H); drew = true; }
    if (shirtImg && (arms || group === "torso")) { g.drawImage(shirtImg, 0, 0, TEMPLATE_W, TEMPLATE_H); drew = true; }
    if (tshirtImg && group === "torso") { g.drawImage(tshirtImg, 231, 74, 128, 128); drew = true; }
    return drew;
  };
  // Body color + the part's own texture (mesh UVs).
  ctx.bodyCanvas = async (group, partImg) => {
    const c = document.createElement("canvas");
    c.width = partImg ? partImg.naturalWidth : 64; c.height = partImg ? partImg.naturalHeight : 64;
    const g = c.getContext("2d");
    g.fillStyle = css(colorOf(group)); g.fillRect(0, 0, c.width, c.height);
    if (partImg) g.drawImage(partImg, 0, 0, c.width, c.height);
    return c;
  };
  // Clothing layers on a template-sized canvas (null if nothing to draw).
  const clothingCache = {};
  ctx.clothingCanvas = (group, withColor = false) => {
    const key = group + withColor;
    if (key in clothingCache) return clothingCache[key];
    const c = document.createElement("canvas");
    c.width = TEMPLATE_W; c.height = TEMPLATE_H;
    const g = c.getContext("2d");
    if (withColor) {
      g.fillStyle = css(colorOf(group)); g.fillRect(0, 0, TEMPLATE_W, TEMPLATE_H);
      edgeShade(g, group);
    }
    const drew = group !== "head" && drawClothing(g, group);
    return (clothingCache[key] = drew || withColor ? c : null);
  };

  // Parts: custom MeshParts override the default blocky ones. Body scales (R15 only):
  // width/height/depth for the body, uniform head scale; attachment offsets scale too.
  const sc = spec.scales || {};
  const bodyScale = [sc.width || 1, sc.height || 1, sc.depth || 1];
  const headScale = [sc.head || 1, sc.head || 1, sc.head || 1];
  const parts = {};
  for (const name of Object.keys(DEFAULT_PARTS)) {
    const node = spec.partNodes[name];
    const def = DEFAULT_PARTS[name];
    const scale = name === "Head" ? headScale : bodyScale;
    let attPos = def.atts;
    if (name === "Head" && !node && spec.headAtts && Object.keys(spec.headAtts).length) attPos = { ...def.atts, ...spec.headAtts };
    const atts = node
      ? attachmentsOf(node)
      : Object.fromEntries(Object.entries(attPos).map(([k, v]) => [k, new THREE.Matrix4().makeTranslation(...v)]));
    for (const m of Object.values(atts)) { m.elements[12] *= scale[0]; m.elements[13] *= scale[1]; m.elements[14] *= scale[2]; }
    const holder = new THREE.Group();
    holder.name = name;
    holder.matrixAutoUpdate = false;
    root.add(holder);
    parts[name] = { name, node, def: node ? null : def, atts, scale, holder };
  }
  // Custom parts may lack a rig attachment; borrow the default one so the joint still connects.
  for (const [p0, p1, att] of JOINTS) {
    for (const n of [p0, p1]) {
      const p = parts[n], d = DEFAULT_PARTS[n].atts[att];
      if (!p.atts[att] && d) p.atts[att] = new THREE.Matrix4().makeTranslation(d[0] * p.scale[0], d[1] * p.scale[1], d[2] * p.scale[2]);
    }
  }
  const rig = makeRig(parts);
  rig.pose({});

  // Body part visuals, inside each part's holder.
  await Promise.all(Object.values(parts).map(async (p) => {
    const group = PART_GROUP[p.name];
    let obj;
    if (p.node) {
      obj = await renderPart(p.node, ctx, { canvasGroup: group, def: DEFAULT_PARTS[p.name], force: true }).catch((e) => { ctx.warn(`${p.name}: ${e.message}`); return null; });
    } else if (p.name === "Head") {
      obj = await defaultHead(spec, ctx, colorOf("head"), faceImg);
    } else {
      const geom = templateBox(p.def.size, REGIONS[p.def.regions], ...p.def.slice);
      obj = new THREE.Mesh(geom, standardMaterial({ map: textureFrom(ctx.clothingCanvas(group, true)), side: THREE.FrontSide }));
    }
    if (!obj) return;
    obj.scale.set(...p.scale);
    p.holder.add(obj);
  }));

  // Accessories ride on the part that owns their attachment.
  await Promise.all(spec.accessories.map((a) => attachAccessory(a.tree, parts, ctx, a.meta, a).catch((e) => ctx.warn(e.message))));

  const player = new AnimationPlayer(rig);
  root.userData.player = player;
  root.userData.animatable = true;
  return finishRoot(root, ctx, player);
}

async function defaultHead(spec, ctx, color, faceImg) {
  const group = new THREE.Group();
  if (spec.classicHead) {
    // Head asset as a SpecialMesh (classic heads and SpecialMesh-based dynamic heads). Its own
    // texture shows the head color through transparent pixels; classic faces map via the mesh UVs.
    const node = { className: "Part", name: "Head", props: { size: [2, 1, 1] }, children: [spec.classicHead] };
    let mesh = null;
    try { mesh = await partVisual(node, ctx, { force: true }); }
    catch (e) { ctx.warn(`${spec.headName || "Head"}: ${e.message}`); }
    if (mesh) {
      const texImg = await tryImage(assetIdOf(spec.classicHead.props.TextureId), ctx, spec.headName || "Head");
      const size = texImg ? Math.max(texImg.naturalWidth, 256) : 256;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d");
      g.fillStyle = css(color); g.fillRect(0, 0, size, size);
      if (texImg) g.drawImage(texImg, 0, 0, size, size);
      if (faceImg && !spec.dynamicHead) g.drawImage(faceImg, 0, 0, size, size);
      mesh.material = standardMaterial({ map: textureFrom(c) });
      group.add(mesh);
      return group;
    }
    // Mesh unavailable: fall through to the default head.
  }
  const r = 0.6, h = 1.2;
  group.add(new THREE.Mesh(roundedHead(r, h), standardMaterial({ color: new THREE.Color().setRGB(...color, THREE.SRGBColorSpace) })));
  if (faceImg) {
    const arc = Math.PI * 0.62;
    const decal = new THREE.CylinderGeometry(r + 0.004, r + 0.004, h * 0.92, 24, 1, true, Math.PI - arc / 2, arc);
    group.add(new THREE.Mesh(decal, standardMaterial({ map: textureFrom(faceImg), transparent: true, alphaTest: 0.05, side: THREE.FrontSide })));
  }
  return group;
}

// Avatar-editor accessory adjustment (assets[].meta): scale first, then rotate, then offset,
// all in the body attachment's space. Field casing varies, so accept both.
function adjustmentMatrix(meta, partScale) {
  const v = (o, d) => (o ? [o.X ?? o.x ?? d, o.Y ?? o.y ?? d, o.Z ?? o.z ?? d] : [d, d, d]);
  const pos = v(meta && meta.position, 0), rot = v(meta && meta.rotation, 0), scl = v(meta && meta.scale, 1);
  const deg = THREE.MathUtils.degToRad;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(rot[0]), deg(rot[1]), deg(rot[2]), "XYZ")),
    new THREE.Vector3(scl[0] * partScale[0], scl[1] * partScale[1], scl[2] * partScale[2]),
  );
}

async function attachAccessory(tree, parts, ctx, meta, info = {}) {
  const acc = findAll(tree, (n) => ["Accessory", "Hat", "Accoutrement"].includes(n.className))[0] || tree[0];
  const handle = (acc.children || []).find((c) => c.name === "Handle" && BASEPARTS.has(c.className))
    || findAll(tree, (n) => BASEPARTS.has(n.className))[0];
  if (!handle) return;

  // Handle placement relative to the owning body part.
  const handleAtt = handle.children.find((c) => c.className === "Attachment" && Object.values(parts).some((p) => p.atts[c.name]));
  let target, local;
  if (handleAtt) {
    target = Object.values(parts).find((p) => p.atts[handleAtt.name]);
    local = target.atts[handleAtt.name].clone().multiply(adjustmentMatrix(meta, target.scale)).multiply(cfMatrix(handleAtt.props.CFrame).invert());
  } else {
    // Legacy hats: AttachmentPoint relative to the head's HatAttachment.
    target = parts.Head;
    const hatAtt = target.atts.HatAttachment || new THREE.Matrix4().makeTranslation(0, 0.6, 0);
    local = hatAtt.clone().multiply(adjustmentMatrix(meta, target.scale)).multiply(cfMatrix(acc.props.AttachmentPoint).invert());
  }

  // The handle plus any other parts welded to it, positioned relative to the handle.
  const handleInv = cfMatrix(handle.props.CFrame).invert();
  for (const part of findAll([acc], (n) => BASEPARTS.has(n.className))) {
    const obj = await renderPart(part, ctx).catch((e) => { ctx.warn(`${acc.name}: ${e.message}`); return null; });
    if (!obj) continue;
    const rel = part === handle ? new THREE.Matrix4() : handleInv.clone().multiply(cfMatrix(part.props.CFrame));
    obj.applyMatrix4(local.clone().multiply(rel));
    obj.userData.assetId = info.id;
    if (info.hidden) obj.visible = false;
    target.holder.add(obj);
    ctx.itemObjects.push(obj);
  }
}

// Pull body MeshParts (R15) out of a body-part asset tree.
function bodyPartNodes(tree) {
  const folder = tree.find((n) => n.name === "R15ArtistIntent") || tree.find((n) => n.name === "R15Fixed");
  const scope = folder ? folder.children : tree;
  const out = {};
  for (const n of findAll(scope, (x) => x.className === "MeshPart" && DEFAULT_PARTS[x.name])) out[n.name] = out[n.name] || n;
  return out;
}

// Turn downloaded avatar assets into a character spec.
function specFromAssets(entries, opts = {}) {
  const spec = { colors: opts.colors || {}, partNodes: {}, accessories: [], r6: opts.r6, scales: opts.scales };
  for (const { type, tree, meta, id, hidden } of entries) {
    if (!tree) continue;
    if (ACCESSORY_TYPES.has(type)) spec.accessories.push({ tree, meta, id, hidden });
    else if (hidden) continue;
    else if (BODY_PART_TYPES[type] && !spec.r6) Object.assign(spec.partNodes, bodyPartNodes(tree));
    else if (type === 79 || type === 17) {
      // Heads come as a MeshPart "Head" (dynamic heads) or a bare SpecialMesh whose attachment
      // positions are stored as Vector3Value children (classic + some dynamic heads).
      const head = !spec.r6 && findAll(tree, (n) => n.className === "MeshPart" && n.name === "Head")[0];
      if (head) spec.partNodes.Head = head;
      else {
        const sm = findAll(tree, (n) => n.className === "SpecialMesh")[0];
        if (sm) {
          spec.classicHead = sm;
          spec.dynamicHead = type === 79;
          spec.headName = opts.names && opts.names[type];
          spec.headAtts = {};
          for (const v of findAll([sm], (n) => n.className === "Vector3Value" && /Attachment$/.test(n.name))) spec.headAtts[v.name] = v.props.Value;
        }
      }
    } else if (type === 18) {
      const decal = findAll(tree, (n) => n.className === "Decal")[0];
      spec.face = decal && assetIdOf(decal.props.Texture);
    } else if (type === 11) {
      const s = findAll(tree, (n) => n.className === "Shirt")[0];
      spec.shirt = s && assetIdOf(s.props.ShirtTemplate);
    } else if (type === 12) {
      const s = findAll(tree, (n) => n.className === "Pants")[0];
      spec.pants = s && assetIdOf(s.props.PantsTemplate);
    } else if (type === 2) {
      const s = findAll(tree, (n) => n.className === "ShirtGraphic")[0];
      spec.tshirt = s && assetIdOf(s.props.Graphic);
    }
  }
  if (spec.partNodes.Head) spec.classicHead = null;
  if (!spec.partNodes.Head && spec.face === undefined) spec.face = DEFAULT_FACE_IMAGE;
  return spec;
}

// ---- animations ---------------------------------------------------------------------------

// Clip for a slot (idle/walk/...): the avatar's own pack first, then Roblox's default.
export async function loadSlotClip(slot, packId) {
  if (packId) {
    try { return { clip: await resolveClip(packId, loadModel, slot), source: "avatar" }; }
    catch (e) { return { clip: await resolveClip(DEFAULT_ANIMS[slot], loadModel, slot), source: "default", note: e.message }; }
  }
  return { clip: await resolveClip(DEFAULT_ANIMS[slot], loadModel, slot), source: "default" };
}

export async function loadAssetClip(assetId, slot) {
  return { clip: await resolveClip(assetId, loadModel, slot), source: "asset" };
}

// ---- public entry points --------------------------------------------------------------------

const ANIMATION_ASSET_TYPES = new Set([24, 48, 49, 50, 51, 52, 53, 54, 55, 56, 61, 78]);

const ASSET_TYPE_NAMES = {
  2: "T-Shirt", 8: "Hat", 11: "Shirt", 12: "Pants", 17: "Head", 18: "Face", 27: "Torso", 28: "Right Arm", 29: "Left Arm",
  30: "Left Leg", 31: "Right Leg", 41: "Hair", 42: "Face Accessory", 43: "Neck", 44: "Shoulder", 45: "Front", 46: "Back",
  47: "Waist", 57: "Ear", 58: "Eye", 64: "T-Shirt (3D)", 65: "Shirt (3D)", 66: "Pants (3D)", 67: "Jacket", 68: "Sweater",
  69: "Shorts", 70: "Left Shoe", 71: "Right Shoe", 72: "Dress / Skirt", 76: "Eyebrows", 77: "Eyelashes", 79: "Dynamic Head",
};
export const isAccessoryType = (t) => ACCESSORY_TYPES.has(t);
const isVisualType = (t) => ACCESSORY_TYPES.has(t) || BODY_PART_TYPES[t] || [2, 11, 12, 17, 18, 79].includes(t);
// Types where an avatar can wear only one item (try-on replaces the worn one).
const SINGLE_SLOT_TYPES = new Set([2, 11, 12, 17, 18, 79, 27, 28, 29, 30, 31]);
export const isWearableType = (t) => isVisualType(t);

// opts.add: [{ id, name, typeId }] items to try on; opts.remove: Set of asset ids to take off.
// Returns items: the visual outfit [{ id, name, typeId, removed, tried }] for the UI.
export async function buildAvatar(userId, onWarn, opts = {}) {
  const ctx = makeCtx(onWarn);
  const av = await fetch(`/api/avatar/${userId}`).then((r) => r.json());
  if (!av || !av.assets) throw new Error("Could not load avatar data");
  const c = av.bodyColor3s || {};
  const colors = Object.fromEntries(Object.entries(COLOR_KEYS).map(([g, k]) => [g, hexColor(c[k])]));
  const remove = opts.remove || new Set();
  const add = (opts.add || []).filter((a) => isVisualType(a.typeId));

  // Outfit = worn visual items (minus slots replaced by tried-on items) + tried-on items.
  const replaced = new Set(add.filter((a) => SINGLE_SLOT_TYPES.has(a.typeId)).map((a) => a.typeId));
  const items = av.assets
    .filter((a) => isVisualType(a.assetType.id) && !add.some((t) => String(t.id) === String(a.id)))
    .map((a) => ({ id: String(a.id), name: a.name, typeId: a.assetType.id, meta: a.meta, replaced: replaced.has(a.assetType.id) }))
    .concat(add.map((a) => ({ id: String(a.id), name: a.name, typeId: a.typeId, tried: true })));
  for (const it of items) it.removed = remove.has(it.id) || it.replaced;

  const worn = items.filter((it) => !it.removed);
  // Removed accessories are still built (hidden) so they can fade back in without a rebuild.
  const toBuild = items.filter((it) => !it.removed || (ACCESSORY_TYPES.has(it.typeId) && !it.replaced));
  const entries = await Promise.all(toBuild.map(async (a) => {
    try { return { id: a.id, hidden: a.removed, type: a.typeId, meta: a.meta, tree: (await loadModel(a.id)).tree }; }
    catch (e) { if (!a.removed) ctx.warn(`${a.name}: ${e.message}`); a.failed = true; return { type: a.typeId, tree: null }; }
  }));
  for (const it of items) it.typeName = it.typeName || ASSET_TYPE_NAMES[it.typeId] || "Item";
  const r6 = av.playerAvatarType === "R6";
  const names = Object.fromEntries(worn.map((a) => [a.typeId, a.name]));
  const spec = specFromAssets(entries, { colors, r6, scales: r6 ? null : av.scales, names });
  const root = await buildCharacter(spec, ctx);
  // The avatar's equipped animation pack per slot.
  root.userData.animPacks = {};
  for (const a of av.assets) if (ANIM_TYPES[a.assetType.id]) root.userData.animPacks[ANIM_TYPES[a.assetType.id]] = String(a.id);
  return { object: root, warnings: ctx.warnings, info: `${av.playerAvatarType} · ${worn.length} items`, items };
}

export async function buildAsset(assetId, assetTypeId, onWarn) {
  const ctx = makeCtx(onWarn);

  // Animations are previewed on a default character.
  if (ANIMATION_ASSET_TYPES.has(assetTypeId)) {
    const root = await buildCharacter(specFromAssets([]), ctx);
    root.userData.autoplay = { assetId: String(assetId), slot: ANIM_TYPES[assetTypeId] || "idle" };
    return { object: root, warnings: ctx.warnings };
  }

  const model = await loadModel(assetId);
  if (model.kind === "mesh") {
    const geom = await loadMesh(String(assetId));
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geom, standardMaterial({ color: new THREE.Color().setRGB(...DEFAULT_COLOR, THREE.SRGBColorSpace) })));
    return { object: finishRoot(root, ctx), warnings: ctx.warnings };
  }
  if (!model.tree) throw new Error(`This asset is a ${model.kind} file, not a 3D model.`);
  const tree = model.tree;

  // Wearables without their own geometry are shown on a default character.
  if ([2, 11, 12, 17, 18, 27, 28, 29, 30, 31, 79].includes(assetTypeId)) {
    const spec = specFromAssets([{ type: assetTypeId, tree }]);
    return { object: await buildCharacter(spec, ctx), warnings: ctx.warnings };
  }

  const root = new THREE.Group();
  const handle = ACCESSORY_TYPES.has(assetTypeId) ? findAll(tree, (n) => n.name === "Handle" && BASEPARTS.has(n.className))[0] : null;
  // Accessories are centered on their handle; other models keep their own CFrames.
  const base = handle ? cfMatrix(handle.props.CFrame).invert() : new THREE.Matrix4();
  await Promise.all(findAll(tree, (n) => BASEPARTS.has(n.className)).map(async (part) => {
    const obj = await renderPart(part, ctx).catch((e) => { ctx.warn(`${part.name}: ${e.message}`); return null; });
    if (obj) { obj.applyMatrix4(base.clone().multiply(cfMatrix(part.props.CFrame))); root.add(obj); }
  }));
  if (!root.children.length) throw new Error(ctx.warnings.length ? `Couldn't download this item's mesh (${ctx.warnings[0].replace(/^[^:]*: /, "")})` : "No renderable parts found in this asset.");
  return { object: finishRoot(root, ctx), warnings: ctx.warnings };
}

// Effects only (for overlaying on Roblox's official render, which has no particles).
// Anchors sit relative to the accessory handle; the caller positions the returned group.
export async function buildAssetEffects(assetId, assetTypeId) {
  const ctx = makeCtx();
  const model = await loadModel(String(assetId));
  if (!model.tree) return null;
  const tree = model.tree;
  const handle = ACCESSORY_TYPES.has(assetTypeId) ? findAll(tree, (n) => n.name === "Handle" && BASEPARTS.has(n.className))[0] : null;
  const base = handle ? cfMatrix(handle.props.CFrame).invert() : new THREE.Matrix4();
  const root = new THREE.Group();
  for (const part of findAll(tree, (n) => BASEPARTS.has(n.className))) {
    if (!findAll(part.children, (n) => EFFECT_CLASSES.test(n.className)).length) continue;
    const anchor = new THREE.Object3D();
    anchor.applyMatrix4(base.clone().multiply(cfMatrix(part.props.CFrame)));
    root.add(anchor);
    ctx.effects.push(...await buildEffects(part, anchor, loadImage, assetIdOf));
  }
  if (!ctx.effects.length) return null;
  return finishRoot(root, ctx);
}
