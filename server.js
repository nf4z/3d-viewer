// Roblox 3D Viewer - zero-dependency Node server (Node 18+).
// Proxies Roblox APIs + CDN (they don't send CORS headers) and injects the
// Open Cloud API key required by the 3D thumbnail endpoints since March 2026.

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { parseModel, detectKind } = require("./lib/rbxm");

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT) || 3000;
const ENV_API_KEY = process.env.ROBLOX_API_KEY || "";
// Optional: .ROBLOSECURITY cookie of a (preferably throwaway) account. Grants full
// account access - keep it only in .env on your own machine.
const ENV_COOKIE = (process.env.ROBLOX_COOKIE || "").replace(/^\.ROBLOSECURITY=/, "");
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Small in-memory cache for immutable CDN blobs (obj/mtl/png by content hash).
const cdnCache = new Map();
const CDN_CACHE_MAX = 300;

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// API key: server .env first, then the browser's key (header, or cookie for <img> requests).
function requestKey(req) {
  if (ENV_API_KEY) return ENV_API_KEY;
  if (req.headers["x-roblox-api-key"]) return String(req.headers["x-roblox-api-key"]);
  const m = (req.headers.cookie || "").match(/(?:^|;s*)rbxkey=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function fetchJson(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", "User-Agent": "roblox-3d-viewer/1.0", ...(init.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  return { ok: r.ok, status: r.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- ID / input resolution -------------------------------------------------

async function lookupUser(id) {
  const { ok, body } = await fetchJson(`https://users.roblox.com/v1/users/${id}`);
  if (!ok || !body || !body.id) return null;
  return { id: body.id, name: body.name, displayName: body.displayName, isBanned: body.isBanned };
}

async function lookupUsername(username) {
  const { ok, body } = await fetchJson("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  const u = ok && body && body.data && body.data[0];
  return u ? { id: u.id, name: u.name, displayName: u.displayName } : null;
}

async function lookupAsset(id) {
  const { ok, body } = await fetchJson(`https://economy.roblox.com/v2/assets/${id}/details`);
  if (!ok || !body || !body.AssetId) return null;
  return {
    id: body.AssetId,
    name: body.Name,
    assetTypeId: body.AssetTypeId,
    assetType: ASSET_TYPES[body.AssetTypeId] || `Type ${body.AssetTypeId}`,
    creator: body.Creator && body.Creator.Name,
  };
}

// Asset types that have meaningful 3D renders.
const ASSET_TYPES = {
  1: "Image", 2: "T-Shirt", 3: "Audio", 4: "Mesh", 8: "Hat", 10: "Model", 11: "Shirt", 12: "Pants",
  13: "Decal", 17: "Head", 18: "Face", 19: "Gear", 24: "Animation", 27: "Torso", 28: "Right Arm",
  29: "Left Arm", 30: "Left Leg", 31: "Right Leg", 38: "Plugin", 40: "MeshPart", 41: "Hair Accessory",
  42: "Face Accessory", 43: "Neck Accessory", 44: "Shoulder Accessory", 45: "Front Accessory",
  46: "Back Accessory", 47: "Waist Accessory", 48: "Climb Animation", 61: "Emote Animation",
  62: "Video", 64: "T-Shirt Accessory", 65: "Shirt Accessory", 66: "Pants Accessory",
  67: "Jacket Accessory", 68: "Sweater Accessory", 69: "Shorts Accessory", 70: "Left Shoe Accessory",
  71: "Right Shoe Accessory", 72: "Dress Skirt Accessory", 76: "Eyebrow Accessory",
  77: "Eyelash Accessory", 78: "Mood Animation", 79: "Dynamic Head",
  49: "Death Animation", 50: "Fall Animation", 51: "Idle Animation", 52: "Jump Animation", 53: "Run Animation",
  54: "Swim Animation", 55: "Walk Animation", 56: "Pose Animation", 57: "Ear Accessory", 58: "Eye Accessory",
  32: "Package", 39: "Solid Model",
};
const RENDERABLE = new Set([24, 48, 50, 51, 52, 53, 54, 55, 61, 4, 8, 10, 17, 19, 27, 28, 29, 30, 31, 40, 41, 42, 43, 44, 45, 46, 47,
  64, 65, 66, 67, 68, 69, 70, 71, 72, 76, 77, 79]);

// Accepts: numeric ID, profile URL, catalog/library URL, or a username.
function parseInput(raw) {
  const q = String(raw || "").trim();
  let m;
  if ((m = q.match(/roblox\.com\/users\/(\d+)/i))) return { hint: "user", id: m[1] };
  if ((m = q.match(/roblox\.com\/(?:catalog|library|marketplace\/asset)\/(\d+)/i))) return { hint: "asset", id: m[1] };
  if ((m = q.match(/[?&](?:assetId|id)=(\d+)/i))) return { hint: "asset", id: m[1] };
  if (/^\d{1,19}$/.test(q)) return { hint: null, id: q };
  if (/^[A-Za-z0-9_]{3,20}$/.test(q)) return { hint: "username", username: q };
  return null;
}

async function resolve(raw) {
  const parsed = parseInput(raw);
  if (!parsed) return { error: "Enter a numeric ID, a Roblox profile/catalog URL, or a username." };

  if (parsed.hint === "username") {
    const user = await lookupUsername(parsed.username);
    if (!user) return { error: `No user named "${parsed.username}".` };
    return { user, asset: null, pick: "user" };
  }

  const [user, asset] = await Promise.all([
    parsed.hint === "asset" ? null : lookupUser(parsed.id).catch(() => null),
    parsed.hint === "user" ? null : lookupAsset(parsed.id).catch(() => null),
  ]);
  if (asset) asset.renderable = RENDERABLE.has(asset.assetTypeId);
  if (!user && !asset) return { error: `ID ${parsed.id} is not a valid user or asset.` };

  // IDs overlap between users and assets. Prefer the URL hint, then a
  // 3D-renderable asset, otherwise the user. The UI lets you switch.
  let pick;
  if (parsed.hint) pick = parsed.hint;
  else if (user && asset) pick = asset.renderable ? "asset" : "user";
  else pick = user ? "user" : "asset";
  return { user, asset, pick };
}

// ---- 3D thumbnails --------------------------------------------------------

async function get3d(type, id, apiKey) {
  const authHeaders = apiKey ? { "x-api-key": apiKey } : ENV_COOKIE ? { Cookie: `.ROBLOSECURITY=${ENV_COOKIE}` } : null;
  if (!authHeaders) {
    return { status: 401, body: { error: "NO_API_KEY", message: "Roblox requires an Open Cloud API key (thumbnails:read) for 3D thumbnails." } };
  }
  const url = type === "user"
    ? `https://thumbnails.roblox.com/v1/users/avatar-3d?userId=${id}`
    : `https://thumbnails.roblox.com/v1/assets-thumbnail-3d?assetId=${id}`;

  // Renders are generated on demand; poll while "Pending".
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = await fetchJson(url, { headers: authHeaders });
    if (r.status === 401 || r.status === 403) {
      return { status: 401, body: { error: "BAD_API_KEY", message: apiKey ? "Roblox rejected the API key. Make sure it has the thumbnails → read permission and allows this IP." : "Roblox rejected ROBLOX_COOKIE (expired or invalid).", detail: r.body } };
    }
    if (!r.ok) return { status: 502, body: { error: "ROBLOX_ERROR", message: `Roblox returned HTTP ${r.status}`, detail: r.body } };

    const state = r.body && r.body.state;
    if (state === "Completed" && r.body.imageUrl) {
      const meta = await fetchJson(r.body.imageUrl);
      if (!meta.ok || !meta.body) return { status: 502, body: { error: "META_FAILED", message: "Could not download 3D metadata from the CDN." } };
      return { status: 200, body: { type, id: Number(id), ...meta.body } };
    }
    if (state && state !== "Pending") {
      return { status: 404, body: { error: state.toUpperCase(), message: `Roblox has no 3D render for this ${type} (state: ${state}).` } };
    }
    await sleep(Math.min(1000 + attempt * 500, 3000));
  }
  return { status: 504, body: { error: "PENDING", message: "Roblox is still generating the 3D render. Try again in a few seconds." } };
}

async function get2d(type, id, headshot) {
  const url = type === "user"
    ? headshot
      ? `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png`
      : `https://thumbnails.roblox.com/v1/users/avatar?userIds=${id}&size=420x420&format=Png`
    : `https://thumbnails.roblox.com/v1/assets?assetIds=${id}&size=420x420&format=Png`;
  const r = await fetchJson(url);
  const d = r.body && r.body.data && r.body.data[0];
  return d && d.imageUrl ? { imageUrl: d.imageUrl, state: d.state } : { imageUrl: null, state: d ? d.state : "Error" };
}

// ---- CDN proxy -----------------------------------------------------------------

// Legacy hashes live on t0..t7.rbxcdn.com, selected by XOR of the hash chars.
function legacyCdnHost(hash) {
  let i = 31;
  for (let t = 0; t < 32 && t < hash.length; t++) i ^= hash.charCodeAt(t);
  return `https://t${i % 8}.rbxcdn.com/${hash}`;
}

async function fetchCdn(hash) {
  if (cdnCache.has(hash)) return cdnCache.get(hash);
  const candidates = [`https://tr.rbxcdn.com/${hash}`, legacyCdnHost(hash)];
  for (let n = 0; n < 8; n++) candidates.push(`https://t${n}.rbxcdn.com/${hash}`);
  for (const url of [...new Set(candidates)]) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "roblox-3d-viewer/1.0" } });
      if (!r.ok) continue;
      const entry = { type: r.headers.get("content-type") || "application/octet-stream", data: Buffer.from(await r.arrayBuffer()) };
      if (cdnCache.size >= CDN_CACHE_MAX) cdnCache.delete(cdnCache.keys().next().value);
      cdnCache.set(hash, entry);
      return entry;
    } catch { /* try next host */ }
  }
  return null;
}

// ---- Raw assets (no-auth fallback) ----------------------------------------------
// assetdelivery v2 still returns signed download URLs for public assets without
// login, so we can download item files (models, meshes, textures) directly and
// reconstruct the 3D model in the browser.

const assetCache = new Map();
const ASSET_CACHE_MAX = 400;
const assetInflight = new Map();

// Signed download URL for an asset. Tries, in order:
//  1. public assetdelivery (no auth; most older items)
//  2. Open Cloud Asset Delivery with an API key (legacy-asset:manage scope; protected items)
//  3. assetdelivery with the .ROBLOSECURITY cookie
async function assetLocation(id, apiKey) {
  const first = (r) => r.body && r.body.locations && r.body.locations[0] && r.body.locations[0].location
    || r.body && r.body.location;
  const errOf = (r) => r.body && r.body.errors && r.body.errors[0] && r.body.errors[0].message;

  const pub = await fetchJson(`https://assetdelivery.roblox.com/v2/assetId/${id}`);
  if (first(pub)) return first(pub);
  const pubErr = errOf(pub) || `HTTP ${pub.status}`;
  let lastErr = /authentication required/i.test(pubErr)
    ? "Protected item: needs an API key with the legacy-asset permission"
    : pubErr;
  const trail = [`public: ${pubErr}`];

  if (apiKey) {
    const oc = await fetchJson(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}`, { headers: { "x-api-key": apiKey } });
    if (first(oc)) { console.log(`[asset ${id}] downloaded via Open Cloud API key`); return first(oc); }
    trail.push(`open cloud: HTTP ${oc.status} ${errOf(oc) || ""}`.trim());
    if (oc.status === 401 || oc.status === 403) lastErr = "Your API key is missing the legacy-asset permission (or its IP allow-list blocks this server)";
    else lastErr = errOf(oc) || lastErr;
  }
  if (ENV_COOKIE) {
    const ck = await fetchJson(`https://assetdelivery.roblox.com/v2/assetId/${id}`, { headers: { Cookie: `.ROBLOSECURITY=${ENV_COOKIE}` } });
    if (first(ck)) return first(ck);
    trail.push(`cookie: ${errOf(ck) || `HTTP ${ck.status}`}`);
    lastErr = errOf(ck) || lastErr;
  }
  console.log(`[asset ${id}] unavailable (${apiKey ? "key sent" : "no key"}) -> ${trail.join(" | ")}`);
  throw Object.assign(new Error(lastErr), { status: 404 });
}

async function fetchAssetBytes(id, apiKey) {
  if (assetCache.has(id)) return assetCache.get(id);
  if (assetInflight.has(id)) return assetInflight.get(id);
  const p = (async () => {
    const loc = await assetLocation(id, apiKey);
    const r = await fetch(loc, { headers: { "User-Agent": "roblox-3d-viewer/1.0" } });
    if (!r.ok) throw Object.assign(new Error(`Asset CDN returned HTTP ${r.status}`), { status: 502 });
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    if (assetCache.size >= ASSET_CACHE_MAX) assetCache.delete(assetCache.keys().next().value);
    assetCache.set(id, buf);
    return buf;
  })();
  assetInflight.set(id, p);
  try { return await p; } finally { assetInflight.delete(id); }
}

// Props the browser-side reconstruction needs; everything else is dropped.
const KEEP_PROPS = new Set([
  "CFrame", "size", "Size", "InitialSize", "shape", "Shape", "Color3uint8", "Color", "BrickColor", "Transparency",
  "MeshId", "MeshContent", "TextureID", "TextureId", "TextureContent", "Scale", "Offset", "VertexColor", "MeshType",
  "ColorMap", "ColorMapContent", "AlphaMode", "AttachmentPoint", "Grip", "Texture", "Face",
  "ShirtTemplate", "PantsTemplate", "Graphic", "Order", "Enabled",
  // animation
  "Time", "Weight", "Loop", "AnimationId", "EasingStyle", "EasingDirection", "Value",
  // effects
  "Rate", "Lifetime", "Speed", "SpreadAngle", "Acceleration", "Drag", "LightEmission", "LightInfluence",
  "EmissionDirection", "Rotation", "RotSpeed", "LockedToPart", "ZOffset", "Orientation", "Squash",
  "Brightness", "Range", "Angle", "SecondaryColor", "SparkleColor", "heat_xml", "size_xml",
  "opacity_xml", "riseVelocity_xml", "TimeScale", "VelocityInheritance", "Shape", "ShapeStyle",
]);
function pruneTree(nodes) {
  return nodes.map((n) => {
    const props = {};
    for (const k in n.props) if (KEEP_PROPS.has(k)) props[k] = n.props[k];
    return { className: n.className, name: n.name, props, children: pruneTree(n.children) };
  });
}

const RAW_TYPES = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mesh: "application/octet-stream" };

// ---- HTTP server --------------------------------------------------------------

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  try {
    if (p === "/api/config") {
      return sendJson(res, 200, { serverHasKey: Boolean(ENV_API_KEY), serverHasCookie: Boolean(ENV_COOKIE) });
    }
    if (p === "/api/resolve") {
      const out = await resolve(url.searchParams.get("q"));
      return sendJson(res, out.error ? 404 : 200, out);
    }
    if (p === "/api/3d" || p === "/api/2d") {
      const type = url.searchParams.get("type");
      const id = url.searchParams.get("id");
      if (!["user", "asset"].includes(type) || !/^\d+$/.test(id || "")) {
        return sendJson(res, 400, { error: "BAD_REQUEST", message: "type must be user|asset and id numeric" });
      }
      if (p === "/api/2d") return sendJson(res, 200, await get2d(type, id, url.searchParams.has("headshot")));
      const out = await get3d(type, id, requestKey(req));
      return sendJson(res, out.status, out.body);
    }
    let m;
    if ((m = p.match(/^\/api\/model\/(\d+)$/))) {
      const buf = await fetchAssetBytes(m[1], requestKey(req));
      const kind = detectKind(buf);
      if (kind !== "rbxm" && kind !== "rbxmx") return sendJson(res, 200, { kind });
      return sendJson(res, 200, { kind: "model", tree: pruneTree(parseModel(buf)) });
    }
    if ((m = p.match(/^\/api\/raw\/(\d+)$/))) {
      const buf = await fetchAssetBytes(m[1], requestKey(req));
      const kind = detectKind(buf);
      res.writeHead(200, { "Content-Type": RAW_TYPES[kind] || "application/octet-stream", "X-Asset-Kind": kind, "Cache-Control": "public, max-age=3600" });
      return res.end(buf);
    }
    if ((m = p.match(/^\/api\/avatar\/(\d+)$/))) {
      const r = await fetchJson(`https://avatar.roblox.com/v2/avatar/users/${m[1]}/avatar`);
      return sendJson(res, r.ok ? 200 : 502, r.body || { error: "AVATAR_FAILED" });
    }
    if (p.startsWith("/cdn/")) {
      const hash = p.slice(5);
      if (!/^[A-Za-z0-9_\-]{16,128}$/.test(hash)) { res.writeHead(400); return res.end(); }
      const entry = await fetchCdn(hash);
      if (!entry) { res.writeHead(404); return res.end("CDN miss"); }
      res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "public, max-age=86400" });
      return res.end(entry.data);
    }
    return serveStatic(req, res, p);
  } catch (err) {
    if (!err.status) console.error(err);
    return sendJson(res, err.status || 500, { error: "SERVER_ERROR", message: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Roblox 3D Viewer running at http://localhost:${PORT}`);
  console.log(ENV_API_KEY ? "Auth: ROBLOX_API_KEY" : ENV_COOKIE ? "Auth: ROBLOX_COOKIE" : "Auth: none - using no-auth reconstruction (or paste an API key in the UI).");
});
