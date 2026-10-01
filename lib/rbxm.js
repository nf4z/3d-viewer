// Minimal Roblox model parser (binary .rbxm and XML .rbxmx) -> plain instance tree.
// Binary format reference: https://dom.rojo.space/binary.html
// Only property types needed for rendering are decoded; others are skipped.

const zlib = require("zlib");

// ---- helpers ------------------------------------------------------------------

function lz4Block(src, outLen) {
  const dst = Buffer.alloc(outLen);
  let s = 0, d = 0;
  while (s < src.length) {
    const tok = src[s++];
    let lit = tok >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    src.copy(dst, d, s, s + lit); s += lit; d += lit;
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let len = tok & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
    len += 4;
    let m = d - off;
    for (let i = 0; i < len; i++) dst[d++] = dst[m++];
  }
  return dst;
}

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u8() { return this.b[this.o++]; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
  f64() { const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
  bytes(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  string() { return this.bytes(this.u32()).toString("utf8"); }
  // n big-endian u32 values stored byte-interleaved
  interleavedU32(n) {
    const src = this.bytes(n * 4), out = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = ((src[i] << 24) | (src[n + i] << 16) | (src[2 * n + i] << 8) | src[3 * n + i]) >>> 0;
    }
    return out;
  }
  interleavedI32(n) {
    const u = this.interleavedU32(n), out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = (u[i] >>> 1) ^ -(u[i] & 1);
    return out;
  }
  interleavedF32(n) {
    const u = this.interleavedU32(n), out = new Float32Array(n), dv = new DataView(new ArrayBuffer(4));
    for (let i = 0; i < n; i++) {
      dv.setUint32(0, ((u[i] >>> 1) | (u[i] << 31)) >>> 0);
      out[i] = dv.getFloat32(0);
    }
    return out;
  }
  referents(n) {
    const v = this.interleavedI32(n);
    for (let i = 1; i < n; i++) v[i] += v[i - 1];
    return v;
  }
}

// Special CFrame rotation IDs: id-1 = 6*rightNormal + upNormal (NormalId order +X,+Y,+Z,-X,-Y,-Z).
const NORMALS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
function specialRotation(id) {
  const r = NORMALS[Math.floor((id - 1) / 6)], u = NORMALS[(id - 1) % 6];
  const b = [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]];
  // Row-major matrix whose columns are right, up, back.
  return [r[0], u[0], b[0], r[1], u[1], b[1], r[2], u[2], b[2]];
}

function readCFrames(r, n) {
  const rots = [];
  for (let i = 0; i < n; i++) {
    const id = r.u8();
    if (id === 0) { const m = []; for (let k = 0; k < 9; k++) m.push(r.f32()); rots.push(m); }
    else rots.push(specialRotation(id));
  }
  const x = r.interleavedF32(n), y = r.interleavedF32(n), z = r.interleavedF32(n);
  // CFrame as [x, y, z, R00..R22] (same order as CFrame:GetComponents()).
  return rots.map((m, i) => [x[i], y[i], z[i], ...m]);
}

function readValues(r, type, n) {
  switch (type) {
    case 0x01: case 0x1d: { const a = []; for (let i = 0; i < n; i++) a.push(r.string()); return a; }
    case 0x02: return Array.from(r.bytes(n), (b) => b !== 0);
    case 0x03: return Array.from(r.interleavedI32(n));
    case 0x04: return Array.from(r.interleavedF32(n));
    case 0x05: { const a = []; for (let i = 0; i < n; i++) a.push(r.f64()); return a; }
    case 0x0b: case 0x12: return Array.from(r.interleavedU32(n));
    case 0x0d: { // Vector2
      const x = r.interleavedF32(n), y = r.interleavedF32(n);
      return Array.from(x, (_, i) => [x[i], y[i]]);
    }
    case 0x15: { // NumberSequence: [[time, value, envelope], ...]
      const a = [];
      for (let i = 0; i < n; i++) { const k = r.u32(), seq = []; for (let j = 0; j < k; j++) seq.push([r.f32(), r.f32(), r.f32()]); a.push(seq); }
      return a;
    }
    case 0x16: { // ColorSequence: [[time, r, g, b], ...]
      const a = [];
      for (let i = 0; i < n; i++) { const k = r.u32(), seq = []; for (let j = 0; j < k; j++) { const t = r.f32(), R = r.f32(), G = r.f32(), B = r.f32(); r.f32(); seq.push([t, R, G, B]); } a.push(seq); }
      return a;
    }
    case 0x17: { const a = []; for (let i = 0; i < n; i++) a.push([r.f32(), r.f32()]); return a; } // NumberRange
    case 0x0c: case 0x0e: {
      const x = r.interleavedF32(n), y = r.interleavedF32(n), z = r.interleavedF32(n);
      return Array.from(x, (_, i) => [x[i], y[i], z[i]]);
    }
    case 0x10: return readCFrames(r, n);
    case 0x13: return Array.from(r.referents(n));
    case 0x1a: {
      const R = r.bytes(n), G = r.bytes(n), B = r.bytes(n);
      return Array.from(R, (_, i) => [R[i] / 255, G[i] / 255, B[i] / 255]);
    }
    case 0x22: { // Content: source types, then URIs, then object refs
      const kinds = r.interleavedI32(n);
      const uris = []; const uc = r.u32(); for (let i = 0; i < uc; i++) uris.push(r.string());
      let ui = 0;
      return Array.from(kinds, (k) => (k === 1 ? uris[ui++] : ""));
    }
    default: return null; // unsupported type: skip
  }
}

// ---- binary ---------------------------------------------------------------------

function parseBinary(buf) {
  const head = new Reader(buf);
  head.o = 16;
  const classCount = head.b.readInt32LE(head.o);
  head.o = 32;

  const classes = new Array(classCount);
  const insts = new Map();

  while (head.o < buf.length) {
    const name = buf.toString("latin1", head.o, head.o + 4).replace(/\0/g, "");
    const clen = buf.readUInt32LE(head.o + 4), ulen = buf.readUInt32LE(head.o + 8);
    head.o += 16;
    let data;
    if (clen === 0) data = head.bytes(ulen);
    else {
      const raw = head.bytes(clen);
      data = raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd
        ? zlib.zstdDecompressSync(raw)
        : lz4Block(raw, ulen);
    }
    if (name === "END") break;
    const r = new Reader(data);

    if (name === "INST") {
      const id = r.u32(), className = r.string(); r.u8();
      const count = r.u32(), refs = r.referents(count);
      classes[id] = { className, refs: Array.from(refs) };
      for (const ref of refs) insts.set(ref, { className, name: className, props: {}, children: [] });
    } else if (name === "PROP") {
      const id = r.u32(), prop = r.string(), type = r.u8();
      const cls = classes[id];
      if (!cls) continue;
      let vals;
      try { vals = readValues(r, type, cls.refs.length); } catch { vals = null; }
      if (!vals) continue;
      cls.refs.forEach((ref, i) => {
        const inst = insts.get(ref);
        if (prop === "Name") inst.name = vals[i];
        else inst.props[prop] = vals[i];
      });
    } else if (name === "PRNT") {
      r.u8();
      const n = r.u32(), child = r.referents(n), parent = r.referents(n);
      for (let i = 0; i < n; i++) insts.get(child[i]).parentRef = parent[i];
    }
  }

  const roots = [];
  for (const inst of insts.values()) {
    const p = inst.parentRef;
    delete inst.parentRef;
    if (p === undefined || p < 0 || !insts.has(p)) roots.push(inst);
    else insts.get(p).children.push(inst);
  }
  return roots;
}

// ---- XML ------------------------------------------------------------------------

function xmlText(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
}

function xmlProp(tag, body) {
  const num = (k) => { const m = body.match(new RegExp(`<${k}>([^<]*)</${k}>`)); return m ? Number(m[1]) : 0; };
  switch (tag) {
    case "string": case "ProtectedString": case "BinaryString": return xmlText(body);
    case "Content": case "ContentId": { const m = body.match(/<url>([\s\S]*?)<\/url>/); return m ? xmlText(m[1]) : xmlText(body.replace(/<[^>]+>/g, "")); }
    case "bool": return xmlText(body) === "true";
    case "int": case "int64": case "float": case "double": case "token": case "BrickColor": return Number(xmlText(body));
    case "Vector3": return [num("X"), num("Y"), num("Z")];
    case "Vector2": return [num("X"), num("Y")];
    case "NumberRange": { const v = xmlText(body).split(/s+/).map(Number); return [v[0] || 0, v[1] ?? v[0] ?? 0]; }
    case "NumberSequence": { const v = xmlText(body).split(/s+/).filter(Boolean).map(Number), out = []; for (let i = 0; i + 2 < v.length; i += 3) out.push([v[i], v[i + 1], v[i + 2]]); return out; }
    case "ColorSequence": { const v = xmlText(body).split(/s+/).filter(Boolean).map(Number), out = []; for (let i = 0; i + 4 < v.length; i += 5) out.push([v[i], v[i + 1], v[i + 2], v[i + 3]]); return out; }
    case "Color3": {
      if (!/<R>/.test(body)) { const v = Number(xmlText(body)); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; }
      return [num("R"), num("G"), num("B")];
    }
    case "Color3uint8": { const v = Number(xmlText(body)); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; }
    case "CoordinateFrame": case "CFrame":
      return ["X", "Y", "Z", "R00", "R01", "R02", "R10", "R11", "R12", "R20", "R21", "R22"].map(num);
    default: return undefined;
  }
}

function parseXml(text) {
  const roots = [], stack = [];
  const re = /<Item\s+class="([^"]+)"[^>]*>|<\/Item>|<Properties>([\s\S]*?)<\/Properties>/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) {
      const inst = { className: m[1], name: m[1], props: {}, children: [] };
      (stack.length ? stack[stack.length - 1].children : roots).push(inst);
      stack.push(inst);
    } else if (m[0] === "</Item>") stack.pop();
    else if (stack.length) {
      const inst = stack[stack.length - 1];
      const pre = /<(\w+)\s+name="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/\1>)/g;
      let p;
      while ((p = pre.exec(m[2]))) {
        const v = xmlProp(p[1], p[3] || "");
        if (v === undefined) continue;
        if (p[2] === "Name") inst.name = v; else inst.props[p[2]] = v;
      }
    }
  }
  return roots;
}

// ---- entry ------------------------------------------------------------------------

function detectKind(buf) {
  const head = buf.subarray(0, 16).toString("latin1");
  if (head.startsWith("<roblox!")) return "rbxm";
  if (head.startsWith("<roblox")) return "rbxmx";
  if (head.startsWith("version ")) return "mesh";
  if (buf[0] === 0x89 && head.startsWith("PNG", 1)) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (head.startsWith("GIF")) return "gif";
  if (head.startsWith("RIFF")) return "webp";
  if (head.startsWith("DDS ")) return "dds";
  if (head.startsWith("KTX")) return "ktx";
  return "unknown";
}

function parseModel(buf) {
  const kind = detectKind(buf);
  if (kind === "rbxm") return parseBinary(buf);
  if (kind === "rbxmx") return parseXml(buf.toString("utf8"));
  throw new Error(`Not a Roblox model file (${kind})`);
}

module.exports = { parseModel, detectKind };
