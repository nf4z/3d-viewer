// Roblox visual effects -> Three.js: ParticleEmitter, Fire, Smoke, Sparkles, lights.
// Particles are simulated in the model root's space and drawn as textured point sprites.
import * as THREE from "three";

// NormalId enum: Right, Top, Back, Left, Bottom, Front
const NORMALS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];

// ---- helpers ------------------------------------------------------------------------

const rand = (a, b) => a + Math.random() * (b - a);
const range = (r, d) => (Array.isArray(r) ? rand(r[0], r[1]) : r ?? d);

// Evaluate a NumberSequence ([[t, v, env], ...]) or ColorSequence ([[t, r, g, b], ...]) at t in [0,1].
function seqAt(seq, t, width) {
  if (!Array.isArray(seq) || !seq.length) return null;
  if (!Array.isArray(seq[0])) return width === 1 ? seq : null;
  let i = 0;
  while (i < seq.length - 2 && seq[i + 1][0] < t) i++;
  const a = seq[i], b = seq[Math.min(i + 1, seq.length - 1)];
  const f = b[0] > a[0] ? THREE.MathUtils.clamp((t - a[0]) / (b[0] - a[0]), 0, 1) : 0;
  if (width === 1) return a[1] + (b[1] - a[1]) * f;
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

let softTex = null;
function softTexture() {
  if (softTex) return softTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.4, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  softTex = new THREE.CanvasTexture(c);
  return softTex;
}

let sparkleTex = null;
function sparkleTexture() {
  if (sparkleTex) return sparkleTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.translate(32, 32);
  for (const [w, l] of [[3, 30], [2, 18]]) {
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, l);
    grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(-w, -l, w * 2, l * 2); g.fillRect(-l, -w, l * 2, w * 2);
    g.rotate(Math.PI / 4);
  }
  sparkleTex = new THREE.CanvasTexture(c);
  return sparkleTex;
}

const VERT = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  attribute float aRot;
  uniform float uScale;
  varying vec4 vColor;
  varying float vRot;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale / max(-mv.z, 0.001);
    vColor = aColor;
    vRot = aRot;
  }`;
const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec4 vColor;
  varying float vRot;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float c = cos(vRot), s = sin(vRot);
    p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) * 1.4142 + 0.5;
    if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) discard;
    vec4 t = texture2D(uMap, vec2(p.x, 1.0 - p.y));
    float a = vColor.a * t.a;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor.rgb * t.rgb, a);
  }`;

// ---- generic particle system ------------------------------------------------------------

class Particles {
  // cfg: rate, lifetime[2], speed[2], spread[2] (deg), accel[3], drag, size(seq|num), color(seq|rgb),
  //      transparency(seq|num), additive, brightness, rotation[2], rotSpeed[2], dir (NormalId),
  //      volume[3] (emission box in anchor space), locked, map
  constructor(anchor, cfg) {
    this.anchor = anchor;
    this.cfg = cfg;
    this.max = Math.min(600, Math.ceil(cfg.rate * Math.max(cfg.lifetime[1], 0.1)) + 8);
    this.n = 0;
    this.acc = 0;
    const m = this.max;
    this.pos = new Float32Array(m * 3); this.vel = new Float32Array(m * 3);
    this.age = new Float32Array(m); this.life = new Float32Array(m);
    this.rot = new Float32Array(m); this.rotV = new Float32Array(m); this.seed = new Float32Array(m);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(m * 3), 3);
    this.aSize = new THREE.BufferAttribute(new Float32Array(m), 1);
    this.aColor = new THREE.BufferAttribute(new Float32Array(m * 4), 4);
    this.aRot = new THREE.BufferAttribute(new Float32Array(m), 1);
    for (const a of [this.aPos, this.aSize, this.aColor, this.aRot]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", this.aPos); g.setAttribute("aSize", this.aSize);
    g.setAttribute("aColor", this.aColor); g.setAttribute("aRot", this.aRot);
    g.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      blending: cfg.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uMap: { value: cfg.map || softTexture() }, uScale: { value: 600 } },
    });
    this.material.userData.noFade = true;
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.userData.noFade = true;
    this._m = new THREE.Matrix4(); this._v = new THREE.Vector3(); this._d = new THREE.Vector3();
  }

  // Anchor transform relative to the model root (the Points' parent).
  anchorMatrix(root) {
    root.updateWorldMatrix(true, false);
    this.anchor.updateWorldMatrix(true, false);
    return this._m.copy(root.matrixWorld).invert().multiply(this.anchor.matrixWorld);
  }

  spawn(M) {
    if (this.n >= this.max) return;
    const c = this.cfg, i = this.n++;
    const vol = c.volume || [0, 0, 0];
    const p = this._v.set(rand(-0.5, 0.5) * vol[0], rand(-0.5, 0.5) * vol[1], rand(-0.5, 0.5) * vol[2]).applyMatrix4(M);
    this.pos.set([p.x, p.y, p.z], i * 3);
    // Direction: emission normal rotated randomly within the spread angles.
    const n = NORMALS[c.dir ?? 1];
    const d = this._d.set(...n);
    const sx = THREE.MathUtils.degToRad(rand(-c.spread[0], c.spread[0]) / 2), sy = THREE.MathUtils.degToRad(rand(-c.spread[1], c.spread[1]) / 2);
    const axisA = Math.abs(n[1]) > 0.5 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const axisB = new THREE.Vector3().crossVectors(d, axisA).normalize();
    d.applyAxisAngle(axisA, sx).applyAxisAngle(axisB, sy).transformDirection(M);
    const sp = range(c.speed, 0);
    this.vel.set([d.x * sp, d.y * sp, d.z * sp], i * 3);
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, range(c.lifetime, 1));
    this.rot[i] = THREE.MathUtils.degToRad(range(c.rotation, 0));
    this.rotV[i] = THREE.MathUtils.degToRad(range(c.rotSpeed, 0));
    this.seed[i] = Math.random();
  }

  update(dt, root, camera, viewportH) {
    const c = this.cfg;
    const M = this.anchorMatrix(root);
    // Stop emitting while the owning part is hidden (e.g. an accessory taken off).
    let shown = true;
    for (let o = this.anchor; o && o !== root; o = o.parent) if (!o.visible) { shown = false; break; }
    if (c.enabled !== false && shown) {
      this.acc += c.rate * dt;
      while (this.acc >= 1) { this.spawn(M); this.acc -= 1; }
    }
    // integrate + compact dead particles
    const drag = Math.exp(-(c.drag || 0) * dt), A = c.accel || [0, 0, 0];
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        const j = --this.n;
        if (i !== j) {
          this.pos.copyWithin(i * 3, j * 3, j * 3 + 3); this.vel.copyWithin(i * 3, j * 3, j * 3 + 3);
          this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.rot[i] = this.rot[j]; this.rotV[i] = this.rotV[j]; this.seed[i] = this.seed[j];
        }
        i--; continue;
      }
      for (let k = 0; k < 3; k++) {
        this.vel[i * 3 + k] = (this.vel[i * 3 + k] + A[k] * dt) * drag;
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      }
      this.rot[i] += this.rotV[i] * dt;
    }
    // write attributes
    const pa = this.aPos.array, sa = this.aSize.array, ca = this.aColor.array, ra = this.aRot.array;
    const b = c.brightness ?? 1;
    for (let i = 0; i < this.n; i++) {
      const t = this.age[i] / this.life[i];
      pa[i * 3] = this.pos[i * 3]; pa[i * 3 + 1] = this.pos[i * 3 + 1]; pa[i * 3 + 2] = this.pos[i * 3 + 2];
      sa[i] = Math.max(0, typeof c.size === "number" ? c.size : seqAt(c.size, t, 1) ?? 1) * (c.sizeScale || 1);
      const col = Array.isArray(c.color?.[0]) ? seqAt(c.color, t, 3) : c.color || [1, 1, 1];
      const tr = typeof c.transparency === "number" ? c.transparency : seqAt(c.transparency, t, 1) ?? 0;
      ca[i * 4] = col[0] * b; ca[i * 4 + 1] = col[1] * b; ca[i * 4 + 2] = col[2] * b;
      ca[i * 4 + 3] = THREE.MathUtils.clamp(1 - tr, 0, 1);
      ra[i] = this.rot[i];
    }
    for (const a of [this.aPos, this.aSize, this.aColor, this.aRot]) a.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.n);
    // pixels per stud at distance 1
    this.material.uniforms.uScale.value = viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  }

  dispose() { this.points.geometry.dispose(); this.material.dispose(); }
}

// ---- Roblox effect classes -> particle configs -----------------------------------------------

function emitterConfig(p, map) {
  const lightEmission = p.LightEmission ?? 0;
  const brightness = THREE.MathUtils.clamp(p.Brightness ?? 1, 0, 3);
  return {
    enabled: p.Enabled !== false,
    rate: Math.min(p.Rate ?? 20, 400),
    lifetime: p.Lifetime || [5, 10],
    speed: p.Speed || [5, 5],
    spread: p.SpreadAngle || [0, 0],
    accel: p.Acceleration || [0, 0, 0],
    drag: p.Drag || 0,
    size: p.Size ?? 1,
    color: p.Color || [1, 1, 1],
    transparency: p.Transparency ?? 0,
    rotation: p.Rotation || [0, 0],
    rotSpeed: p.RotSpeed || [0, 0],
    dir: p.EmissionDirection ?? 1,
    additive: lightEmission >= 0.5,
    brightness: lightEmission >= 0.5 ? Math.max(brightness, 0.6) : Math.min(brightness, 1.2),
    map,
  };
}

function fireConfig(p, partSize) {
  const size = p.size_xml ?? p.Size ?? 5, heat = p.heat_xml ?? p.Heat ?? 9;
  const base = p.Color || [0.93, 0.55, 0.27], secondary = p.SecondaryColor || [0.55, 0.31, 0.22];
  return {
    enabled: p.Enabled !== false,
    rate: 18 + size * 3,
    lifetime: [0.5, 1],
    speed: [Math.max(0.5, heat * 0.16), Math.max(1, heat * 0.24)],
    spread: [20, 20],
    accel: [0, Math.max(heat, 2) * 0.12, 0],
    drag: 0.6,
    size: [[0, size * 0.42, 0], [0.5, size * 0.3, 0], [1, size * 0.05, 0]],
    color: [[0, ...base], [0.55, ...secondary], [1, ...secondary]],
    transparency: [[0, 0.35, 0], [0.6, 0.6, 0], [1, 1, 0]],
    rotation: [0, 360], rotSpeed: [-90, 90],
    dir: 1, additive: true, brightness: 1,
    volume: partSize ? partSize.map((s) => Math.min(s, size * 0.3)) : [0.3, 0.3, 0.3],
  };
}

function smokeConfig(p) {
  const size = p.size_xml ?? p.Size ?? 1, rise = p.riseVelocity_xml ?? p.RiseVelocity ?? 1;
  const op = p.opacity_xml ?? p.Opacity ?? 0.5;
  return {
    enabled: p.Enabled !== false, rate: 12, lifetime: [2.5, 4], speed: [rise * 0.8, rise * 1.2],
    spread: [30, 30], accel: [0, 0, 0], drag: 0.2,
    size: [[0, size, 0], [1, size * 3, 0]], color: p.Color || [0.5, 0.5, 0.5],
    transparency: [[0, 1 - op, 0], [1, 1, 0]], rotation: [0, 360], rotSpeed: [-20, 20],
    dir: 1, additive: false, brightness: 1, volume: [0.4, 0.2, 0.4],
  };
}

function sparklesConfig(p) {
  return {
    enabled: p.Enabled !== false, rate: 25, lifetime: [0.8, 1.4], speed: [1.5, 3], spread: [360, 360],
    accel: [0, 0, 0], drag: 1.5, size: [[0, 0.5, 0], [1, 0.1, 0]], color: p.SparkleColor || [0.56, 0.36, 0.95],
    transparency: [[0, 0, 0], [1, 1, 0]], rotation: [0, 360], rotSpeed: [-180, 180],
    dir: 1, additive: true, brightness: 1.2, volume: [0.8, 0.8, 0.8], map: sparkleTexture(),
  };
}

// Build effect objects for a part node's descendants (direct children + under Attachments).
// partObj: the rendered part (effects inherit its transform). loadImg(id) -> Promise<HTMLImageElement>.
export async function buildEffects(node, partObj, loadImg, assetIdOf) {
  const out = [];
  const partSize = node.props.size || node.props.Size;
  const visit = async (n, anchor) => {
    for (const c of n.children) {
      let target = anchor;
      if (c.className === "Attachment") {
        target = new THREE.Object3D();
        const cf = c.props.CFrame;
        if (cf) target.matrix.set(cf[3], cf[4], cf[5], cf[0], cf[6], cf[7], cf[8], cf[1], cf[9], cf[10], cf[11], cf[2], 0, 0, 0, 1);
        target.matrixAutoUpdate = false;
        anchor.add(target);
        await visit(c, target);
        continue;
      }
      const p = c.props;
      if (c.className === "ParticleEmitter") {
        let map = null;
        const id = assetIdOf(p.Texture);
        if (id) {
          try { const img = await loadImg(id); map = new THREE.Texture(img); map.needsUpdate = true; } catch { /* default sprite */ }
        }
        const cfg = emitterConfig(p, map);
        if (anchor === partObj && partSize && (p.ShapeStyle ?? 0) === 0) cfg.volume = partSize;
        out.push(new Particles(anchor, cfg));
      } else if (c.className === "Fire") {
        out.push(new Particles(anchor, fireConfig(p, anchor === partObj ? null : null)));
      } else if (c.className === "Smoke") {
        out.push(new Particles(anchor, smokeConfig(p)));
      } else if (c.className === "Sparkles") {
        out.push(new Particles(anchor, sparklesConfig(p)));
      } else if (/^(PointLight|SpotLight|SurfaceLight)$/.test(c.className) && p.Enabled !== false) {
        const col = p.Color || [1, 1, 1];
        const light = new THREE.PointLight(new THREE.Color().setRGB(...col, THREE.SRGBColorSpace),
          THREE.MathUtils.clamp(p.Brightness ?? 1, 0, 6) * 1.2, Math.min(p.Range ?? 8, 30), 1);
        anchor.add(light);
      }
    }
  };
  await visit(node, partObj);
  return out;
}

// Driver attached to the model root: updates every particle system each frame.
export function effectsTicker(root, systems) {
  for (const s of systems) root.add(s.points);
  return (dt, camera, viewportH) => {
    for (const s of systems) s.update(Math.min(dt, 0.1), root, camera, viewportH);
  };
}
