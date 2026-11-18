/**
 * Fixture Personalities, Stage Rig Presets, DMX Decoders & MagicQ CSV Patch Exporter
 */

export const COLOR_WHEEL_MACROS = [
  null, // 0..15 = Use RGBW channels directly
  [1.0, 0.12, 0.12], // Red
  [1.0, 0.48, 0.05], //CTO / Deep Orange
  [1.0, 0.88, 0.10], // Canary Yellow
  [0.15, 1.0, 0.25], // Emerald Green
  [0.05, 0.92, 1.0], // Cyan / Aqua
  [0.12, 0.32, 1.0], // Congo / Primary Blue
  [0.68, 0.12, 1.0], // UV / Purple
  [1.0, 0.10, 0.72], // Magenta
  [0.85, 0.92, 1.0], // CTB Cold White
];

export const GOBO_LIST = [
  { id: 0, name: 'Open (Kein Gobo)', dmxValue: 0 },
  { id: 1, name: 'Tunnel Ring', dmxValue: 48 },
  { id: 2, name: 'Starburst 8-Ray', dmxValue: 80 },
  { id: 3, name: 'Cyber Triangle', dmxValue: 112 },
  { id: 4, name: 'Breakup Dots', dmxValue: 144 },
  { id: 5, name: 'Laser Crosshair', dmxValue: 176 },
  { id: 6, name: 'Starburst Spin', dmxValue: 220 },
];

export const FIXTURE_TYPES = {
  beam16: {
    id: 'beam16',
    label: 'Sharp Beam 16ch',
    magicqHead: 'Generic_Beam_16ch',
    channels: 16,
    channelNames: [
      'Pan', 'Pan Fine', 'Tilt', 'Tilt Fine', 'Dimmer', 'Strobe',
      'Red', 'Green', 'Blue', 'White', 'Color Macro', 'Gobo',
      'Prism', 'Zoom', 'Frost', 'Control',
    ],
  },
  wash12: {
    id: 'wash12',
    label: 'LED Moving Wash 12ch',
    magicqHead: 'Generic_Wash_RGBW_12ch',
    channels: 12,
    channelNames: [
      'Pan', 'Pan Fine', 'Tilt', 'Tilt Fine', 'Dimmer', 'Strobe',
      'Red', 'Green', 'Blue', 'White', 'Zoom', 'Macro',
    ],
  },
  pixelbar26: {
    id: 'pixelbar26',
    label: 'LED Pixel Bar 8-Cell (26ch)',
    magicqHead: 'Generic_LED_Bar_8pix_26ch',
    channels: 26,
    channelNames: [
      'Dimmer', 'Strobe',
      'R1', 'G1', 'B1', 'R2', 'G2', 'B2', 'R3', 'G3', 'B3', 'R4', 'G4', 'B4',
      'R5', 'G5', 'B5', 'R6', 'G6', 'B6', 'R7', 'G7', 'B7', 'R8', 'G8', 'B8',
    ],
  },
  blinder4: {
    id: 'blinder4',
    label: '4-Lite Audience Blinder (4ch)',
    magicqHead: 'Generic_4Lite_Blinder_4ch',
    channels: 4,
    channelNames: ['Dimmer', 'Strobe', 'Amber Warmth', 'Cell Chase'],
  },
};

function buildArenaRig() {
  const fixtures = [];
  let headNo = 1;

  // 1) Upstage Truss: 8x Sharp Beam 16ch -> Universe 0, Ch 1..128
  for (let i = 0; i < 8; i++) {
    const x = -7.0 + i * 2.0;
    fixtures.push({
      headNo: headNo++,
      id: `beam-up-${i + 1}`,
      name: `US Beam ${i + 1}`,
      group: 'upstage-beams',
      type: 'beam16',
      universe: 0,
      address: 1 + i * 16, // 1-based DMX start address
      pos: [x, 6.2, -4.1],
      mount: 'hanging',
      trussId: 'upstage',
    });
  }

  // 2) Midstage Truss: 6x LED Moving Wash 12ch -> Universe 0, Ch 129..200
  for (let i = 0; i < 6; i++) {
    const x = -6.0 + i * 2.4;
    fixtures.push({
      headNo: headNo++,
      id: `wash-mid-${i + 1}`,
      name: `MS Wash ${i + 1}`,
      group: 'mid-washes',
      type: 'wash12',
      universe: 0,
      address: 129 + i * 12,
      pos: [x, 6.5, -0.3],
      mount: 'hanging',
      trussId: 'midstage',
    });
  }

  // 3) Floor Deck Package: 6x Sharp Beam 16ch -> Universe 0, Ch 201..296
  const floorX = [-6.2, -4.1, -2.1, 2.1, 4.1, 6.2];
  for (let i = 0; i < 6; i++) {
    fixtures.push({
      headNo: headNo++,
      id: `beam-floor-${i + 1}`,
      name: `Deck Beam ${i + 1}`,
      group: 'floor-beams',
      type: 'beam16',
      universe: 0,
      address: 201 + i * 16,
      pos: [floorX[i], 0.02, -3.2],
      mount: 'floor',
      trussId: 'floor',
    });
  }

  // 4) Upstage Backdrop LED Pixel Bars: 4x 8-Cell Bar 26ch -> Universe 1, Ch 1..104
  for (let i = 0; i < 4; i++) {
    const x = -5.4 + i * 3.6;
    fixtures.push({
      headNo: headNo++,
      id: `pixbar-${i + 1}`,
      name: `Pixel Bar ${i + 1}`,
      group: 'pixel-bars',
      type: 'pixelbar26',
      universe: 1,
      address: 1 + i * 26,
      pos: [x, 3.6, -4.7],
      mount: 'wall',
      trussId: 'backdrop',
    });
  }

  // 5) Downstage Truss Audience Blinders: 4x 4-Lite Blinder -> Universe 1, Ch 105..120
  for (let i = 0; i < 4; i++) {
    const x = -5.1 + i * 3.4;
    fixtures.push({
      headNo: headNo++,
      id: `blinder-${i + 1}`,
      name: `DS Blinder ${i + 1}`,
      group: 'blinders',
      type: 'blinder4',
      universe: 1,
      address: 105 + i * 4,
      pos: [x, 6.6, 3.8],
      mount: 'front',
      trussId: 'downstage',
    });
  }

  return {
    id: 'arena',
    name: 'Festival Arena Rig (28 Heads)',
    trusses: [
      { id: 'upstage', pos: [0, 6.45, -4.1], length: 16.0, axis: 'x' },
      { id: 'midstage', pos: [0, 6.75, -0.3], length: 14.8, axis: 'x' },
      { id: 'downstage', pos: [0, 6.85, 3.8], length: 14.8, axis: 'x' },
      { id: 'tower-l', pos: [-7.8, 3.35, -4.1], length: 6.7, axis: 'y' },
      { id: 'tower-r', pos: [7.8, 3.35, -4.1], length: 6.7, axis: 'y' },
      { id: 'tower-fl', pos: [-7.2, 3.45, 3.8], length: 6.9, axis: 'y' },
      { id: 'tower-fr', pos: [7.2, 3.45, 3.8], length: 6.9, axis: 'y' },
    ],
    fixtures,
  };
}

function buildClubRig() {
  const fixtures = [];
  let headNo = 1;

  // Overhead Side Tunnel Beams (Left & Right Z-axis runs): 8x Beam 16ch -> Univ 0, Ch 1..128
  for (let i = 0; i < 4; i++) {
    const z = -3.4 + i * 2.2;
    fixtures.push({
      headNo: headNo++,
      id: `club-beam-l-${i + 1}`,
      name: `Tunnel L${i + 1}`,
      group: 'upstage-beams',
      type: 'beam16',
      universe: 0,
      address: 1 + i * 16,
      pos: [-4.6, 5.4, z],
      mount: 'hanging',
    });
  }
  for (let i = 0; i < 4; i++) {
    const z = -3.4 + i * 2.2;
    fixtures.push({
      headNo: headNo++,
      id: `club-beam-r-${i + 1}`,
      name: `Tunnel R${i + 1}`,
      group: 'upstage-beams',
      type: 'beam16',
      universe: 0,
      address: 65 + i * 16,
      pos: [4.6, 5.4, z],
      mount: 'hanging',
    });
  }

  // Upstage Center Arch Washes: 6x Wash 12ch -> Univ 0, Ch 129..200
  for (let i = 0; i < 6; i++) {
    const x = -4.5 + i * 1.8;
    fixtures.push({
      headNo: headNo++,
      id: `club-wash-${i + 1}`,
      name: `Booth Wash ${i + 1}`,
      group: 'mid-washes',
      type: 'wash12',
      universe: 0,
      address: 129 + i * 12,
      pos: [x, 5.6, -3.9],
      mount: 'hanging',
    });
  }

  // Floor Deck Beams around DJ Booth: 6x Beam 16ch -> Univ 0, Ch 201..296
  const fx = [-5.4, -3.5, -1.8, 1.8, 3.5, 5.4];
  for (let i = 0; i < 6; i++) {
    fixtures.push({
      headNo: headNo++,
      id: `club-floor-${i + 1}`,
      name: `Floor Beam ${i + 1}`,
      group: 'floor-beams',
      type: 'beam16',
      universe: 0,
      address: 201 + i * 16,
      pos: [fx[i], 0.02, -2.5],
      mount: 'floor',
    });
  }

  // Backdrop Pixel Bars & Blinders
  for (let i = 0; i < 4; i++) {
    fixtures.push({
      headNo: headNo++,
      id: `club-pix-${i + 1}`,
      name: `LED Matrix ${i + 1}`,
      group: 'pixel-bars',
      type: 'pixelbar26',
      universe: 1,
      address: 1 + i * 26,
      pos: [-4.8 + i * 3.2, 2.9, -4.6],
      mount: 'wall',
    });
  }
  for (let i = 0; i < 4; i++) {
    fixtures.push({
      headNo: headNo++,
      id: `club-blinder-${i + 1}`,
      name: `Crowd Strobe ${i + 1}`,
      group: 'blinders',
      type: 'blinder4',
      universe: 1,
      address: 105 + i * 4,
      pos: [-4.2 + i * 2.8, 5.5, 3.4],
      mount: 'front',
    });
  }

  return {
    id: 'club',
    name: 'Cyber Club Tunnel (28 Heads)',
    trusses: [
      { id: 'club-l', pos: [-4.6, 5.65, -0.1], length: 8.6, axis: 'z' },
      { id: 'club-r', pos: [4.6, 5.65, -0.1], length: 8.6, axis: 'z' },
      { id: 'club-back', pos: [0, 5.85, -3.9], length: 10.6, axis: 'x' },
      { id: 'club-front', pos: [0, 5.75, 3.4], length: 10.6, axis: 'x' },
    ],
    fixtures,
  };
}

function buildTheaterRig() {
  const fixtures = [];
  let headNo = 1;

  // Tiered Chevron / Curved Concert Truss: 8x Beam 16ch
  for (let i = 0; i < 8; i++) {
    const x = -6.3 + i * 1.8;
    const archY = 5.4 + (1 - Math.abs(x) / 7.0) * 1.6;
    fixtures.push({
      headNo: headNo++,
      id: `th-beam-${i + 1}`,
      name: `Arch Spot ${i + 1}`,
      group: 'upstage-beams',
      type: 'beam16',
      universe: 0,
      address: 1 + i * 16,
      pos: [x, archY, -3.8],
      mount: 'hanging',
    });
  }

  for (let i = 0; i < 6; i++) {
    const x = -5.5 + i * 2.2;
    fixtures.push({
      headNo: headNo++,
      id: `th-wash-${i + 1}`,
      name: `Key Wash ${i + 1}`,
      group: 'mid-washes',
      type: 'wash12',
      universe: 0,
      address: 129 + i * 12,
      pos: [x, 6.3, 1.2],
      mount: 'hanging',
    });
  }

  const sidePositions = [
    [-6.6, 0.02, -1.8], [-5.2, 0.02, -3.3], [-2.5, 0.02, -3.6],
    [2.5, 0.02, -3.6], [5.2, 0.02, -3.3], [6.6, 0.02, -1.8],
  ];
  for (let i = 0; i < 6; i++) {
    fixtures.push({
      headNo: headNo++,
      id: `th-floor-${i + 1}`,
      name: `Stage Floor ${i + 1}`,
      group: 'floor-beams',
      type: 'beam16',
      universe: 0,
      address: 201 + i * 16,
      pos: sidePositions[i],
      mount: 'floor',
    });
  }

  for (let i = 0; i < 4; i++) {
    fixtures.push({
      headNo: headNo++,
      id: `th-pix-${i + 1}`,
      name: `Cyc Bar ${i + 1}`,
      group: 'pixel-bars',
      type: 'pixelbar26',
      universe: 1,
      address: 1 + i * 26,
      pos: [-5.1 + i * 3.4, 4.2, -4.65],
      mount: 'wall',
    });
  }

  for (let i = 0; i < 4; i++) {
    fixtures.push({
      headNo: headNo++,
      id: `th-blinder-${i + 1}`,
      name: `Warm Molefay ${i + 1}`,
      group: 'blinders',
      type: 'blinder4',
      universe: 1,
      address: 105 + i * 4,
      pos: [-4.8 + i * 3.2, 6.4, 3.6],
      mount: 'front',
    });
  }

  return {
    id: 'theater',
    name: 'Concert Symphonic Arch (28 Heads)',
    trusses: [
      { id: 'th-back', pos: [0, 7.1, -3.8], length: 14.4, axis: 'x' },
      { id: 'th-mid', pos: [0, 6.55, 1.2], length: 13.6, axis: 'x' },
      { id: 'th-front', pos: [0, 6.65, 3.6], length: 13.6, axis: 'x' },
    ],
    fixtures,
  };
}

export const RIG_PRESETS = {
  arena: buildArenaRig(),
  club: buildClubRig(),
  theater: buildTheaterRig(),
};

/**
 * Compute Shutter/Strobe multiplier (0 or 1) from standard DMX shutter byte:
 *   0..7   = Open (1.0) -> friendly immediate output when bringing up Dimmer in MagicQ!
 *   8..15  = Closed (0.0)
 *   16..245 = Strobe 1.2 Hz .. 22 Hz
 *   246..255 = Open (1.0)
 */
function evalStrobeGate(strobeByte, timeSec, seed = 0) {
  if (strobeByte <= 7 || strobeByte >= 246) return 1.0;
  if (strobeByte <= 15) return 0.0;
  const norm = (strobeByte - 16) / 229;
  const freqHz = 1.4 + norm * 20.6;
  const cycle = (timeSec * freqHz + seed * 0.13) % 1.0;
  // Crisp xenon/LED strobe duty cycle (28% on)
  return cycle < 0.28 ? 1.0 : 0.0;
}

/**
 * Decode raw 512-byte DMX universe buffer into normalized physical rendering state for a fixture.
 */
export function decodeFixtureState(fixture, universes, timeSec) {
  const buf = universes[fixture.universe] || universes[0];
  const chNeed = FIXTURE_TYPES[fixture.type]?.channels || 16;
  const base = Math.max(0, Math.min(512 - chNeed, (fixture.address || 1) - 1));

  if (fixture.type === 'beam16') {
    const pan16 = ((buf[base + 0] << 8) | buf[base + 1]) / 65535; // 0..1
    const tilt16 = ((buf[base + 2] << 8) | buf[base + 3]) / 65535; // 0..1
    const dimmer = buf[base + 4] / 255;
    const strobeGate = evalStrobeGate(buf[base + 5], timeSec, fixture.headNo);

    let r = buf[base + 6] / 255;
    let g = buf[base + 7] / 255;
    let b = buf[base + 8] / 255;
    const w = buf[base + 9] / 255;
    const colorMacro = buf[base + 10];

    if (colorMacro >= 16) {
      const idx = Math.min(COLOR_WHEEL_MACROS.length - 1, 1 + Math.floor(((colorMacro - 16) / 240) * (COLOR_WHEEL_MACROS.length - 1)));
      const macro = COLOR_WHEEL_MACROS[idx];
      if (macro) {
        [r, g, b] = macro;
      }
    } else {
      r = Math.min(1, r + w * 0.92);
      g = Math.min(1, g + w * 0.94);
      b = Math.min(1, b + w);
    }

    const goboByte = buf[base + 11];
    let goboIndex = 0;
    let goboSpinSpeed = 0;
    if (goboByte >= 32 && goboByte < 64) goboIndex = 1;
    else if (goboByte >= 64 && goboByte < 96) goboIndex = 2;
    else if (goboByte >= 96 && goboByte < 128) goboIndex = 3;
    else if (goboByte >= 128 && goboByte < 160) goboIndex = 4;
    else if (goboByte >= 160 && goboByte < 192) goboIndex = 5;
    else if (goboByte >= 192) {
      goboIndex = 2;
      goboSpinSpeed = 0.8 + ((goboByte - 192) / 63) * 4.5;
    }

    const prismByte = buf[base + 12];
    const prismActive = prismByte >= 32;
    let prismRotSpeed = 0;
    if (prismByte >= 128 && prismByte < 190) {
      prismRotSpeed = 0.4 + ((prismByte - 128) / 62) * 3.0;
    } else if (prismByte >= 190) {
      prismRotSpeed = -(0.4 + ((prismByte - 190) / 65) * 3.0);
    }

    const zoomNorm = buf[base + 13] / 255; // 0 = tight 2.3 deg, 1 = 17 deg
    const frostNorm = buf[base + 14] / 255;
    const coneAngleDeg = 2.3 + zoomNorm * 14.7 + frostNorm * 6.0;

    return {
      panRad: (pan16 - 0.5) * Math.PI * 3.0,   // -270 deg .. +270 deg
      tiltRad: (tilt16 - 0.5) * Math.PI * 1.45, // -130 deg .. +130 deg
      intensity: dimmer * strobeGate,
      dimmer,
      color: [r, g, b],
      goboIndex,
      goboSpinSpeed,
      prismActive,
      prismRotSpeed,
      coneAngleDeg,
      edgeSoftness: 1.35 + frostNorm * 1.9,
    };
  }

  if (fixture.type === 'wash12') {
    const pan16 = ((buf[base + 0] << 8) | buf[base + 1]) / 65535;
    const tilt16 = ((buf[base + 2] << 8) | buf[base + 3]) / 65535;
    const dimmer = buf[base + 4] / 255;
    const strobeGate = evalStrobeGate(buf[base + 5], timeSec, fixture.headNo);

    const w = buf[base + 9] / 255;
    const r = Math.min(1, buf[base + 6] / 255 + w * 0.92);
    const g = Math.min(1, buf[base + 7] / 255 + w * 0.94);
    const b = Math.min(1, buf[base + 8] / 255 + w);

    const zoomNorm = buf[base + 10] / 255;
    const coneAngleDeg = 15.0 + zoomNorm * 32.0;

    return {
      panRad: (pan16 - 0.5) * Math.PI * 3.0,
      tiltRad: (tilt16 - 0.5) * Math.PI * 1.45,
      intensity: dimmer * strobeGate,
      dimmer,
      color: [r, g, b],
      goboIndex: 0,
      goboSpinSpeed: 0,
      prismActive: false,
      prismRotSpeed: 0,
      coneAngleDeg,
      edgeSoftness: 2.55,
    };
  }

  if (fixture.type === 'pixelbar26') {
    const dimmer = buf[base + 0] / 255;
    const strobeGate = evalStrobeGate(buf[base + 1], timeSec, fixture.headNo);
    const master = dimmer * strobeGate;
    const cells = [];
    let avgR = 0;
    let avgG = 0;
    let avgB = 0;

    for (let c = 0; c < 8; c++) {
      const cr = (buf[base + 2 + c * 3 + 0] / 255) * master;
      const cg = (buf[base + 2 + c * 3 + 1] / 255) * master;
      const cb = (buf[base + 2 + c * 3 + 2] / 255) * master;
      cells.push([cr, cg, cb]);
      avgR += cr;
      avgG += cg;
      avgB += cb;
    }

    return {
      intensity: master,
      dimmer,
      cells,
      color: [avgR / 8, avgG / 8, avgB / 8],
    };
  }

  // blinder4
  const dimmer = buf[base + 0] / 255;
  const strobeGate = evalStrobeGate(buf[base + 1], timeSec, fixture.headNo);
  const warmth = buf[base + 2] / 255; // 0 = crisp 3200K halogen, 1 = deep 2200K amber glow
  const chase = buf[base + 3] / 255;
  const intensity = dimmer * strobeGate;

  // Authentic tungsten thermal amber curve: dimmer low values shift warmer orange-amber
  const thermalShift = (1.0 - dimmer) * 0.45 + warmth * 0.45;
  const r = 1.0;
  const g = Math.max(0.38, 0.86 - thermalShift * 0.42);
  const b = Math.max(0.08, 0.62 - thermalShift * 0.54);

  const cellMults = [1, 1, 1, 1];
  if (chase > 0.06) {
    const rate = 1.5 + chase * 10.0;
    for (let c = 0; c < 4; c++) {
      cellMults[c] = 0.35 + 0.65 * Math.max(0, Math.sin(timeSec * rate + c * 1.57));
    }
  }

  return {
    intensity,
    dimmer,
    color: [r, g, b],
    cellMults,
  };
}

/**
 * Generate a ready-to-import CSV patch sheet for ChamSys MagicQ
 * (Patch -> View Heads -> Import CSV / Reference Sheet).
 */
export function generateMagicQPatchCSV(rig) {
  const lines = [
    'Head No,Name,Type,Channels,MagicQ DMX Address,Art-Net Port-Address,Pos X (m),Pos Y (m),Pos Z (m)',
  ];
  for (const f of rig.fixtures) {
    const def = FIXTURE_TYPES[f.type];
    const mqUni = f.universe + 1; // MagicQ uses 1-based Universe numbers (Uni 1 = Art-Net 0-0)
    const mqAddr = `${mqUni}-${String(f.address).padStart(3, '0')}`;
    const artNetAddr = `0-${f.universe}`;
    lines.push(
      `${f.headNo},"${f.name}",${def.magicqHead},${def.channels},${mqAddr},${artNetAddr},${f.pos[0].toFixed(2)},${f.pos[1].toFixed(2)},${f.pos[2].toFixed(2)}`
    );
  }
  return lines.join('\n');
}

/**
 * Smart Live DMX Auto-Adapter:
 * Given active incoming MagicQ universe footprints [{ universe, firstCh, lastCh, nonZero }],
 * dynamically builds/remaps a symmetrical 3D stage rig onto those exact active universes & channels!
 */
export function buildAutoAdaptedRigFromFootprints(footprints) {
  if (!footprints || footprints.length === 0) return null;

  // If the primary active universes match our Arena rig's Universe 0/1 layout, remap Arena rig's base universe cleanly
  const primaryUni = footprints[0].universe;
  const secondaryUni = footprints[1] ? footprints[1].universe : primaryUni + 1;

  // Clone Arena rig and remap universes & active channel span dynamically
  const baseArena = RIG_PRESETS.arena;
  const maxSpan = footprints[0].lastCh - footprints[0].firstCh + 1;

  if (footprints[0].firstCh === 1 && maxSpan >= 190) {
    return {
      id: 'auto-adapted',
      name: `Live Auto-Adapt (MagicQ Uni ${primaryUni + 1}–${secondaryUni + 1})`,
      trusses: baseArena.trusses.map((t) => ({ ...t, pos: [...t.pos] })),
      fixtures: baseArena.fixtures.map((f) => ({
        ...f,
        pos: [...f.pos],
        universe: f.universe === 0 ? primaryUni : secondaryUni,
      })),
    };
  }

  // Otherwise synthesize exact 16ch Moving Heads covering every active 16-channel block across active universes!
  const fixtures = [];
  let headNo = 1;
  for (const fp of footprints) {
    const startAddr = Math.max(1, Math.floor((fp.firstCh - 1) / 16) * 16 + 1);
    const count = Math.max(2, Math.min(16, Math.ceil((fp.lastCh - startAddr + 1) / 16)));

    for (let i = 0; i < count; i++) {
      const addr = startAddr + i * 16;
      if (addr + 15 > 512) break;
      const isFloor = i >= 8;
      const rowIdx = isFloor ? i - 8 : i;
      const rowCount = isFloor ? Math.max(1, count - 8) : Math.min(8, count);
      const x = rowCount > 1 ? -6.4 + (rowIdx / (rowCount - 1)) * 12.8 : 0;

      fixtures.push({
        headNo: headNo++,
        id: `auto-h-${fp.universe}-${addr}`,
        name: `MQ U${fp.universe + 1}.${String(addr).padStart(3, '0')}`,
        group: isFloor ? 'floor-beams' : 'upstage-beams',
        type: 'beam16',
        universe: fp.universe,
        address: addr,
        pos: isFloor ? [Number(x.toFixed(2)), 0.02, -3.1] : [Number(x.toFixed(2)), 6.25, -3.9],
        mount: isFloor ? 'floor' : 'hanging',
      });
    }
  }

  return {
    id: 'auto-adapted',
    name: `MagicQ Auto-Sense (${fixtures.length} Heads)`,
    trusses: [
      { id: 'upstage', pos: [0, 6.5, -3.9], length: 15.6, axis: 'x' },
      { id: 'downstage', pos: [0, 6.8, 3.8], length: 14.8, axis: 'x' },
    ],
    fixtures,
  };
}
