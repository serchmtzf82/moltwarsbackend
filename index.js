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

// Biomes (scaffold for future)
const BIOME = {
  FOREST: 0,
  DESERT: 1,
  SNOW: 2,
  JUNGLE: 3,
};

// In-memory state (authoritative)
const players = new Map(); // playerId -> {id, name, x, y, hp, apiKey, inv, spawn}
const sockets = new Map(); // playerId -> ws
let world = new Uint8Array(WORLD_SIZE * WORLD_SIZE);
let biomeMap = new Uint8Array(WORLD_SIZE * WORLD_SIZE);
let villages = []; // [{x,y}]
const chests = new Map(); // key "x,y" -> {items:{[tile]:count}}

// Crafting recipes (scaffold)
const RECIPES = {
  // example: 2 wood -> 1 plank
  plank: { in: { [TILE.TREE]: 2 }, out: { plank: 1 } },
};

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

function setBiome(x, y, b) {
  if (x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE) return;
  biomeMap[idx(x, y)] = b;
}

function genBiomes() {
  // simple horizontal bands for now
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      if (y < WORLD_SIZE * 0.2) setBiome(x, y, BIOME.FOREST);
      else if (y < WORLD_SIZE * 0.4) setBiome(x, y, BIOME.DESERT);
      else if (y < WORLD_SIZE * 0.6) setBiome(x, y, BIOME.FOREST);
      else if (y < WORLD_SIZE * 0.8) setBiome(x, y, BIOME.SNOW);
      else setBiome(x, y, BIOME.JUNGLE);
    }
  }
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
        else setTile(x, y, Math.random() < 0.06 ? TILE.ORE : TILE.STONE);
      } else {
        setTile(x, y, Math.random() < 0.12 ? TILE.ORE : TILE.STONE);
      }
    }
  }

  // Trees on surface
  for (let x = 0; x < WORLD_SIZE; x++) {
    if (Math.random() < 0.06) {
      for (let y = skyH; y < skyH + 10; y++) {
        if (getTile(x, y) === TILE.DIRT) {
          setTile(x, y - 1, TILE.TREE);
          setTile(x, y - 2, TILE.TREE);
          break;
        }
      }
    }
  }

  genBiomes();
  genVillages();
}

function genVillages() {
  villages = [];
  for (let i = 0; i < 6; i++) {
    villages.push({
      x: Math.floor(Math.random() * WORLD_SIZE),
      y: Math.floor(WORLD_SIZE * 0.25 + Math.random() * WORLD_SIZE * 0.5),
    });
  }
}

function loadWorld() {
  try {
    if (fs.existsSync(SAVE_PATH)) {
      const raw = fs.readFileSync(SAVE_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (data?.players) {
        for (const p of data.players) players.set(p.id, p);
      }
      if (data?.world && data.world.length === WORLD_SIZE * WORLD_SIZE) {
        world = Uint8Array.from(data.world);
      } else {
        genWorld();
      }
      if (data?.biomeMap && data.biomeMap.length === WORLD_SIZE * WORLD_SIZE) {
        biomeMap = Uint8Array.from(data.biomeMap);
      }
      if (data?.villages) villages = data.villages;
      if (data?.chests) {
        for (const [k, v] of Object.entries(data.chests)) chests.set(k, v);
      }
    } else {
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
      biomeMap: Array.from(biomeMap),
      villages,
      chests: Object.fromEntries(chests),
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
  const spawnX = Math.floor(Math.random() * WORLD_SIZE);
  return {
    id: randomUUID(),
    name,
    x: spawnX,
    y: surfaceY,
    hp: 100,
    apiKey: randomUUID().replace(/-/g, ''),
    inv: {},
    spawn: { x: spawnX, y: surfaceY },
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
        p.x += data.dx || 0;
        p.y += data.dy || 0;
      }
      if (data.type === 'attack' && data.targetId) {
        const t = players.get(data.targetId);
        if (t) {
          t.hp = Math.max(0, t.hp - 5);
          if (t.hp === 0) {
            t.hp = 100;
            t.x = t.spawn.x;
            t.y = t.spawn.y;
            broadcast({ type: 'chat', message: `${t.name} died and respawned` });
          }
        }
      }
      if (data.type === 'mine') {
        const { x, y } = data;
        const t = getTile(x, y);
        if (t !== TILE.AIR) {
          setTile(x, y, TILE.AIR);
          p.inv[t] = (p.inv[t] || 0) + 1;
        }
      }
      if (data.type === 'build') {
        const { x, y, tile } = data;
        if (getTile(x, y) === TILE.AIR && (p.inv[tile] || 0) > 0) {
          setTile(x, y, tile);
          p.inv[tile] -= 1;
        }
      }
      if (data.type === 'craft') {
        const { recipe } = data;
        const r = RECIPES[recipe];
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
  for (const [playerId, ws] of sockets.entries()) {
    if (ws.readyState !== 1) continue;
    const p = players.get(playerId);
    if (!p) continue;
    const nearbyPlayers = Array.from(players.values())
      .filter(o => Math.abs(o.x - p.x) <= VIEW_RADIUS && Math.abs(o.y - p.y) <= VIEW_RADIUS)
      .map(({ apiKey, ...rest }) => rest);

    const payload = {
      type: 'tick',
      player: { id: p.id, x: p.x, y: p.y, hp: p.hp, inv: p.inv },
      players: nearbyPlayers,
      tiles: getViewport(p),
      chests: nearbyChests(p),
    };
    ws.send(JSON.stringify(payload));
  }
}, 1000 / TICK_RATE);

// Load and autosave
loadWorld();
setInterval(saveWorld, SAVE_INTERVAL_MS);
process.on('SIGINT', () => {
  saveWorld();
  process.exit();
});
