import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

/**
 * Minimal spec-compliant ZIP reader (using built-in node:zlib) to extract
 * GeneralSceneDescription.xml from ChamSys MagicQ .mvr exports (DIN SPEC 15801).
 */
export function extractXmlFromMvrBuffer(buf) {
  // Check PK\x03\x04 ZIP magic; if already plain XML, return directly
  if (buf.length >= 4 && buf[0] === 0x3c) {
    return buf.toString('utf8');
  }
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Ungültiges MVR/ZIP-Archiv');
  }

  // Locate End of Central Directory (EOCD: 0x06054b50)
  let eocdOffset = -1;
  const minSearch = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minSearch; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('ZIP Central Directory in MVR nicht gefunden');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let ptr = cdOffset;
  for (let e = 0; e < totalEntries && ptr + 46 <= buf.length; e++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const fileName = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    if (fileName.toLowerCase().endsWith('.xml')) {
      const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
      const slice = buf.subarray(dataStart, dataStart + compSize);

      if (method === 0) {
        return slice.toString('utf8');
      }
      if (method === 8) {
        return zlib.inflateRawSync(slice).toString('utf8');
      }
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error('Keine GeneralSceneDescription.xml in der MVR-Datei gefunden');
}

function classifyFixtureType(hintStr, channelsHint = 0) {
  const s = (hintStr || '').toLowerCase();
  if (s.includes('blinder') || s.includes('mole') || s.includes('2lite') || s.includes('4lite') || channelsHint === 4) {
    return 'blinder4';
  }
  if (s.includes('bar') || s.includes('batten') || s.includes('pixel') || s.includes('strip') || channelsHint >= 20) {
    return 'pixelbar26';
  }
  if (s.includes('wash') || s.includes('aura') || s.includes('spiider') || s.includes('k10') || s.includes('k20') || channelsHint === 12) {
    return 'wash12';
  }
  return 'beam16';
}

function defaultPositionForIndex(idx, total, type) {
  if (type === 'pixelbar26') {
    const x = -5.4 + (idx % 4) * 3.6;
    return { pos: [x, 3.6, -4.7], mount: 'wall', group: 'pixel-bars' };
  }
  if (type === 'blinder4') {
    const x = -5.1 + (idx % 4) * 3.4;
    return { pos: [x, 6.6, 3.8], mount: 'front', group: 'blinders' };
  }
  if (type === 'wash12') {
    const span = Math.max(1, Math.min(8, total));
    const col = idx % span;
    const x = span > 1 ? -6.0 + (col / (span - 1)) * 12.0 : 0;
    return { pos: [x, 6.5, -0.3], mount: 'hanging', group: 'mid-washes' };
  }
  // beam16: alternate upstage truss & floor deck if many heads
  if (idx >= 8) {
    const fIdx = idx - 8;
    const x = -6.2 + (fIdx % 6) * 2.48;
    return { pos: [x, 0.02, -3.1], mount: 'floor', group: 'floor-beams' };
  }
  const x = -7.0 + (idx % 8) * 2.0;
  return { pos: [x, 6.2, -4.1], mount: 'hanging', group: 'upstage-beams' };
}

/**
 * Parse MVR GeneralSceneDescription.xml into a NovaVis 3D Rig object.
 * MVR coordinates are in millimeters (X right, Y depth, Z up).
 */
export function parseMvrXmlToRig(xmlText, sourceName = 'MagicQ MVR Live Import') {
  const fixtures = [];
  const fixtureRegex = /<Fixture\b([^>]*)>([\s\S]*?)<\/Fixture>/gi;
  let match;
  let headCounter = 1;

  while ((match = fixtureRegex.exec(xmlText)) !== null) {
    const attrs = match[1];
    const body = match[2];

    const nameMatch = /name="([^"]*)"/i.exec(attrs);
    const name = nameMatch ? nameMatch[1] : `Head ${headCounter}`;

    const gdtfSpec = (/<GDTFSpec>([^<]*)<\/GDTFSpec>/i.exec(body)?.[1] || '').trim();
    const gdtfMode = (/<GDTFMode>([^<]*)<\/GDTFMode>/i.exec(body)?.[1] || '').trim();
    const fixIdNum = Number(/<FixtureID>(\d+)<\/FixtureID>/i.exec(body)?.[1] || headCounter);

    // Parse MVR <Matrix>{u1,u2,u3}{v1,v2,v3}{w1,w2,w3}{tx,ty,tz}</Matrix>
    let pos = null;
    let mount = 'hanging';
    const matStr = /<Matrix>([^<]+)<\/Matrix>/i.exec(body)?.[1];
    if (matStr) {
      const groups = [...matStr.matchAll(/\{([^}]+)\}/g)];
      if (groups.length >= 4) {
        const wVec = groups[2][1].split(',').map(Number);
        const tVec = groups[3][1].split(',').map(Number);
        if (tVec.length === 3 && tVec.every((n) => Number.isFinite(n))) {
          // Convert MVR mm (X, Y-depth, Z-up) -> Three.js meters (X, Y-up, -Z)
          const xm = Math.max(-8.2, Math.min(8.2, tVec[0] / 1000));
          const ym = Math.max(0.02, Math.min(8.5, tVec[2] / 1000));
          const zm = Math.max(-4.8, Math.min(4.5, -tVec[1] / 1000));
          pos = [Number(xm.toFixed(2)), Number(ym.toFixed(2)), Number(zm.toFixed(2))];
          mount = ym < 0.85 || (wVec[2] && wVec[2] < -0.5) ? 'floor' : 'hanging';
        }
      }
    }

    // Parse MVR <Address break="0">absoluteOrDot</Address>
    let universe = 0;
    let address = 1;
    const addrRaw = (/<Address[^>]*>([^<]+)<\/Address>/i.exec(body)?.[1] || '').trim();
    if (addrRaw.includes('.')) {
      const [uStr, aStr] = addrRaw.split('.');
      universe = Math.max(0, ( parseInt(uStr, 10) || 1 ) - 1);
      address = Math.max(1, Math.min(512, parseInt(aStr, 10) || 1));
    } else if (addrRaw) {
      const abs = Math.max(1, parseInt(addrRaw, 10) || 1);
      universe = Math.floor((abs - 1) / 512);
      address = ((abs - 1) % 512) + 1;
    }

    const chMatch = /(\d+)\s*ch/i.exec(`${gdtfMode} ${gdtfSpec} ${name}`);
    const chHint = chMatch ? Number(chMatch[1]) : 0;
    const type = classifyFixtureType(`${name} ${gdtfSpec} ${gdtfMode}`, chHint);
    const fallback = defaultPositionForIndex(fixtures.length, 24, type);

    fixtures.push({
      headNo: fixIdNum || headCounter,
      id: `mvr-${headCounter}`,
      name,
      group: fallback.group,
      type,
      universe: Math.min(63, universe),
      address,
      pos: pos || fallback.pos,
      mount: pos ? mount : fallback.mount,
    });
    headCounter++;
  }

  if (fixtures.length === 0) {
    throw new Error('Keine <Fixture>-Einträge in der MVR-Datei gefunden');
  }

  return buildTrussesAroundFixtures(fixtures, sourceName);
}

/**
 * Parse MagicQ CSV Patch file (supports both native MagicQ "Export CSV" format
 * with "1-001" DMX notation and NovaVis extended CSV with X/Y/Z positions).
 */
export function parseMagicQCsvToRig(csvText, sourceName = 'MagicQ CSV Live Patch') {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length < 2) {
    throw new Error('CSV-Patchdatei enthält keine Fixture-Zeilen');
  }

  const parseRow = (row) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if ((ch === ',' || ch === ';') && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const headers = parseRow(lines[0]).map((h) => h.toLowerCase());
  const findCol = (...keys) => headers.findIndex((h) => keys.some((k) => h.includes(k)));

  const idxHead = findCol('head', 'nr', 'no', 'id');
  const idxName = findCol('name', 'label', 'head name');
  const idxType = findCol('type', 'model', 'mode', 'head type', 'fixture');
  const idxCh = findCol('chan', 'chans', 'footprint');
  const idxDmx = findCol('dmx', 'addr', 'magicq');
  const idxPosX = findCol('pos x', 'posx', 'x (m)', 'x');
  const idxPosY = findCol('pos y', 'posy', 'y (m)', 'y');
  const idxPosZ = findCol('pos z', 'posz', 'z (m)', 'z');

  const fixtures = [];

  for (let r = 1; r < lines.length; r++) {
    const cols = parseRow(lines[r]);
    if (cols.length < 2) continue;

    const headNo = Number(cols[idxHead >= 0 ? idxHead : 0]) || r;
    const name = cols[idxName >= 0 ? idxName : 1] || `Head ${headNo}`;
    const typeStr = idxType >= 0 ? cols[idxType] : name;
    const chHint = idxCh >= 0 ? Number(cols[idxCh]) || 0 : 0;
    const dmxStr = (idxDmx >= 0 ? cols[idxDmx] : cols.find((c) => /^\d+[-./:]\d+$/.test(c))) || '1-001';

    let universe = 0;
    let address = 1;
    const dmxParts = dmxStr.split(/[-./:]/);
    if (dmxParts.length >= 2) {
      // MagicQ uses 1-based universes ("1-001" = Art-Net 0-0, Ch 1)
      universe = Math.max(0, (parseInt(dmxParts[0], 10) || 1) - 1);
      address = Math.max(1, Math.min(512, parseInt(dmxParts[1], 10) || 1));
    } else {
      address = Math.max(1, Math.min(512, parseInt(dmxStr, 10) || 1));
    }

    const type = classifyFixtureType(`${name} ${typeStr}`, chHint);
    const fallback = defaultPositionForIndex(fixtures.length, lines.length - 1, type);

    let pos = fallback.pos;
    let mount = fallback.mount;
    if (idxPosX >= 0 && idxPosY >= 0 && idxPosZ >= 0) {
      const px = parseFloat(cols[idxPosX]);
      const py = parseFloat(cols[idxPosY]);
      const pz = parseFloat(cols[idxPosZ]);
      if (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz)) {
        pos = [px, py, pz];
        mount = type === 'pixelbar26' ? 'wall' : type === 'blinder4' ? 'front' : py < 0.85 ? 'floor' : 'hanging';
      }
    }

    fixtures.push({
      headNo,
      id: `csv-${headNo}-${r}`,
      name,
      group: fallback.group,
      type,
      universe: Math.min(63, universe),
      address,
      pos,
      mount,
    });
  }

  if (fixtures.length === 0) {
    throw new Error('Keine gültigen Fixtures in der CSV-Datei erkannt');
  }

  return buildTrussesAroundFixtures(fixtures, sourceName);
}

function buildTrussesAroundFixtures(fixtures, rigName) {
  // Group elevated fixtures by approximate Z depth to synthesize realistic aluminum box trusses!
  const elevated = fixtures.filter((f) => f.pos[1] >= 1.8 && f.mount !== 'wall');
  const zClusters = [];

  for (const f of elevated) {
    const existing = zClusters.find((c) => Math.abs(c.z - f.pos[2]) < 1.1);
    if (existing) {
      existing.minX = Math.min(existing.minX, f.pos[0]);
      existing.maxX = Math.max(existing.maxX, f.pos[0]);
      existing.maxY = Math.max(existing.maxY, f.pos[1]);
    } else {
      zClusters.push({
        z: f.pos[2],
        minX: f.pos[0],
        maxX: f.pos[0],
        maxY: f.pos[1],
      });
    }
  }

  const trusses = zClusters.map((c, idx) => {
    const span = Math.max(6.0, c.maxX - c.minX + 2.2);
    const centerX = (c.minX + c.maxX) * 0.5;
    return {
      id: `auto-truss-${idx + 1}`,
      pos: [Number(centerX.toFixed(2)), Number((c.maxY + 0.25).toFixed(2)), Number(c.z.toFixed(2))],
      length: Number(span.toFixed(2)),
      axis: 'x',
    };
  });

  if (trusses.length === 0) {
    trusses.push(
      { id: 'upstage', pos: [0, 6.45, -4.1], length: 16.0, axis: 'x' },
      { id: 'downstage', pos: [0, 6.85, 3.8], length: 14.8, axis: 'x' }
    );
  }

  return {
    id: 'custom-live',
    name: rigName,
    trusses,
    fixtures,
  };
}

/**
 * Parse any buffer (.mvr, .xml, .csv) into a live NovaVis rig.
 */
export function parseAnyPatchFile(buffer, fileName = 'patch.csv') {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.mvr') || (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50)) {
    const xml = extractXmlFromMvrBuffer(buffer);
    return parseMvrXmlToRig(xml, `MVR Sync: ${path.basename(fileName)}`);
  }
  if (lower.endsWith('.xml') || buffer.toString('utf8', 0, 80).includes('<GeneralSceneDescription')) {
    return parseMvrXmlToRig(buffer.toString('utf8'), `MVR XML: ${path.basename(fileName)}`);
  }
  return parseMagicQCsvToRig(buffer.toString('utf8'), `MagicQ Patch: ${path.basename(fileName)}`);
}

/**
 * Watch MagicQ show folders & local ./magicq-sync directory so exporting a
 * .mvr or .csv in MagicQ immediately hot-reloads the 3D stage in NovaVis!
 */
export async function setupMagicQLiveFolderWatchers(workspaceDir, onRigImported) {
  const syncDir = path.join(workspaceDir, 'magicq-sync');
  await fsp.mkdir(syncDir, { recursive: true });

  const home = os.homedir();
  const candidateDirs = [
    syncDir,
    path.join(home, 'Documents', 'MagicQ', 'show'),
    path.join(home, 'MagicQ', 'show'),
  ];
  if (process.platform === 'win32') {
    const env = process.env;
    // OneDrive often redirects "Documents" on Windows
    if (env.OneDrive) candidateDirs.push(path.join(env.OneDrive, 'Documents', 'MagicQ', 'show'));
    if (env.PUBLIC) candidateDirs.push(path.join(env.PUBLIC, 'Documents', 'MagicQ', 'show'));
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      candidateDirs.push(path.join(pf, 'ChamSys Ltd', 'MagicQ PC', 'show'));
    }
  }
  // Manual override: MAGICQ_SHOW_DIR=<folder> (multiple separated by path delimiter)
  if (process.env.MAGICQ_SHOW_DIR) {
    candidateDirs.push(...process.env.MAGICQ_SHOW_DIR.split(path.delimiter).filter(Boolean));
  }

  const watchedSet = new Set();
  const watchedPaths = [];
  const debounceMap = new Map();

  async function tryAttachWatchers() {
    for (const dir of candidateDirs) {
      if (watchedSet.has(dir)) continue;
      try {
        const stat = await fsp.stat(dir);
        if (!stat.isDirectory()) continue;

        fs.watch(dir, { persistent: false }, (eventType, filename) => {
          if (!filename) return;
          const lower = filename.toLowerCase();
          if (!lower.endsWith('.mvr') && !lower.endsWith('.csv') && !lower.endsWith('.xml')) return;

          const fullPath = path.join(dir, filename);
          clearTimeout(debounceMap.get(fullPath));
          debounceMap.set(
            fullPath,
            setTimeout(async () => {
              try {
                const buf = await fsp.readFile(fullPath);
                if (buf.length < 12) return;
                const rig = parseAnyPatchFile(buf, filename);
                onRigImported(rig, fullPath);
              } catch (err) {
                console.warn(`[LiveSync] Konnte ${filename} nicht parsen:`, err.message);
              }
            }, 220)
          );
        });

        watchedSet.add(dir);
        watchedPaths.push(dir);
      } catch {
        // Directory doesn't exist yet (will auto-attach once MagicQ creates ~/Documents/MagicQ/show)
      }
    }
  }

  await tryAttachWatchers();
  setInterval(tryAttachWatchers, 5000).unref();

  return { syncDir, watchedPaths };
}
