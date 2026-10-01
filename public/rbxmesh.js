// Roblox .mesh parser (versions 1.00 - 7.00) -> THREE.BufferGeometry.
// UVs are flipped to Three's bottom-left origin.
import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

let draco = null;
function dracoLoader() {
  if (!draco) {
    draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  }
  return draco;
}

function buildGeometry(pos, nrm, uv, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  if (nrm) g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  if (uv) g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (index) g.setIndex(new THREE.BufferAttribute(index, 1));
  if (!nrm) g.computeVertexNormals();
  return g;
}

// Vertices: position(12) normal(12) uv(8) [tangent(4) color(4)] - stride from header.
function readVertices(dv, off, n, stride) {
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++, off += stride) {
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = dv.getFloat32(off + k * 4, true);
      nrm[i * 3 + k] = dv.getFloat32(off + 12 + k * 4, true);
    }
    uv[i * 2] = dv.getFloat32(off + 24, true);
    uv[i * 2 + 1] = 1 - dv.getFloat32(off + 28, true);
  }
  return { pos, nrm, uv };
}

function readFaces(dv, off, n, stride, lods) {
  let start = 0, end = n;
  if (lods && lods.length >= 2 && lods[1] > lods[0] && lods[1] <= n) { start = lods[0]; end = lods[1]; }
  const idx = new Uint32Array((end - start) * 3);
  for (let f = start, j = 0; f < end; f++) {
    const o = off + f * stride;
    idx[j++] = dv.getUint32(o, true); idx[j++] = dv.getUint32(o + 4, true); idx[j++] = dv.getUint32(o + 8, true);
  }
  return idx;
}

function parseV1(text) {
  const lines = text.split(/\r?\n/);
  const scale = lines[0].trim() === "version 1.00" ? 0.5 : 1;
  const nums = (lines[2] || "").match(/-?[\d.]+(?:e[-+]?\d+)?/gi)?.map(Number) || [];
  const verts = Math.floor(nums.length / 9);
  const pos = new Float32Array(verts * 3), nrm = new Float32Array(verts * 3), uv = new Float32Array(verts * 2);
  for (let i = 0; i < verts; i++) {
    const b = i * 9;
    pos.set([nums[b] * scale, nums[b + 1] * scale, nums[b + 2] * scale], i * 3);
    nrm.set([nums[b + 3], nums[b + 4], nums[b + 5]], i * 3);
    uv.set([nums[b + 6], 1 - nums[b + 7]], i * 2);
  }
  return buildGeometry(pos, nrm, uv, null);
}

function parseChunked(buf, dv, off) {
  let core = null, lods = null;
  while (off + 16 <= buf.byteLength) {
    const type = new TextDecoder().decode(new Uint8Array(buf, off, 8));
    const ver = dv.getUint32(off + 8, true), size = dv.getUint32(off + 12, true);
    const d = off + 16;
    if (type === "COREMESH") core = { ver, d, size };
    else if (type === "LODS\0\0\0\0" && ver === 1) {
      const n = dv.getUint32(d + 3, true);
      lods = []; for (let i = 0; i < n; i++) lods.push(dv.getUint32(d + 7 + i * 4, true));
    }
    off = d + size;
  }
  if (!core) throw new Error("mesh has no COREMESH chunk");

  if (core.ver === 1) {
    const nv = dv.getUint32(core.d, true);
    const v = readVertices(dv, core.d + 4, nv, 40);
    const fo = core.d + 4 + nv * 40;
    const nf = dv.getUint32(fo, true);
    return Promise.resolve(buildGeometry(v.pos, v.nrm, v.uv, readFaces(dv, fo + 4, nf, 12, lods)));
  }
  // COREMESH v2: u32 length + Draco bitstream
  const len = dv.getUint32(core.d, true);
  const bytes = buf.slice(core.d + 4, core.d + 4 + len);
  return new Promise((resolve, reject) => {
    dracoLoader().parse(bytes, (g) => {
      const uv = g.getAttribute("uv");
      if (uv) for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      if (!g.getAttribute("normal")) g.computeVertexNormals();
      resolve(g);
    }, reject);
  });
}

export async function parseMesh(buf) {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)));
  const m = head.match(/^version (\d)\.(\d\d)/);
  if (!m) throw new Error("not a Roblox mesh");
  const major = Number(m[1]);
  const dv = new DataView(buf);
  let off = new Uint8Array(buf).indexOf(10) + 1; // after "version x.xx\n"

  if (major === 1) return parseV1(new TextDecoder().decode(buf));
  if (major >= 6) return parseChunked(buf, dv, off);

  if (major === 2 || major === 3) {
    const hsize = dv.getUint16(off, true);
    const vstride = dv.getUint8(off + 2), fstride = dv.getUint8(off + 3);
    let nv, nf, nl = 0;
    if (major === 2) { nv = dv.getUint32(off + 4, true); nf = dv.getUint32(off + 8, true); }
    else { nl = dv.getUint16(off + 6, true); nv = dv.getUint32(off + 8, true); nf = dv.getUint32(off + 12, true); }
    off += hsize;
    const v = readVertices(dv, off, nv, vstride);
    off += nv * vstride;
    const fOff = off;
    off += nf * fstride;
    const lods = []; for (let i = 0; i < nl; i++) lods.push(dv.getUint32(off + i * 4, true));
    return buildGeometry(v.pos, v.nrm, v.uv, readFaces(dv, fOff, nf, fstride, lods));
  }

  // v4 / v5
  const hsize = dv.getUint16(off, true);
  const nv = dv.getUint32(off + 4, true), nf = dv.getUint32(off + 8, true);
  const nl = dv.getUint16(off + 12, true), nb = dv.getUint16(off + 14, true);
  off += hsize;
  const v = readVertices(dv, off, nv, 40);
  off += nv * 40;
  if (nb > 0) off += nv * 8; // skinning envelopes
  const fOff = off;
  off += nf * 12;
  const lods = []; for (let i = 0; i < nl; i++) lods.push(dv.getUint32(off + i * 4, true));
  return buildGeometry(v.pos, v.nrm, v.uv, readFaces(dv, fOff, nf, 12, lods));
}
