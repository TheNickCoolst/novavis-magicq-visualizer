import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { parseAnyPatchFile, setupMagicQLiveFolderWatchers } from './liveSync.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = Number(process.env.PORT || 4321);
const ARTNET_PORT = Number(process.env.ARTNET_PORT || 6454);
const SACN_PORT = Number(process.env.SACN_PORT || 5568);
const OSC_PORT = Number(process.env.OSC_PORT || 8000);
const MAX_UNIVERSES = 64;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
};

const universes = Array.from({ length: MAX_UNIVERSES }, () => new Uint8Array(512));
const dirtyUniverses = new Set();
let latestSyncedRig = null;

function getBonjourHost() {
  if (process.platform !== 'darwin') {
    const h = os.hostname();
    return h.toLowerCase().endsWith('.local') ? h : `${h}.local`;
  }
  try {
    const raw = execSync('scutil --get LocalHostName', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (raw) return `${raw}.local`;
  } catch {
    // Fallback to os.hostname()
  }
  const h = os.hostname();
  return h.endsWith('.local') ? h : `${h}.local`;
}

/**
 * Enumerate all active non-internal IPv4 LAN interfaces (Wi-Fi, Ethernet, Show NICs)
 * including computed subnet broadcast address for Art-Net LAN discovery.
 */
function getLanInterfaces() {
  const nets = os.networkInterfaces();
  const list = [];
  for (const [name, entries] of Object.entries(nets)) {
    if (!entries || name.startsWith('utun')) continue; // Skip point-to-point VPN tunnels for primary LAN list
    for (const net of entries) {
      if (net.family === 'IPv4' && !net.internal) {
        const ipParts = net.address.split('.').map(Number);
        const maskParts = (net.netmask || '255.255.255.0').split('.').map(Number);
        const bcast = ipParts.map((octet, i) => (octet | (~maskParts[i] & 0xff))).join('.');
        list.push({
          name,
          address: net.address,
          netmask: net.netmask,
          broadcast: bcast,
        });
      }
    }
  }
  return list;
}

function getPrimaryLanIp() {
  const list = getLanInterfaces();
  return list[0]?.address || '127.0.0.1';
}

const BONJOUR_HOST = getBonjourHost();

const stats = {
  artnetBound: false,
  artnetError: null,
  sacnBound: false,
  sacnError: null,
  oscBound: false,
  bonjourActive: false,
  artnetPacketsTotal: 0,
  sacnPacketsTotal: 0,
  oscPacketsTotal: 0,
  artPollCount: 0,
  packetsPerSec: 0,
  lastProtocol: null,
  lastSenderIp: null,
  lastPacketAt: 0,
  lastOscAddress: null,
  activeUniverses: new Set(),
  watchedPaths: [],
  syncDir: '',
};

let packetsThisSecond = 0;

function buildArtPollReply(ipStr, subSwitch = 0, bindIndex = 1) {
  const buf = Buffer.alloc(239, 0);
  buf.write('Art-Net\0', 0, 'ascii');
  buf.writeUInt16LE(0x2100, 8);

  const ipParts = ipStr.split('.').map((n) => Number(n) & 0xff);
  buf[10] = ipParts[0] || 127;
  buf[11] = ipParts[1] || 0;
  buf[12] = ipParts[2] || 0;
  buf[13] = ipParts[3] || 1;
  buf.writeUInt16LE(ARTNET_PORT, 14);

  buf[16] = 2;
  buf[17] = 1;
  buf[18] = 0;
  buf[19] = subSwitch & 0x0f;

  buf.writeUInt16BE(0x00ff, 20);
  buf[22] = 0;
  buf[23] = 0xd0;
  buf.writeUInt16LE(0x7ff0, 24);

  buf.write('NovaVis L8 Pro', 26, 'ascii');
  buf.write(`NovaVis L8 3D Visualizer (${ipStr}:${HTTP_PORT})`, 44, 'ascii');
  buf.write('#0001 [0000] LAN 64-Uni Sync Ready', 108, 'ascii');

  buf.writeUInt16BE(4, 172);
  buf[174] = 0x80;
  buf[175] = 0x80;
  buf[176] = 0x80;
  buf[177] = 0x80;

  buf[182] = 0x80;
  buf[183] = 0x80;
  buf[184] = 0x80;
  buf[185] = 0x80;

  const baseUni = (subSwitch & 0x0f) * 4;
  buf[190] = (baseUni + 0) & 0x0f;
  buf[191] = (baseUni + 1) & 0x0f;
  buf[192] = (baseUni + 2) & 0x0f;
  buf[193] = (baseUni + 3) & 0x0f;

  buf[200] = 0x03; // StVisual
  buf[207] = buf[10];
  buf[208] = buf[11];
  buf[209] = buf[12];
  buf[210] = buf[13];
  buf[211] = bindIndex;
  buf[212] = 0x0e;

  return buf;
}

// --- 1) Art-Net 4 UDP Socket (0.0.0.0:6454 — Open on all LAN & Loopback NICs) ---
const artnetSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

function announceArtNetOnLan() {
  if (!stats.artnetBound) return;
  const ifaces = getLanInterfaces();
  for (const iface of ifaces) {
    try {
      const reply = buildArtPollReply(iface.address, 0, 1);
      artnetSocket.send(reply, 0, reply.length, ARTNET_PORT, iface.broadcast);
    } catch {
      // Ignore transient broadcast errors
    }
  }
}

artnetSocket.on('error', (err) => {
  stats.artnetBound = false;
  stats.artnetError = err.message;
  console.warn(`[Art-Net] UDP :${ARTNET_PORT} warning:`, err.message);
});

artnetSocket.on('message', (msg, rinfo) => {
  if (msg.length < 10) return;
  if (
    msg[0] !== 0x41 || msg[1] !== 0x72 || msg[2] !== 0x74 || msg[3] !== 0x2d ||
    msg[4] !== 0x4e || msg[5] !== 0x65 || msg[6] !== 0x74 || msg[7] !== 0x00
  ) {
    return;
  }

  const opCode = msg.readUInt16LE(8);

  if (opCode === 0x2000) {
    stats.artPollCount++;
    const ifaces = getLanInterfaces();
    const matched = ifaces.find((i) => {
      const pA = i.address.split('.');
      const pB = rinfo.address.split('.');
      return pA[0] === pB[0] && pA[1] === pB[1] && pA[2] === pB[2];
    });
    const replyIp = rinfo.address === '127.0.0.1' ? getPrimaryLanIp() : (matched?.address || getPrimaryLanIp());
    const reply = buildArtPollReply(replyIp, 0, 1);
    artnetSocket.send(reply, 0, reply.length, rinfo.port, rinfo.address);
    return;
  }

  if (opCode === 0x5000 && msg.length >= 18) {
    const subUni = msg[14];
    const net = msg[15] & 0x7f;
    const universe = (net << 8) | subUni;
    const dmxLength = Math.min(512, msg.readUInt16BE(16));

    if (universe >= 0 && universe < MAX_UNIVERSES && msg.length >= 18 + dmxLength) {
      universes[universe].set(msg.subarray(18, 18 + dmxLength), 0);
      dirtyUniverses.add(universe);
      stats.activeUniverses.add(universe);
      stats.artnetPacketsTotal++;
      packetsThisSecond++;
      stats.lastProtocol = 'Art-Net 4';
      stats.lastSenderIp = rinfo.address;
      stats.lastPacketAt = Date.now();
    }
  }
});

artnetSocket.bind(ARTNET_PORT, '0.0.0.0', () => {
  stats.artnetBound = true;
  try {
    artnetSocket.setBroadcast(true);
  } catch {
    // Ignore broadcast restriction if any
  }
  announceArtNetOnLan();
  console.log(`[Art-Net] LAN Ready on UDP 0.0.0.0:${ARTNET_PORT} (64 Universes + LAN Broadcast Discovery)`);
});

// --- 2) sACN / ANSI E1.31 UDP Socket (0.0.0.0:5568 — Multi-NIC Multicast Join) ---
const sacnSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sacnSocket.on('error', (err) => {
  stats.sacnBound = false;
  stats.sacnError = err.message;
  console.warn(`[sACN] UDP :${SACN_PORT} warning:`, err.message);
});

sacnSocket.on('message', (msg, rinfo) => {
  if (msg.length < 126) return;
  if (msg.toString('ascii', 4, 13) !== 'ASC-E1.17') return;
  if (msg.readUInt32BE(18) !== 0x00000004) return;
  if (msg.readUInt32BE(40) !== 0x00000002) return;
  if (msg[117] !== 0x02 || msg[125] !== 0x00) return;

  const sacnUniverse = msg.readUInt16BE(113);
  const propCount = msg.readUInt16BE(123);
  const dmxLength = Math.min(512, Math.max(0, propCount - 1));
  const zeroIndexedUniverse = sacnUniverse > 0 ? sacnUniverse - 1 : 0;

  if (zeroIndexedUniverse >= 0 && zeroIndexedUniverse < MAX_UNIVERSES && msg.length >= 126 + dmxLength) {
    universes[zeroIndexedUniverse].set(msg.subarray(126, 126 + dmxLength), 0);
    dirtyUniverses.add(zeroIndexedUniverse);
    stats.activeUniverses.add(zeroIndexedUniverse);
    stats.sacnPacketsTotal++;
    packetsThisSecond++;
    stats.lastProtocol = 'sACN (E1.31)';
    stats.lastSenderIp = rinfo.address;
    stats.lastPacketAt = Date.now();
  }
});

sacnSocket.bind(SACN_PORT, '0.0.0.0', () => {
  stats.sacnBound = true;
  const ifaces = getLanInterfaces();
  // Join multicast groups across ALL active LAN interfaces (Wi-Fi + Ethernet!)
  for (let u = 1; u <= 16; u++) {
    const mcast = `239.255.0.${u}`;
    if (ifaces.length === 0) {
      try { sacnSocket.addMembership(mcast); } catch {}
    } else {
      for (const iface of ifaces) {
        try { sacnSocket.addMembership(mcast, iface.address); } catch {}
      }
    }
  }
  console.log(`[sACN]    LAN Ready on UDP 0.0.0.0:${SACN_PORT} (Multicast joined on ${ifaces.map((i) => i.name).join(', ') || 'default'})`);
});

// --- 3) ChamSys MagicQ OSC Live Sync Listener (0.0.0.0:8000) ---
const oscSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

function parseSimpleOscPacket(buf) {
  if (buf.length < 4 || buf[0] !== 0x2f) return null;
  const zeroIdx = buf.indexOf(0);
  if (zeroIdx <= 0) return null;
  const address = buf.toString('utf8', 0, zeroIdx);
  const typeTagStart = (zeroIdx + 4) & ~3;
  if (typeTagStart >= buf.length || buf[typeTagStart] !== 0x2c) {
    return { address, arg: null };
  }
  const tagEnd = buf.indexOf(0, typeTagStart);
  const tags = buf.toString('ascii', typeTagStart + 1, tagEnd > 0 ? tagEnd : typeTagStart + 2);
  const argStart = ((tagEnd > 0 ? tagEnd : typeTagStart + 1) + 4) & ~3;

  let arg = null;
  if (tags.startsWith('f') && argStart + 4 <= buf.length) {
    arg = buf.readFloatBE(argStart);
  } else if (tags.startsWith('i') && argStart + 4 <= buf.length) {
    arg = buf.readInt32BE(argStart);
  } else if (tags.startsWith('s') && argStart < buf.length) {
    const sEnd = buf.indexOf(0, argStart);
    arg = buf.toString('utf8', argStart, sEnd > 0 ? sEnd : buf.length);
  }
  return { address, arg };
}

oscSocket.on('error', () => { stats.oscBound = false; });
oscSocket.on('message', (msg) => {
  const parsed = parseSimpleOscPacket(msg);
  if (!parsed) return;
  stats.oscPacketsTotal++;
  stats.lastOscAddress = parsed.address;
  broadcastJson({ type: 'osc', address: parsed.address, arg: parsed.arg });
});
oscSocket.bind(OSC_PORT, '0.0.0.0', () => {
  stats.oscBound = true;
  console.log(`[OSC]     LAN Ready on UDP 0.0.0.0:${OSC_PORT}`);
});

// --- 4) Bonjour / mDNS LAN Advertisement (dns-sd: built into macOS, on Windows via Apple Bonjour) ---
let bonjourProc = null;
try {
  bonjourProc = spawn(process.platform === 'win32' ? 'dns-sd.exe' : 'dns-sd', ['-R', 'NovaVis L8 Pro 3D Visualizer', '_http._tcp', 'local', String(HTTP_PORT)], {
    stdio: 'ignore',
    windowsHide: true,
  });
  bonjourProc.on('error', () => { stats.bonjourActive = false; });
  stats.bonjourActive = true;
  const cleanupBonjour = () => {
    if (bonjourProc && !bonjourProc.killed) bonjourProc.kill();
  };
  process.on('SIGINT', () => { cleanupBonjour(); process.exit(0); });
  process.on('SIGTERM', () => { cleanupBonjour(); process.exit(0); });
  process.on('exit', cleanupBonjour);
} catch {
  stats.bonjourActive = false;
}

// --- Loopback / LAN Demo Art-Net Sender ---
let demoBurstTimer = null;

function runLoopbackArtNetBurst(durationMs = 6500, targetUniverseOffset = 0) {
  if (demoBurstTimer) {
    clearInterval(demoBurstTimer);
    demoBurstTimer = null;
  }
  const sender = dgram.createSocket('udp4');
  const start = Date.now();

  demoBurstTimer = setInterval(() => {
    const elapsed = (Date.now() - start) / 1000;
    if (Date.now() - start > durationMs) {
      clearInterval(demoBurstTimer);
      demoBurstTimer = null;
      sender.close();
      return;
    }

    for (let uIdx = 0; uIdx < 2; uIdx++) {
      const uni = targetUniverseOffset + uIdx;
      const dmx = Buffer.alloc(512, 0);

      if (uIdx === 0) {
        for (let i = 0; i < 8; i++) {
          const base = i * 16;
          const sym = (i / 7) * 2 - 1;
          const phase = elapsed * 2.5 + i * 0.45;
          dmx[base + 0] = Math.round(128 - sym * 26 + Math.sin(phase) * 32);
          dmx[base + 2] = Math.round(156 + Math.cos(phase) * 26);
          dmx[base + 4] = 255;
          dmx[base + 6] = i % 2 === 0 ? 0 : 255;
          dmx[base + 7] = i % 2 === 0 ? 225 : 25;
          dmx[base + 8] = 255;
          dmx[base + 11] = 80;
          dmx[base + 12] = 168;
          dmx[base + 13] = 34;
        }
        for (let i = 0; i < 6; i++) {
          const base = 128 + i * 12;
          const phase = elapsed * 1.9 + i * 0.6;
          dmx[base + 0] = Math.round(128 + Math.cos(phase) * 36);
          dmx[base + 2] = Math.round(152 + Math.sin(phase) * 22);
          dmx[base + 4] = 240;
          dmx[base + 6] = 40;
          dmx[base + 7] = Math.round(100 + 90 * Math.sin(phase));
          dmx[base + 8] = 255;
          dmx[base + 10] = 150;
        }
        for (let i = 0; i < 6; i++) {
          const base = 200 + i * 16;
          const sym = (i / 5) * 2 - 1;
          const phase = elapsed * 2.8 + i * 0.55;
          dmx[base + 0] = Math.round(128 + sym * 22 + Math.sin(phase) * 28);
          dmx[base + 2] = Math.round(150 + Math.cos(phase) * 22);
          dmx[base + 4] = 255;
          dmx[base + 6] = 255;
          dmx[base + 7] = 155;
          dmx[base + 8] = 15;
          dmx[base + 11] = 48;
          dmx[base + 12] = 160;
          dmx[base + 13] = 28;
        }
      } else {
        for (let b = 0; b < 4; b++) {
          const base = b * 26;
          dmx[base + 0] = 255;
          for (let c = 0; c < 8; c++) {
            const idx = b * 8 + c;
            const wave = 0.5 + 0.5 * Math.sin(elapsed * 6.5 - idx * 0.35);
            dmx[base + 2 + c * 3 + 0] = Math.round(255 * wave);
            dmx[base + 2 + c * 3 + 1] = Math.round(90 * (1 - wave));
            dmx[base + 2 + c * 3 + 2] = Math.round(255 * (1 - wave * 0.45));
          }
        }
        for (let bl = 0; bl < 4; bl++) {
          const base = 104 + bl * 4;
          const hit = Math.max(0, Math.sin(elapsed * 4.2 + bl * 0.7));
          dmx[base + 0] = Math.round(hit * hit * 255);
          dmx[base + 2] = 210;
        }
      }

      const pkt = Buffer.alloc(18 + 512);
      pkt.write('Art-Net\0', 0, 'ascii');
      pkt.writeUInt16LE(0x5000, 8);
      pkt.writeUInt16BE(14, 10);
      pkt[14] = uni & 0xff;
      pkt[15] = (uni >> 8) & 0x7f;
      pkt.writeUInt16BE(512, 16);
      dmx.copy(pkt, 18);

      sender.send(pkt, 0, pkt.length, ARTNET_PORT, '127.0.0.1');
    }
  }, 23);
}

function computeActiveFootprints() {
  const list = [];
  for (const u of stats.activeUniverses) {
    const buf = universes[u];
    let nonZero = 0;
    let firstCh = 513;
    let lastCh = 0;
    for (let i = 0; i < 512; i++) {
      if (buf[i] > 0) {
        nonZero++;
        if (i + 1 < firstCh) firstCh = i + 1;
        if (i + 1 > lastCh) lastCh = i + 1;
      }
    }
    if (nonZero > 0) list.push({ universe: u, nonZero, firstCh, lastCh });
  }
  return list.sort((a, b) => a.universe - b.universe);
}

const publicDir = path.join(__dirname, 'public');
const threeDir = path.join(__dirname, 'node_modules', 'three');

function getStatusPayload() {
  const lanInterfaces = getLanInterfaces();
  const primaryIp = lanInterfaces[0]?.address || '127.0.0.1';
  const lanUrls = lanInterfaces.map((i) => ({
    iface: i.name,
    ip: i.address,
    url: `http://${i.address}:${HTTP_PORT}`,
  }));

  return {
    localIp: primaryIp,
    bonjourHost: BONJOUR_HOST,
    bonjourUrl: `http://${BONJOUR_HOST}:${HTTP_PORT}`,
    lanUrls,
    connectedClients: wss ? wss.clients.size : 0,
    httpPort: HTTP_PORT,
    artnetPort: ARTNET_PORT,
    sacnPort: SACN_PORT,
    oscPort: OSC_PORT,
    artnetBound: stats.artnetBound,
    artnetError: stats.artnetError,
    sacnBound: stats.sacnBound,
    sacnError: stats.sacnError,
    oscBound: stats.oscBound,
    bonjourActive: stats.bonjourActive,
    artnetPacketsTotal: stats.artnetPacketsTotal,
    sacnPacketsTotal: stats.sacnPacketsTotal,
    oscPacketsTotal: stats.oscPacketsTotal,
    artPollCount: stats.artPollCount,
    packetsPerSec: stats.packetsPerSec,
    lastProtocol: stats.lastProtocol,
    lastSenderIp: stats.lastSenderIp,
    lastPacketAt: stats.lastPacketAt,
    lastOscAddress: stats.lastOscAddress,
    activeUniverses: Array.from(stats.activeUniverses).sort((a, b) => a - b),
    footprints: computeActiveFootprints(),
    watchedPaths: stats.watchedPaths,
    syncDir: stats.syncDir,
  };
}

function readRequestBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Datei zu groß'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Enable CORS so any LAN device / companion web tool can query NovaVis freely
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(getStatusPayload()));
      return;
    }

    if (pathname === '/api/test-artnet' && req.method === 'POST') {
      const uniOffset = Number(reqUrl.searchParams.get('uni') || 0);
      runLoopbackArtNetBurst(6500, uniOffset);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, universeOffset: uniOffset }));
      return;
    }

    if (pathname === '/api/reset-rig' && req.method === 'POST') {
      latestSyncedRig = null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/api/import-patch' && req.method === 'POST') {
      const filename = reqUrl.searchParams.get('filename') || 'magicq-patch.csv';
      const rawBuf = await readRequestBody(req);
      const rig = parseAnyPatchFile(rawBuf, filename);
      latestSyncedRig = rig;
      broadcastJson({ type: 'liveRigSync', rig, source: filename });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, rig }));
      return;
    }

    let targetPath;
    if (pathname.startsWith('/vendor/three/')) {
      const rel = pathname.slice('/vendor/three/'.length);
      targetPath = path.resolve(threeDir, rel);
      if (!targetPath.startsWith(threeDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    } else {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      targetPath = path.resolve(publicDir, rel);
      if (!targetPath.startsWith(publicDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    }

    const data = await fs.readFile(targetPath);
    const ext = path.extname(targetPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err?.message || 'Server error' }));
    }
  }
});

// --- WebSocket Real-time DMX & Multi-Client LAN Sync ---
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastJson(obj, excludeWs = null) {
  if (wss.clients.size === 0) return;
  const payload = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', ...getStatusPayload() }));
  if (latestSyncedRig) {
    ws.send(JSON.stringify({ type: 'liveRigSync', rig: latestSyncedRig, source: 'Auto-Sync Cache' }));
  }
  for (const u of stats.activeUniverses) {
    const frame = Buffer.allocUnsafe(4 + 512);
    frame[0] = 0x44;
    frame[1] = 0x4d;
    frame[2] = 0x58;
    frame[3] = u & 0xff;
    Buffer.from(universes[u].buffer, universes[u].byteOffset, 512).copy(frame, 4);
    ws.send(frame, { binary: true });
  }

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'testArtNetBurst') {
        runLoopbackArtNetBurst(Number(msg.durationMs) || 6500, Number(msg.uniOffset) || 0);
      } else if (msg.type === 'uiSync') {
        // Relay Cue, Blackout, BPM, Haze & LED-Wall changes to all other LAN devices!
        broadcastJson(msg, ws);
      }
    } catch {
      // Ignore malformed JSON
    }
  });
});

setInterval(() => {
  if (dirtyUniverses.size === 0 || wss.clients.size === 0) return;
  for (const u of dirtyUniverses) {
    const frame = Buffer.allocUnsafe(4 + 512);
    frame[0] = 0x44;
    frame[1] = 0x4d;
    frame[2] = 0x58;
    frame[3] = u & 0xff;
    Buffer.from(universes[u].buffer, universes[u].byteOffset, 512).copy(frame, 4);

    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(frame, { binary: true });
    }
  }
  dirtyUniverses.clear();
}, 16);

setInterval(() => {
  stats.packetsPerSec = packetsThisSecond;
  packetsThisSecond = 0;
  broadcastJson({ type: 'status', ...getStatusPayload() });
}, 1000);

const watcherInfo = await setupMagicQLiveFolderWatchers(__dirname, (rig, filePath) => {
  latestSyncedRig = rig;
  console.log(`[LiveSync] Rig automatisch aktualisiert aus: ${filePath} (${rig.fixtures.length} Fixtures)`);
  broadcastJson({ type: 'liveRigSync', rig, source: path.basename(filePath) });
});
stats.watchedPaths = watcherInfo.watchedPaths;
stats.syncDir = watcherInfo.syncDir;

server.listen(HTTP_PORT, '0.0.0.0', () => {
  const lanList = getLanInterfaces();
  console.log(`\n🌐 NovaVis L8 Pro ist im gesamten LAN freigegeben (0.0.0.0:${HTTP_PORT}):`);
  for (const iface of lanList) {
    console.log(`   • [${iface.name}] ${iface.url || `http://${iface.address}:${HTTP_PORT}`}`);
  }
  console.log(`   • [Bonjour/mDNS] http://${BONJOUR_HOST}:${HTTP_PORT}`);
  console.log(`   • [Lokal]        http://localhost:${HTTP_PORT}\n`);
});
