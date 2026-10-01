# Roblox 3D Viewer

Enter a user ID, asset ID, username, or roblox.com profile/catalog URL and view the 3D model.

## Run

`node server.js` (Node 22.15+ for zstd support, no dependencies) and open http://localhost:3000.
Works with no credentials at all via the reconstruction fallback.

## Features

- **Render modes** (Settings): *Auto* rebuilds from item files and falls back to Roblox's official
  render when items are missing; *Rebuilt* / *Official* force one method.
- **Animations** (running-figure button): idle, walk, run, jump, fall, climb, swim. Uses the
  avatar's equipped animation packs, falling back to Roblox's default R15 set; animation assets
  preview on a default character. Official renders are static, so picking an animation switches
  to the rebuilt rig.
- **Try on**: on any wearable item, "Try on an avatar" puts it on a chosen user
  (`/?user=ID&tryon=ASSET`). The avatar card lists worn items with switches to take them off;
  accessories fade out/in in place, other items rebuild without moving the camera.
- **Search history** in the search bar dropdown; **lock view** button freezes the camera.
- **Effects**: ParticleEmitter, Fire, Smoke, Sparkles and lights from item files. Also overlaid on
  official renders of single items (official 3D thumbnails contain no particles).
- Official renders are shaded like Roblox's own viewer (`Kd` x RGBA vertex colors x `map_Kd`,
  `map_d` ignored, cut-out alpha only for `rbx_alphamode transparent` / vertex alpha).

## Methods (tried in order)

1. **Official 3D thumbnail.** Uses `ROBLOX_API_KEY` (Open Cloud key with thumbnails → read, from
   https://create.roblox.com/dashboard/credentials; note this is an API key, not an OAuth app)
   or `ROBLOX_COOKIE` (`.ROBLOSECURITY` of a throwaway account). Set either in `.env`.
2. **No-auth reconstruction** (automatic when no credentials are set, or force it in the UI).
   Downloads the raw item files from `assetdelivery.roblox.com/v2/assetId/{id}` (still public
   for most assets), parses Roblox model files (binary/XML) and meshes (v1–v7, including Draco),
   then assembles avatars from `avatar.roblox.com/v2/avatar/users/{id}/avatar`: body parts are
   joined via rig attachments, accessories via their attachments, body colors and classic
   shirts/pants/t-shirts are applied, and blocky default parts fill gaps.
   Applies avatar body scales (R15) and per-accessory adjustments from the avatar editor
   (`assets[].meta` position/rotation/scale).
   Limits: Roblox protects many items (most classic clothing, many newer accessories). Those
   need an API key with **legacy-asset → manage**, which the server uses via Open Cloud
   `apis.roblox.com/asset-delivery-api/v1/assetId/{id}` (or `ROBLOX_COOKIE`). Without one they're
   skipped and listed. Layered clothing is shown rigid (not wrapped).

## How it works

- **Detection** (`/api/resolve`): looks the ID up on `users.roblox.com/v1/users/{id}` and
  `economy.roblox.com/v2/assets/{id}/details` in parallel. User and asset IDs overlap, so when
  both exist it picks a 3D-renderable asset first, otherwise the user, and shows both to switch.
- **3D** (`/api/3d`): calls `thumbnails.roblox.com/v1/users/avatar-3d` or
  `/v1/assets-thumbnail-3d` with `x-api-key`, polls while `Pending`, then fetches the metadata
  JSON (`obj`, `mtl`, `textures` hashes, `camera`, `aabb`).
- **CDN** (`/cdn/{hash}`): proxies `tr.rbxcdn.com` / `t0-7.rbxcdn.com` (no CORS) with caching.
- **Rendering**: Three.js `MTLLoader` + `OBJLoader` with orbit controls.
- Without a key, a 2D thumbnail is shown instead.

Deep links: `/?user=156`, `/?asset=1029025`, `/?q=builderman`.
