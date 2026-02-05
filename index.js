import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import fs from 'fs';

const PORT = process.env.PORT || 8080;
const TICK_RATE = 10; // 100ms ticks
const WORLD_W = 384; // tiles (width)
const WORLD_H = 192; // tiles (height)
const VIEW_RADIUS = 12; // tiles around player
const SAVE_PATH = './data/world.json';
const SAVE_INTERVAL_MS = 5000;

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Tile types
const TILE = {
  AIR: 0,
  DIRT: 1,
  STONE: 2,
  ORE: 3,
  TREE: 4,
  GRASS: 5,
  SKY: 6,
};

// Item defs (loaded from defs.json)
const DEF_PATH = './defs.json';
let ITEM_DEFS = {
  items: {
    dirt: { id: 'dirt', tags: ['material'], stack: 999 },
    stone: { id: 'stone', tags: ['material'], stack: 999 },
    ore: { id: 'ore', tags: ['material'], stack: 999 },
    wood: { id: 'wood', tags: ['material'], stack: 999 },
    ration: { id: 'ration', tags: ['food'], heal: 20, stack: 99 },
    sword: { id: 'sword', tags: ['weapon', 'melee'], dmg: 5, cooldown: 700, stack: 1 },
  },
  recipes: {
    ration: { in: { wood: 1, ore: 1 }, out: { ration: 1 } },
  },
};

function loadDefs() {
  try {
    if (fs.existsSync(DEF_PATH)) {
      const raw = fs.readFileSync(DEF_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (data?.items && data?.recipes) ITEM_DEFS = data;
    }
  } catch (e) {
    console.error('Failed to load defs.json:', e);
  }
}

// Item types (non-minecraft clone, minimal)
const ITEM = {
  DIRT: 'dirt',
  STONE: 'stone',
  ORE: 'ore',
  WOOD: 'wood',
  SWORD: 'sword',
  MEAT: 'meat',
};

// Seeded RNG (deterministic world gen)
let worldSeed = process.env.WORLD_SEED || 'moltwars';
let rand = Math.random;
let seedInt = 0;

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setSeed(seed) {
  worldSeed = seed || 'moltwars';
  const h = xmur3(String(worldSeed))();
  seedInt = h;
  rand = mulberry32(h);
}

function hash2(x, y) {
  let h = x * 374761393 + y * 668265263 + seedInt * 374761;
  h = (h ^ (h >> 13)) * 1274126177;
  h ^= h >> 16;
  return (h >>> 0) / 4294967295;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

function noise2(x, y) {
  const x0 = Math.floor(x);
  const x1 = x0 + 1;
  const y0 = Math.floor(y);
  const y1 = y0 + 1;
  const sx = fade(x - x0);
  const sy = fade(y - y0);
  const n00 = hash2(x0, y0);
  const n10 = hash2(x1, y0);
  const n01 = hash2(x0, y1);
  const n11 = hash2(x1, y1);
  const nx0 = lerp(n00, n10, sx);
  const nx1 = lerp(n01, n11, sx);
  return lerp(nx0, nx1, sy);
}

function noise1(x) {
  return noise2(x, 0);
}

// In-memory state (authoritative)
const players = new Map(); // playerId -> {id, name, x, y, hp, apiKey, inv, spawn, active, lastAttack, stats}
const sockets = new Map(); // playerId -> ws
let world = new Uint8Array(WORLD_W * WORLD_H);
let surfaceMap = new Int16Array(WORLD_W);
let villages = []; // [{x,y}]
const chests = new Map(); // key "x,y" -> {items:{[item]:count}}
const animals = new Map(); // id -> {id, type, x, y, hp, vx, vy}
const npcs = new Map(); // id -> {id, name, x, y, hp, inv, vx, vy}
const chatLog = []; // {ts, message}
const CHAT_MAX = 50;

const NPC_CHAT = [
  'Want to trade food for ore?',
  'Anyone up for building a house?',
  'I found a nice cave east of here.',
  'Need wood? I have extra.',
  'Let\'s fortify the surface.',
  'Boars nearby—watch out.',
  'Who wants to craft a sword?',
  'I\'m mining stone, come help.',
  'We should build a bridge.',
  'Anyone seen the ore vein?',
  'Trading meat for stone.',
  'Let\'s expand the base.',
  'I\'ll gather wood if you gather ore.',
  'Surface looks good for a village.',
  'I\'m low on food, anyone trading?',
  'Let\'s dig a staircase down.',
  'Who wants to explore the caves?',
  'I\'ve got extra dirt blocks.',
  'Need help building walls?',
  'Let\'s craft tools and armor.',
];

// Crafting recipes (loaded from defs.json)
const RECIPES = () => ITEM_DEFS.recipes || {};

// Skins (32-char hex ids; viewer resolves CDN URL)
const SKINS = [
  'e3b0c44298fc1c149afbf4c8996fb924',
  'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  'deadbeefcafefeed1234567890abcdef',
  '0123456789abcdef0123456789abcdef',
];

function idx(x, y) {
  return y * WORLD_W + x;
}

function getTile(x, y) {
  if (x < 0 || y < 0 || x >= WORLD_W || y >= WORLD_H) return TILE.AIR;
  return world[idx(x, y)];
}

function isSolid(t) {
  return t !== TILE.AIR && t !== TILE.SKY;
}

function setTile(x, y, t) {
  if (x < 0 || y < 0 || x >= WORLD_W || y >= WORLD_H) return;
  world[idx(x, y)] = t;
}

function genWorld() {
  // noise-based heightmap (higher roughness)
  const minSurface = Math.floor(WORLD_H * 0.10);
  const maxSurface = Math.floor(WORLD_H * 0.35);
  const base = Math.floor(WORLD_H * 0.22);

  for (let x = 0; x < WORLD_W; x++) {
    let h = base;
    let amp = WORLD_H * 0.08;
    let freq = 0.01;
    for (let o = 0; o < 4; o++) {
      const n = noise1(x * freq) * 2 - 1;
      h += n * amp;
      amp *= 0.5;
      freq *= 2;
    }
    h = Math.max(minSurface, Math.min(maxSurface, Math.floor(h)));
    surfaceMap[x] = h;
  }

  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const s = surfaceMap[x];
      if (y < s - 1) {
        setTile(x, y, TILE.SKY);
      } else if (y === s - 1) {
        setTile(x, y, TILE.GRASS);
      } else {
        const dirtDepth = 25;
        if (y < s + dirtDepth) {
          setTile(x, y, TILE.DIRT);
        } else {
          setTile(x, y, hash2(x, y) < 0.18 ? TILE.ORE : TILE.STONE);
        }
      }
    }
  }

  // Caves (wider + larger)
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const s = surfaceMap[x];
      if (y <= s + 2) continue; // keep surface intact
      const n = noise2(x * 0.045, y * 0.045);
      if (n > 0.55) setTile(x, y, TILE.AIR);
    }
  }

  // Trees on surface (spawn on grass)
  for (let x = 0; x < WORLD_W; x++) {
    if (rand() < 0.05) {
      const y = surfaceMap[x] - 1;
      if (getTile(x, y) === TILE.GRASS) {
        setTile(x, y - 1, TILE.TREE);
        setTile(x, y - 2, TILE.TREE);
      }
    }
  }

  genVillages();
  genAnimals();
  genNpcs();
}

function genVillages() {
  villages = [];
  for (let i = 0; i < 6; i++) {
    villages.push({
      x: Math.floor(rand() * WORLD_W),
      y: Math.floor(WORLD_H * 0.25 + rand() * WORLD_H * 0.5),
    });
  }
}

function genAnimals() {
  animals.clear();
  for (let i = 0; i < 40; i++) {
    animals.set(randomUUID(), {
      id: randomUUID(),
      type: 'boar',
      x: Math.floor(rand() * WORLD_W),
      y: Math.floor(WORLD_H * 0.25 + rand() * WORLD_H * 0.5),
      hp: 20,
      vx: 0,
      vy: 0,
    });
  }
}

function genNpcs() {
  npcs.clear();
  const names = [
    'Molty',
    'Claw',
    'Clawer',
    'Clawbot',
    'Moltling',
    'Rune',
    'Ash',
    'Ember',
    'Sable',
    'Nova',
    'Iris',
    'Vex',
  ];
  for (let i = 0; i < 12; i++) {
    const id = randomUUID();
    const base = names[i % names.length];
    const suffix = rand() < 0.4 ? `-${Math.floor(rand() * 90 + 10)}` : '';
    npcs.set(id, {
      id,
      name: `${base}${suffix}`,
      x: Math.floor(rand() * WORLD_W),
      y: Math.floor(WORLD_H * 0.25 + rand() * WORLD_H * 0.5),
      hp: 100,
      inv: {},
      vx: 0,
      vy: 0,
      skin: SKINS[i % SKINS.length],
    });
  }
}

function loadWorld() {
  try {
    const envSeed = process.env.WORLD_SEED || 'moltwars';
    if (fs.existsSync(SAVE_PATH)) {
      const raw = fs.readFileSync(SAVE_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (data?.seed) setSeed(data.seed); else setSeed(envSeed);
      if (data?.players) {
        for (const p of data.players) players.set(p.id, p);
      }
      if (data?.world && data.world.length === WORLD_W * WORLD_H) {
        world = Uint8Array.from(data.world);
      } else {
        genWorld();
      }
      if (data?.villages) villages = data.villages;
      if (data?.chests) {
        for (const [k, v] of Object.entries(data.chests)) chests.set(k, v);
      }
      if (data?.animals) {
        for (const a of data.animals) animals.set(a.id, a);
      }
      if (data?.npcs) {
        for (const n of data.npcs) npcs.set(n.id, n);
      }
    } else {
      setSeed(envSeed);
      genWorld();
    }
  } catch (e) {
    console.error('Failed to load world:', e);
    genWorld();
  }
}

function saveWorld() {
  try {
    const snapshot = {
      players: Array.from(players.values()),
      world: Array.from(world),
      seed: worldSeed,
      villages,
      chests: Object.fromEntries(chests),
      animals: Array.from(animals.values()),
      npcs: Array.from(npcs.values()),
    };
    fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(SAVE_PATH, JSON.stringify(snapshot));
  } catch (e) {
    console.error('Failed to save world:', e);
  }
}

function findSurfaceY(x) {
  const sx = Math.max(0, Math.min(WORLD_W - 1, x));
  const s = surfaceMap[sx];
  if (s && s > 1) return s - 2;
  for (let y = 0; y < WORLD_H - 1; y++) {
    if (isSolid(getTile(sx, y + 1))) return Math.max(0, y - 1);
  }
  return Math.floor(WORLD_H * 0.2);
}

function spawnPlayer(name) {
  const spawnX = Math.floor(rand() * WORLD_W);
  const surfaceY = findSurfaceY(spawnX);
  return {
    id: randomUUID(),
    name,
    x: spawnX,
    y: surfaceY,
    hp: 100,
    apiKey: randomUUID().replace(/-/g, ''),
    inv: {},
    active: null,
    lastAttack: 0,
    stats: {
      kills: 0,
      deaths: 0,
      blocksMined: 0,
      itemsCrafted: 0,
      playtimeMs: 0,
      lastTick: Date.now(),
    },
    spawn: { x: spawnX, y: surfaceY },
    skin: SKINS[Math.floor(rand() * SKINS.length)],
  };
}

function addChat(message) {
  chatLog.push({ ts: Date.now(), message });
  if (chatLog.length > CHAT_MAX) chatLog.shift();
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of sockets.values()) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function broadcastWorld(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of worldSockets) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function getViewport(p) {
  const tiles = [];
  for (let dy = -VIEW_RADIUS; dy <= VIEW_RADIUS; dy++) {
    const row = [];
    for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      row.push(getTile(p.x + dx, p.y + dy));
    }
    tiles.push(row);
  }
  return tiles;
}

function nearbyChests(p) {
  const out = [];
  for (const [k, v] of chests.entries()) {
    const [x, y] = k.split(',').map(Number);
    if (Math.abs(x - p.x) <= VIEW_RADIUS && Math.abs(y - p.y) <= VIEW_RADIUS) {
      out.push({ x, y, items: v.items || {} });
    }
  }
  return out;
}

function nearbyAnimals(p) {
  const out = [];
  for (const a of animals.values()) {
    if (Math.abs(a.x - p.x) <= VIEW_RADIUS && Math.abs(a.y - p.y) <= VIEW_RADIUS) {
      out.push(a);
    }
  }
  return out;
}

function nearbyNpcs(p) {
  const out = [];
  for (const n of npcs.values()) {
    if (Math.abs(n.x - p.x) <= VIEW_RADIUS && Math.abs(n.y - p.y) <= VIEW_RADIUS) {
      out.push(n);
    }
  }
  return out;
}

function applyGravity(entity) {
  const x = Math.floor(entity.x);
  const y = Math.floor(entity.y);
  const below = getTile(x, y + 1);
  if (!isSolid(below) && y + 1 < WORLD_H) {
    entity.y = Math.min(WORLD_H - 1, y + 1);
  }
  // prevent clipping into solids
  const here = getTile(x, Math.floor(entity.y));
  if (isSolid(here)) {
    entity.y = Math.max(0, y - 1);
  }
}

function tryMove(entity, dx, dy) {
  const nx = Math.max(0, Math.min(WORLD_W - 1, entity.x + dx));
  const ny = Math.max(0, Math.min(WORLD_H - 1, entity.y + dy));
  const t = getTile(Math.floor(nx), Math.floor(ny));
  if (!isSolid(t)) {
    entity.x = nx;
    entity.y = ny;
  }
}

function tickAnimals() {
  for (const a of animals.values()) {
    // random wander (horizontal mostly)
    if (rand() < 0.3) {
      a.vx = Math.floor(rand() * 3) - 1;
      a.vy = 0;
    }
    tryMove(a, a.vx * 0.5, a.vy * 0.0);
    applyGravity(a);
  }
}

function tickNpcs() {
  for (const n of npcs.values()) {
    if (rand() < 0.1) {
      n.vx = Math.floor(rand() * 3) - 1;
      n.vy = 0;
    }
    tryMove(n, n.vx * 0.2, 0);
    applyGravity(n);

    // Mine nearby block (slower)
    if (rand() < 0.008) {
      const tx = Math.floor(n.x + (rand() * 3 - 1));
      const ty = Math.floor(n.y + (rand() * 3 - 1));
      const t = getTile(tx, ty);
      if (t !== TILE.AIR && t !== TILE.SKY) {
        setTile(tx, ty, TILE.AIR);
        const item = t === TILE.TREE ? ITEM.WOOD : t === TILE.ORE ? ITEM.ORE : t === TILE.STONE ? ITEM.STONE : ITEM.DIRT;
        n.inv[item] = (n.inv[item] || 0) + 1;
      }
    }

    // Build occasionally if has materials (slower)
    if (rand() < 0.005) {
      const buildTile = [TILE.DIRT, TILE.STONE, TILE.TREE][Math.floor(rand() * 3)];
      const map = {
        [TILE.DIRT]: ITEM.DIRT,
        [TILE.STONE]: ITEM.STONE,
        [TILE.TREE]: ITEM.WOOD,
      };
      const item = map[buildTile];
      const tx = Math.floor(n.x + (rand() * 3 - 1));
      const ty = Math.floor(n.y + (rand() * 3 - 1));
      if (getTile(tx, ty) === TILE.AIR && item && (n.inv[item] || 0) > 0) {
        setTile(tx, ty, buildTile);
        n.inv[item] -= 1;
      }
    }
  }
}

// REST: join (unique usernames)
app.post('/join', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  for (const p of players.values()) {
    if (p.name.toLowerCase() === String(name).toLowerCase()) {
      return res.status(409).json({ ok: false, error: 'name taken' });
    }
  }
  const player = spawnPlayer(name);
  players.set(player.id, player);
  const joinMsg = `${player.name} joined the world`;
  addChat(joinMsg);
  broadcast({ type: 'chat', message: joinMsg });
  res.json({ ok: true, playerId: player.id, apiKey: player.apiKey, spawn: player.spawn });
});

// REST: get state (simple)
app.get('/state', (req, res) => {
  const { playerId, apiKey } = req.query;
  const p = players.get(playerId);
  if (!p || p.apiKey !== apiKey) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.json({ ok: true, player: p, players: Array.from(players.values()) });
});

function getWorldSnapshot() {
  return {
    ok: true,
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    worldSize: WORLD_W,
    tiles: Array.from(world),
    players: Array.from(players.values()).map(({ apiKey, ...rest }) => rest),
    animals: Array.from(animals.values()),
    npcs: Array.from(npcs.values()),
    villages,
    chat: chatLog,
  };
}

// Public world snapshot (safe, no apiKey)
app.get('/world', (req, res) => {
  res.json(getWorldSnapshot());
});

// Public leaderboard (safe)
app.get('/leaderboard', (req, res) => {
  const list = Array.from(players.values()).map((p) => {
    const stats = p.stats || {};
    return {
      id: p.id,
      name: p.name,
      kills: stats.kills || 0,
      deaths: stats.deaths || 0,
      kd: stats.deaths ? (stats.kills || 0) / stats.deaths : stats.kills || 0,
      blocksMined: stats.blocksMined || 0,
      itemsCrafted: stats.itemsCrafted || 0,
      playtimeMs: stats.playtimeMs || 0,
    };
  });
  list.sort((a, b) => b.kills - a.kills);
  res.json({ ok: true, players: list });
});

const server = app.listen(PORT, () => {
  console.log(`Moltwars server running on :${PORT}`);
});

// WebSocket for realtime actions
const wss = new WebSocketServer({ noServer: true });
// Public world-view WebSocket (no auth)
const wssWorld = new WebSocketServer({ noServer: true });
const worldSockets = new Set();

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/ws/world') {
      wssWorld.handleUpgrade(req, socket, head, (ws) => {
        wssWorld.emit('connection', ws, req);
      });
      return;
    }
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
  } catch (e) {}
  socket.destroy();
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const playerId = url.searchParams.get('playerId');
  const apiKey = url.searchParams.get('apiKey');
  const p = players.get(playerId);
  if (!p || p.apiKey !== apiKey) {
    ws.close();
    return;
  }

  sockets.set(playerId, ws);

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'move') {
        const dx = Math.max(-1, Math.min(1, data.dx || 0));
        const dy = Math.max(-1, Math.min(1, data.dy || 0));
        tryMove(p, dx, dy);
      }
      if (data.type === 'attack' && data.targetId) {
        const now = Date.now();
        const active = p.active;
        const baseDmg = 10;
        let dmg = baseDmg;
        let cd = 800; // default cooldown ms
        if (active && ITEM_DEFS.items?.[active]?.tags?.includes('weapon')) {
          dmg = ITEM_DEFS.items[active].dmg || baseDmg;
          cd = ITEM_DEFS.items[active].cooldown || cd;
        }
        if (now - (p.lastAttack || 0) < cd) return;
        p.lastAttack = now;

        const t = players.get(data.targetId);
        if (t) {
          t.hp = Math.max(0, t.hp - dmg);
          if (t.hp === 0) {
            if (p.stats) p.stats.kills += 1;
            if (t.stats) t.stats.deaths += 1;
            // drop all loot into a chest at death location
            const key = `${t.x},${t.y}`;
            const chest = chests.get(key) || { items: {} };
            for (const [item, count] of Object.entries(t.inv || {})) {
              if (count > 0) chest.items[item] = (chest.items[item] || 0) + count;
            }
            chests.set(key, chest);
            t.inv = {};

            t.hp = 100;
            t.x = t.spawn.x;
            t.y = findSurfaceY(t.spawn.x);
            const deathMsg = `${t.name} died and respawned`;
            addChat(deathMsg);
            broadcast({ type: 'chat', message: deathMsg });
          }
        }
      }
      if (data.type === 'attackAnimal' && data.animalId) {
        const a = animals.get(data.animalId);
        if (a) {
          a.hp -= 5;
          // run away
          a.vx = Math.sign(a.x - p.x) * 2;
          a.vy = Math.sign(a.y - p.y) * 2;
          if (a.hp <= 0) {
            animals.delete(a.id);
            p.inv[ITEM.MEAT] = (p.inv[ITEM.MEAT] || 0) + 1;
          }
        }
      }
      if (data.type === 'eat' && data.item === ITEM.MEAT) {
        if ((p.inv[ITEM.MEAT] || 0) > 0) {
          p.inv[ITEM.MEAT] -= 1;
          p.hp = Math.min(100, p.hp + 20);
        }
      }
      if (data.type === 'mine') {
        const { x, y } = data;
        const t = getTile(x, y);
        if (t !== TILE.AIR && t !== TILE.SKY) {
          setTile(x, y, TILE.AIR);
          const item = t === TILE.TREE ? ITEM.WOOD : t === TILE.ORE ? ITEM.ORE : t === TILE.STONE ? ITEM.STONE : ITEM.DIRT;
          p.inv[item] = (p.inv[item] || 0) + 1;
          if (p.stats) p.stats.blocksMined += 1;
        }
      }
      if (data.type === 'build') {
        const { x, y, tile } = data;
        const map = {
          [TILE.DIRT]: ITEM.DIRT,
          [TILE.STONE]: ITEM.STONE,
          [TILE.ORE]: ITEM.ORE,
          [TILE.TREE]: ITEM.WOOD,
        };
        const item = map[tile];
        if (getTile(x, y) === TILE.AIR && item && (p.inv[item] || 0) > 0) {
          setTile(x, y, tile);
          p.inv[item] -= 1;
        }
      }
      if (data.type === 'craft') {
        const { recipe } = data;
        const r = RECIPES()[recipe];
        if (!r) return;
        let ok = true;
        for (const [k, v] of Object.entries(r.in)) {
          if ((p.inv[k] || 0) < v) ok = false;
        }
        if (ok) {
          for (const [k, v] of Object.entries(r.in)) p.inv[k] -= v;
          for (const [k, v] of Object.entries(r.out)) p.inv[k] = (p.inv[k] || 0) + v;
          if (p.stats) p.stats.itemsCrafted += 1;
        }
      }
      if (data.type === 'openChest') {
        const { x, y } = data;
        const key = `${x},${y}`;
        if (!chests.has(key)) chests.set(key, { items: {} });
      }
      if (data.type === 'putChest') {
        const { x, y, item, count } = data;
        const key = `${x},${y}`;
        const chest = chests.get(key) || { items: {} };
        if ((p.inv[item] || 0) >= count) {
          p.inv[item] -= count;
          chest.items[item] = (chest.items[item] || 0) + count;
          chests.set(key, chest);
        }
      }
      if (data.type === 'takeChest') {
        const { x, y, item, count } = data;
        const key = `${x},${y}`;
        const chest = chests.get(key);
        if (chest && (chest.items[item] || 0) >= count) {
          chest.items[item] -= count;
          p.inv[item] = (p.inv[item] || 0) + count;
          chests.set(key, chest);
        }
      }
      if (data.type === 'equip' && data.item) {
        const item = String(data.item);
        if ((p.inv[item] || 0) > 0) {
          p.active = item;
        }
      }
      if (data.type === 'unequip') {
        p.active = null;
      }
      if (data.type === 'chat' && data.message) {
        const msg = `${p.name}: ${data.message}`;
        addChat(msg);
        broadcast({ type: 'chat', message: msg });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    sockets.delete(playerId);
    const leaveMsg = `${p.name} left the world`;
    addChat(leaveMsg);
    broadcast({ type: 'chat', message: leaveMsg });
  });
});

// Public world-view WebSocket (no auth)
wssWorld.on('connection', (ws) => {
  worldSockets.add(ws);
  ws.on('close', () => worldSockets.delete(ws));
});

// Tick loop
setInterval(() => {
  tickAnimals();
  tickNpcs();
  for (const [playerId, ws] of sockets.entries()) {
    if (ws.readyState !== 1) continue;
    const p = players.get(playerId);
    if (!p) continue;
    applyGravity(p);
    if (p.stats) {
      const now = Date.now();
      const last = p.stats.lastTick || now;
      p.stats.playtimeMs += Math.max(0, now - last);
      p.stats.lastTick = now;
    }
    const nearbyPlayers = Array.from(players.values())
      .filter(o => Math.abs(o.x - p.x) <= VIEW_RADIUS && Math.abs(o.y - p.y) <= VIEW_RADIUS)
      .map(({ apiKey, ...rest }) => rest);

    const payload = {
      type: 'tick',
      player: { id: p.id, x: p.x, y: p.y, hp: p.hp, inv: p.inv, skin: p.skin, active: p.active },
      players: nearbyPlayers,
      tiles: getViewport(p),
      chests: nearbyChests(p),
      animals: nearbyAnimals(p),
      npcs: nearbyNpcs(p),
    };
    ws.send(JSON.stringify(payload));
  }
}, 1000 / TICK_RATE);

// World-view broadcast (1s)
setInterval(() => {
  if (worldSockets.size === 0) return;
  const payload = JSON.stringify({ type: 'world', ...getWorldSnapshot() });
  for (const ws of worldSockets) {
    if (ws.readyState === 1) ws.send(payload);
  }
}, 1000);

// NPC chatter (random)
setInterval(() => {
  if (npcs.size === 0) return;
  if (rand() > 0.15) return; // ~15% per tick interval
  const arr = Array.from(npcs.values());
  const npc = arr[Math.floor(rand() * arr.length)];
  const msg = `${npc.name}: ${NPC_CHAT[Math.floor(rand() * NPC_CHAT.length)]}`;
  addChat(msg);
  broadcast({ type: 'chat', message: msg });
  broadcastWorld({ type: 'npcChat', npcId: npc.id, message: msg, ttlMs: 6000 });
}, 5000);

// Load and autosave
loadDefs();
loadWorld();
setInterval(saveWorld, SAVE_INTERVAL_MS);
process.on('SIGINT', () => {
  saveWorld();
  process.exit();
});
