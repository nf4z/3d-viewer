// Roblox KeyframeSequence animations: parse, resolve animation packs, sample per joint.
import * as THREE from "three";

// Roblox's default R15 animations (from the default Animate script).
export const DEFAULT_ANIMS = {
  idle: "507766666", walk: "507777826", run: "507767714", jump: "507765000",
  fall: "507767968", climb: "507765644", swim: "913384386",
};
// Avatar asset types for animation packs.
export const ANIM_TYPES = { 48: "climb", 50: "fall", 51: "idle", 52: "jump", 53: "run", 54: "swim", 55: "walk" };
// StringValue names inside packs that map to each slot.
const SLOT_NAMES = { idle: ["idle"], walk: ["walk"], run: ["run"], jump: ["jump"], fall: ["fall"], climb: ["climb"], swim: ["swim", "swimidle"] };

function findAll(nodes, pred, out = []) {
  for (const n of nodes) { if (pred(n)) out.push(n); findAll(n.children, pred, out); }
  return out;
}

// ---- easing (Roblox PoseEasingStyle / PoseEasingDirection) -----------------------------

function ease(style, dir, t) {
  const base = {
    0: (x) => x,                         // Linear
    1: () => 0,                          // Constant (hold previous pose)
    3: (x) => x * x * x,                 // Cubic (In)
    5: (x) => x * x * x,                 // CubicV2
    2: (x) => (x === 0 || x === 1 ? x : -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * (2 * Math.PI) / 3)), // Elastic In
    4: (x) => 1 - bounceOut(1 - x),      // Bounce In
  }[style ?? 0] || ((x) => x);
  if (style === 1) return 0;
  // Roblox's legacy pose directions are inverted relative to TweenService: 0 = In -> behaves as Out.
  switch (dir ?? 0) {
    case 0: return 1 - base(1 - t);      // Out
    case 1: return base(t);              // In
    default: return t < 0.5 ? base(t * 2) / 2 : 1 - base((1 - t) * 2) / 2; // InOut
  }
}
function bounceOut(x) {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
}

// ---- parsing ---------------------------------------------------------------------------

// KeyframeSequence tree -> { length, loop, tracks: { partName: [{ t, pos, quat, style, dir }] } }
export function parseKeyframeSequence(seq) {
  const tracks = {};
  let length = 0;
  for (const kf of seq.children.filter((c) => c.className === "Keyframe")) {
    const t = kf.props.Time || 0;
    length = Math.max(length, t);
    const walk = (pose) => {
      for (const c of pose.children) {
        if (c.className !== "Pose") continue;
        const w = c.props.Weight ?? 1;
        if (w > 0 && c.props.CFrame) {
          const [x, y, z, a, b, cc, d, e, f, g, h, i] = c.props.CFrame;
          const m = new THREE.Matrix4().set(a, b, cc, x, d, e, f, y, g, h, i, z, 0, 0, 0, 1);
          const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
          m.decompose(pos, quat, new THREE.Vector3());
          (tracks[c.name] ||= []).push({ t, pos, quat, style: c.props.EasingStyle, dir: c.props.EasingDirection });
        }
        walk(c);
      }
    };
    walk(kf);
  }
  for (const k of Object.values(tracks)) k.sort((a, b) => a.t - b.t);
  return { length, loop: seq.props.Loop !== false, tracks };
}

// Sample a track at time t -> Matrix4 (joint Transform)
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _one = new THREE.Vector3(1, 1, 1);
export function sampleTrack(track, t, out = new THREE.Matrix4()) {
  if (!track.length) return out.identity();
  if (t <= track[0].t) return out.compose(track[0].pos, track[0].quat, _one);
  const last = track[track.length - 1];
  if (t >= last.t) return out.compose(last.pos, last.quat, _one);
  let i = 0;
  while (track[i + 1].t < t) i++;
  const a = track[i], b = track[i + 1];
  const f = ease(a.style, a.dir, (t - a.t) / Math.max(b.t - a.t, 1e-6));
  _p.lerpVectors(a.pos, b.pos, f);
  _q.slerpQuaternions(a.quat, b.quat, f);
  return out.compose(_p, _q, _one);
}

// ---- resolution --------------------------------------------------------------------------

// Resolve an asset (pack, Animation, or KeyframeSequence) to a parsed clip.
// loadModel(id) -> { kind, tree }. slot picks the entry inside a pack.
export async function resolveClip(id, loadModel, slot, depth = 0) {
  if (depth > 3) throw new Error("animation reference loop");
  const model = await loadModel(String(id));
  if (!model.tree) throw new Error("not an animation");
  const seq = findAll(model.tree, (n) => n.className === "KeyframeSequence")[0];
  if (seq) return parseKeyframeSequence(seq);
  if (findAll(model.tree, (n) => n.className === "CurveAnimation")[0]) throw new Error("uses the newer CurveAnimation format (not supported yet)");

  // Pack: Folder > StringValue(slot) > Animation(AnimationId)
  let anims = [];
  if (slot) {
    const names = SLOT_NAMES[slot] || [slot];
    const holder = findAll(model.tree, (n) => n.className === "StringValue" && names.includes(n.name.toLowerCase()))[0];
    if (holder) anims = findAll([holder], (n) => n.className === "Animation");
  }
  if (!anims.length) anims = findAll(model.tree, (n) => n.className === "Animation");
  for (const a of anims) {
    const m = String(a.props.AnimationId || "").match(/(\d+)\s*$/);
    if (!m) continue;
    try { return await resolveClip(m[1], loadModel, slot, depth + 1); } catch (e) { if (a === anims[anims.length - 1]) throw e; }
  }
  throw new Error("no playable animation found");
}

// ---- player ----------------------------------------------------------------------------

export class AnimationPlayer {
  constructor(rig) { this.rig = rig; this.clip = null; this.time = 0; this._m = new THREE.Matrix4(); }
  play(clip) { this.clip = clip; this.time = 0; }
  stop() { this.clip = null; this.rig.pose({}); }
  update(dt) {
    if (!this.clip) return;
    const c = this.clip;
    this.time += dt;
    let t = this.time;
    if (c.length > 0) t = c.loop ? t % c.length : Math.min(t, c.length);
    if (!c.loop && this.time > c.length + 0.6) this.time = 0; // replay one-shots (jump) after a pause
    const transforms = {};
    for (const [name, track] of Object.entries(c.tracks)) transforms[name] = sampleTrack(track, t, new THREE.Matrix4());
    this.rig.pose(transforms);
  }
}
