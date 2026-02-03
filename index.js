import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import fs from 'fs';

const PORT = process.env.PORT || 8080;
const TICK_RATE = 10; // 100ms ticks
const WORLD_SIZE = 512; // tiles (square)
const VIEW_RADIUS = 16; // tiles around player
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
  rand = mulberry32(h);
}

// In-memory state (authoritative)
const players = new Map(); // playerId -> {id, name, x, y, hp, apiKey, inv, spawn, active}
const sockets = new Map(); // playerId -> ws
let world = new Uint8Array(WORLD_SIZE * WORLD_SIZE);
let villages = []; // [{x,y}]
const chests = new Map(); // key "x,y" -> {items:{[item]:count}}
const animals = new Map(); // id -> {id, type, x, y, hp, vx, vy}
const npcs = new Map(); // id -> {id, name, x, y, hp, inv, vx, vy}

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
  return y * WORLD_SIZE + x;
}

function getTile(x, y) {
  if (x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE) return TILE.AIR;
  return world[idx(x, y)];
}

function setTile(x, y, t) {
  if (x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE) return;
  world[idx(x, y)] = t;
}

function genWorld() {
  const skyH = Math.floor(WORLD_SIZE * 0.2);
  const surfaceH = Math.floor(WORLD_SIZE * 0.6);
  const undergroundStart = skyH + surfaceH;

  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      if (y < skyH) {
        setTile(x, y, TILE.AIR);
      } else if (y < undergroundStart) {
        const depth = y - skyH;
        if (depth < surfaceH * 0.35) setTile(x, y, TILE.DIRT);
        else setTile(x, y, rand() < 0.06 ? TILE.ORE : TILE.STONE);
      } else {
        setTile(x, y, rand() < 0.12 ? TILE.ORE : TILE.STONE);
      }
    }
  }

  // Trees on surface
  for (let x = 0; x < WORLD_SIZE; x++) {
    if (rand() < 0.06) {
      for (let y = skyH; y < skyH + 10; y++) {
        if (getTile(x, y) === TILE.DIRT) {
          setTile(x, y - 1, TILE.TREE);
          setTile(x, y - 2, TILE.TREE);
          break;
        }
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
      x: Math.floor(rand() * WORLD_SIZE),
      y: Math.floor(WORLD_SIZE * 0.25 + rand() * WORLD_SIZE * 0.5),
    });
  }
}

function genAnimals() {
  animals.clear();
  for (let i = 0; i < 40; i++) {
    animals.set(randomUUID(), {
      id: randomUUID(),
      type: 'boar',
      x: Math.floor(rand() * WORLD_SIZE),
      y: Math.floor(WORLD_SIZE * 0.25 + rand() * WORLD_SIZE * 0.5),
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
      x: Math.floor(rand() * WORLD_SIZE),
      y: Math.floor(WORLD_SIZE * 0.25 + rand() * WORLD_SIZE * 0.5),
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
      if (data?.world && data.world.length === WORLD_SIZE * WORLD_SIZE) {
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

function spawnPlayer(name) {
  const skyH = Math.floor(WORLD_SIZE * 0.2);
  const surfaceY = skyH + 2;
  const spawnX = Math.floor(rand() * WORLD_SIZE);
  return {
    id: randomUUID(),
    name,
    x: spawnX,
    y: surfaceY,
    hp: 100,
    apiKey: randomUUID().replace(/-/g, ''),
    inv: {},
    active: null,
    spawn: { x: spawnX, y: surfaceY },
    skin: SKINS[Math.floor(rand() * SKINS.length)],
  };
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of sockets.values()) {
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

function tickAnimals() {
  for (const a of animals.values()) {
    // random wander
    if (rand() < 0.3) {
      a.vx = Math.floor(rand() * 3) - 1;
      a.vy = Math.floor(rand() * 3) - 1;
    }
    a.x += a.vx * 0.2;
    a.y += a.vy * 0.2;
  }
}

function tickNpcs() {
  for (const n of npcs.values()) {
    if (rand() < 0.25) {
      n.vx = Math.floor(rand() * 3) - 1;
      n.vy = Math.floor(rand() * 3) - 1;
    }
    n.x += n.vx * 0.3;
    n.y += n.vy * 0.3;

    // Mine nearby block sometimes
    if (rand() < 0.05) {
      const tx = Math.floor(n.x + (rand() * 3 - 1));
      const ty = Math.floor(n.y + (rand() * 3 - 1));
      const t = getTile(tx, ty);
      if (t !== TILE.AIR) {
        setTile(tx, ty, TILE.AIR);
        const item = t === TILE.TREE ? ITEM.WOOD : t === TILE.ORE ? ITEM.ORE : t === TILE.STONE ? ITEM.STONE : ITEM.DIRT;
        n.inv[item] = (n.inv[item] || 0) + 1;
      }
    }

    // Build occasionally if has materials
    if (rand() < 0.03) {
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
  broadcast({ type: 'chat', message: `${player.name} joined the world` });
  res.json({ ok: true, playerId: player.id, apiKey: player.apiKey, spawn: player.spawn });
});

// REST: get state (simple)
app.get('/state', (req, res) => {
  const { playerId, apiKey } = req.query;
  const p = players.get(playerId);
  if (!p || p.apiKey !== apiKey) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.json({ ok: true, player: p, players: Array.from(players.values()) });
});

// Public world snapshot (safe, no apiKey)
app.get('/world', (req, res) => {
  res.json({
    ok: true,
    worldSize: WORLD_SIZE,
    tiles: Array.from(world),
    players: Array.from(players.values()).map(({ apiKey, ...rest }) => rest),
    animals: Array.from(animals.values()),
    npcs: Array.from(npcs.values()),
    villages,
  });
});

const server = app.listen(PORT, () => {
  console.log(`Moltwars server running on :${PORT}`);
});

// WebSocket for realtime actions
const wss = new WebSocketServer({ server, path: '/ws' });

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
        p.x = Math.max(0, Math.min(WORLD_SIZE - 1, p.x + dx));
        p.y = Math.max(0, Math.min(WORLD_SIZE - 1, p.y + dy));
      }
      if (data.type === 'attack' && data.targetId) {
        const t = players.get(data.targetId);
        if (t) {
          const active = p.active;
          const baseDmg = 5;
          let dmg = baseDmg;
          if (active && ITEM_DEFS.items?.[active]?.tags?.includes('weapon')) {
            dmg = ITEM_DEFS.items[active].dmg || baseDmg;
          }
          t.hp = Math.max(0, t.hp - dmg);
          if (t.hp === 0) {
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
            t.y = t.spawn.y;
            broadcast({ type: 'chat', message: `${t.name} died and respawned` });
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
        if (t !== TILE.AIR) {
          setTile(x, y, TILE.AIR);
          const item = t === TILE.TREE ? ITEM.WOOD : t === TILE.ORE ? ITEM.ORE : t === TILE.STONE ? ITEM.STONE : ITEM.DIRT;
          p.inv[item] = (p.inv[item] || 0) + 1;
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
        broadcast({ type: 'chat', message: `${p.name}: ${data.message}` });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    sockets.delete(playerId);
    broadcast({ type: 'chat', message: `${p.name} left the world` });
  });
});

// Tick loop
setInterval(() => {
  tickAnimals();
  tickNpcs();
  for (const [playerId, ws] of sockets.entries()) {
    if (ws.readyState !== 1) continue;
    const p = players.get(playerId);
    if (!p) continue;
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

// Load and autosave
loadDefs();
loadWorld();
setInterval(saveWorld, SAVE_INTERVAL_MS);
process.on('SIGINT', () => {
  saveWorld();
  process.exit();
});
