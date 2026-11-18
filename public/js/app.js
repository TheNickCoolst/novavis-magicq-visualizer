import {
  FIXTURE_TYPES,
  RIG_PRESETS,
  generateMagicQPatchCSV,
  buildAutoAdaptedRigFromFootprints,
} from './rigData.js';
import { StageEngine } from './stageEngine.js';
import { SHOW_CUES, ShowEngine } from './showEngine.js';

const viewport = document.getElementById('viewport');
const showEngine = new ShowEngine();

let currentRig = structuredClone(RIG_PRESETS.arena);
let selectedHeadNos = new Set();
let autoAdaptEnabled = true;
let lastAdaptedSignature = '';
let inspectedUniverse = 0;
let ws = null;
let toastTimer = null;

function showToast(msg) {
  const el = document.getElementById('liveToast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
}

const stage = new StageEngine(viewport, (headNo, additive) => {
  if (additive) {
    if (selectedHeadNos.has(headNo)) selectedHeadNos.delete(headNo);
    else selectedHeadNos.add(headNo);
  } else {
    selectedHeadNos = new Set([headNo]);
  }
  syncSelectionUI();
});

stage.loadRig(currentRig);
renderPatchTable();

// --- Selection & Live Head Inspector ---
function syncSelectionUI() {
  stage.setSelectedHeads(selectedHeadNos);
  document.getElementById('selCountTag').textContent = `${selectedHeadNos.size} gewählt`;

  const emptyEl = document.getElementById('inspectorEmpty');
  const formEl = document.getElementById('inspectorForm');

  if (selectedHeadNos.size === 1) {
    const [headNo] = selectedHeadNos;
    const fix = currentRig.fixtures.find((f) => f.headNo === headNo);
    if (fix) {
      emptyEl.classList.add('hidden');
      formEl.classList.remove('hidden');
      document.getElementById('inpFixUni').value = fix.universe + 1;
      document.getElementById('inpFixAddr').value = fix.address;
      document.getElementById('inpPosX').value = fix.pos[0];
      document.getElementById('inpPosY').value = fix.pos[1];
      document.getElementById('inpPosZ').value = fix.pos[2];
      return;
    }
  }
  emptyEl.classList.remove('hidden');
  formEl.classList.add('hidden');
}

for (const id of ['inpFixUni', 'inpFixAddr', 'inpPosX', 'inpPosY', 'inpPosZ']) {
  document.getElementById(id).addEventListener('input', () => {
    if (selectedHeadNos.size !== 1) return;
    const [headNo] = selectedHeadNos;
    const fix = currentRig.fixtures.find((f) => f.headNo === headNo);
    if (!fix) return;

    fix.universe = Math.max(0, Math.min(63, (parseInt(document.getElementById('inpFixUni').value, 10) || 1) - 1));
    fix.address = Math.max(1, Math.min(512, parseInt(document.getElementById('inpFixAddr').value, 10) || 1));
    fix.pos[0] = parseFloat(document.getElementById('inpPosX').value) || 0;
    fix.pos[1] = Math.max(0.02, parseFloat(document.getElementById('inpPosY').value) || 0.02);
    fix.pos[2] = parseFloat(document.getElementById('inpPosZ').value) || 0;

    stage.refreshFixtureLiveMetadata(headNo);
    renderPatchTable();
  });
}

document.getElementById('btnAddFixture').addEventListener('click', () => {
  const nextHead = currentRig.fixtures.reduce((m, f) => Math.max(m, f.headNo), 0) + 1;
  const usedInUni0 = currentRig.fixtures
    .filter((f) => f.universe === 0)
    .reduce((m, f) => Math.max(m, f.address + (FIXTURE_TYPES[f.type]?.channels || 16)), 1);
  const uni = usedInUni0 + 16 <= 512 ? 0 : 1;
  const addr = uni === 0 ? usedInUni0 : 125;

  const newFix = {
    headNo: nextHead,
    id: `live-head-${nextHead}`,
    name: `Live Beam ${nextHead}`,
    group: 'floor-beams',
    type: 'beam16',
    universe: uni,
    address: Math.min(497, addr),
    pos: [0, 0.45, -1.6],
    mount: 'floor',
  };
  currentRig.fixtures.push(newFix);
  stage.loadRig(currentRig);
  selectedHeadNos = new Set([nextHead]);
  syncSelectionUI();
  renderPatchTable();
  showToast(`✨ Head #${nextHead} live hinzugefügt (MagicQ U${uni + 1}.${String(newFix.address).padStart(3, '0')})`);
});

// --- Apply Live Synced Rig (from MVR, CSV, Drag-Drop, or Smart DMX Auto-Adapt) ---
function applyNewRigLive(rig, reasonText) {
  currentRig = structuredClone(rig);
  const rigSelect = document.getElementById('rigSelect');
  let customOpt = rigSelect.querySelector('option[value="custom"]');
  if (!customOpt) {
    customOpt = document.createElement('option');
    customOpt.value = 'custom';
    rigSelect.appendChild(customOpt);
  }
  customOpt.textContent = `${rig.name} (${rig.fixtures.length} Heads)`;
  rigSelect.value = 'custom';

  selectedHeadNos.clear();
  showEngine.clearProgrammer();
  stage.loadRig(currentRig);
  syncSelectionUI();
  renderPatchTable();
  showToast(reasonText);
}

// --- WebSocket Real-Time DMX, OSC & Live Rig Sync ---
function connectBridge() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  const netPill = document.getElementById('netStatusPill');
  const netText = document.getElementById('netStatusText');

  ws.addEventListener('open', () => {
    netPill.classList.add('ready');
    netText.textContent = 'Art-Net :6454 & sACN :5568 Bereit';
  });

  ws.addEventListener('message', (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(ev.data);
      if (bytes.length === 516 && bytes[0] === 0x44 && bytes[1] === 0x4d && bytes[2] === 0x58) {
        showEngine.ingestExternalUniverse(bytes[3], bytes.subarray(4, 516));
      }
      return;
    }

    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'liveRigSync' && msg.rig) {
        applyNewRigLive(msg.rig, `🔄 MagicQ Rig live synchronisiert (${msg.source} · ${msg.rig.fixtures.length} Heads)`);
      } else if (msg.type === 'osc') {
        if (msg.address.includes('bpm') && Number.isFinite(msg.arg) && msg.arg >= 40 && msg.arg <= 240) {
          showEngine.bpm = Math.round(msg.arg);
          document.getElementById('slBpm').value = showEngine.bpm;
          document.getElementById('valBpm').textContent = showEngine.bpm;
        } else if (msg.address.includes('dba')) {
          showEngine.blackout = Boolean(msg.arg);
          document.getElementById('btnBlackout').classList.toggle('active', showEngine.blackout);
        }
      } else if (msg.type === 'uiSync') {
        if (typeof msg.cue === 'number') {
          showEngine.activeCue = msg.cue;
          renderCueButtons();
        }
        if (typeof msg.blackout === 'boolean') {
          showEngine.blackout = msg.blackout;
          document.getElementById('btnBlackout').classList.toggle('active', msg.blackout);
        }
        if (typeof msg.bpm === 'number') {
          showEngine.bpm = msg.bpm;
          document.getElementById('slBpm').value = msg.bpm;
          document.getElementById('valBpm').textContent = msg.bpm;
        }
      } else if (msg.type === 'status') {
        if (msg.localIp) {
          document.getElementById('modalLocalIp').textContent = msg.localIp;
        }
        const badgeWrap = document.getElementById('lanUrlBadges');
        if (badgeWrap && Array.isArray(msg.lanUrls)) {
          const items = [...msg.lanUrls.map((u) => `${u.url} (${u.iface})`), msg.bonjourUrl].filter(Boolean);
          badgeWrap.innerHTML = items
            .map((t) => `<code style="background:rgba(56,189,248,0.14);padding:3px 8px;border-radius:5px;color:#7dd3fc;">${t}</code>`)
            .join('');
        }
        const isLive = msg.packetsPerSec > 0 || (msg.lastPacketAt && Date.now() - msg.lastPacketAt < 3200);
        netPill.classList.toggle('live', Boolean(isLive));
        netPill.classList.toggle('ready', !isLive);

        if (isLive) {
          const unis = (msg.activeUniverses || []).map((u) => `U${u + 1}`).join(',');
          netText.textContent = `LIVE ${msg.lastProtocol || 'Art-Net'} · ${unis || 'U1'} · ${msg.packetsPerSec} pkt/s`;
        } else {
          netText.textContent = `LAN ${msg.localIp}:${msg.httpPort} · Art-Net :${msg.artnetPort}`;
        }

        // Smart Zero-Export DMX Auto-Adapt: if MagicQ sends DMX on universes not covered by current rig!
        if (autoAdaptEnabled && isLive && Array.isArray(msg.footprints) && msg.footprints.length > 0 && currentRig.id !== 'custom-live') {
          const rigUnis = new Set(currentRig.fixtures.map((f) => f.universe));
          const hasUnmappedActiveUni = msg.footprints.some((fp) => !rigUnis.has(fp.universe) && fp.nonZero >= 4);
          const sig = msg.footprints.map((fp) => `${fp.universe}:${fp.firstCh}-${fp.lastCh}`).join('|');

          if (hasUnmappedActiveUni && sig !== lastAdaptedSignature) {
            lastAdaptedSignature = sig;
            const adapted = buildAutoAdaptedRigFromFootprints(msg.footprints);
            if (adapted) {
              applyNewRigLive(
                adapted,
                `🔄 Live Auto-Adapt: Bühne automatisch an MagicQ Universum ${msg.footprints.map((f) => f.universe + 1).join(', ')} angepasst!`
              );
            }
          }
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  });

  ws.addEventListener('close', () => {
    netPill.classList.remove('live', 'ready');
    netText.textContent = 'Reconnecting…';
    setTimeout(connectBridge, 1500);
  });
}

connectBridge();

// --- Drag & Drop + File Upload for .mvr / .csv / .xml ---
async function uploadPatchFile(file) {
  const buf = await file.arrayBuffer();
  const res = await fetch(`/api/import-patch?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: buf,
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    showToast(`⚠️ Import-Hinweis: ${data.error || 'Unbekanntes Format'}`);
  }
}

const dropOverlay = document.getElementById('dropOverlay');
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('hidden');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) dropOverlay.classList.add('hidden');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.add('hidden');
  const file = e.dataTransfer?.files?.[0];
  if (file) uploadPatchFile(file);
});

const filePatchInput = document.getElementById('filePatchInput');
document.getElementById('btnImportFile').addEventListener('click', () => filePatchInput.click());
filePatchInput.addEventListener('change', () => {
  if (filePatchInput.files?.[0]) {
    uploadPatchFile(filePatchInput.files[0]);
    document.getElementById('magicqModal').classList.add('hidden');
  }
});

// --- UI Controls Wiring ---
document.getElementById('rigSelect').addEventListener('change', (e) => {
  const preset = RIG_PRESETS[e.target.value];
  if (!preset) return;
  currentRig = structuredClone(preset);
  selectedHeadNos.clear();
  showEngine.clearProgrammer();
  stage.loadRig(currentRig);
  syncSelectionUI();
  renderPatchTable();
});

document.getElementById('inputModeSelect').addEventListener('change', (e) => {
  showEngine.inputMode = e.target.value;
});

document.getElementById('chkAutoAdapt').addEventListener('change', (e) => {
  autoAdaptEnabled = e.target.checked;
});

document.getElementById('selLedWall').addEventListener('change', (e) => {
  stage.setAtmosphere({ ledWallMode: Number(e.target.value) });
});

document.getElementById('slHaze').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  document.getElementById('valHaze').textContent = `${v}%`;
  stage.setAtmosphere({ hazeDensity: v / 100 });
});

document.getElementById('slHazeSpeed').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  document.getElementById('valHazeSpeed').textContent = `${v}%`;
  stage.setAtmosphere({ hazeSpeed: v / 100 });
});

document.getElementById('slBloom').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  document.getElementById('valBloom').textContent = `${v}%`;
  stage.setAtmosphere({ bloomStrength: v / 100 });
});

document.getElementById('slWorklight').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  document.getElementById('valWorklight').textContent = `${v}%`;
  stage.setAtmosphere({ worklight: v / 100 });
});

document.getElementById('chkMotorPhysics').addEventListener('change', (e) => {
  stage.setAtmosphere({ motorPhysics: e.target.checked });
});

document.getElementById('chkReflection').addEventListener('change', (e) => {
  stage.setAtmosphere({ floorReflection: e.target.checked });
});

document.getElementById('chkLabels').addEventListener('change', (e) => {
  stage.setAtmosphere({ showLabels: e.target.checked });
});

// Camera Preset Buttons
document.querySelectorAll('.cam-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cam-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    stage.setCameraPreset(btn.dataset.cam);
  });
});

// Fixture Group Buttons
document.querySelectorAll('.chip-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const grp = btn.dataset.group;
    selectedHeadNos.clear();
    currentRig.fixtures.forEach((f, idx) => {
      if (grp === 'all') selectedHeadNos.add(f.headNo);
      else if (grp === 'odd' && idx % 2 === 0) selectedHeadNos.add(f.headNo);
      else if (grp === 'even' && idx % 2 === 1) selectedHeadNos.add(f.headNo);
      else if (f.group === grp) selectedHeadNos.add(f.headNo);
    });
    syncSelectionUI();
  });
});

// --- Programmer & Interactive 2D XY Pan/Tilt Pad ---
const xyCanvas = document.getElementById('xyPad');
const xyCtx = xyCanvas.getContext('2d');
let draggingXY = false;

function ensureTargetSelection() {
  if (selectedHeadNos.size === 0) {
    currentRig.fixtures.forEach((f) => selectedHeadNos.add(f.headNo));
    syncSelectionUI();
  }
}

function drawXYPad() {
  const w = xyCanvas.width;
  const h = xyCanvas.height;
  xyCtx.clearRect(0, 0, w, h);

  xyCtx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
  xyCtx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    xyCtx.beginPath();
    xyCtx.moveTo((w * i) / 4, 0);
    xyCtx.lineTo((w * i) / 4, h);
    xyCtx.moveTo(0, (h * i) / 4);
    xyCtx.lineTo(w, (h * i) / 4);
    xyCtx.stroke();
  }

  const px = showEngine.programmerSettings.panNorm * w;
  const py = (1 - showEngine.programmerSettings.tiltNorm) * h;

  xyCtx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
  xyCtx.beginPath();
  xyCtx.moveTo(px, 0);
  xyCtx.lineTo(px, h);
  xyCtx.moveTo(0, py);
  xyCtx.lineTo(w, py);
  xyCtx.stroke();

  xyCtx.fillStyle = '#38bdf8';
  xyCtx.beginPath();
  xyCtx.arc(px, py, 6, 0, Math.PI * 2);
  xyCtx.fill();

  const panDeg = Math.round((showEngine.programmerSettings.panNorm - 0.5) * 540);
  const tiltDeg = Math.round((showEngine.programmerSettings.tiltNorm - 0.5) * 260);
  document.getElementById('xyReadout').textContent = `Pan ${panDeg >= 0 ? '+' : ''}${panDeg}° · Tilt ${tiltDeg >= 0 ? '+' : ''}${tiltDeg}°`;
}

function updateXYFromEvent(e) {
  const rect = xyCanvas.getBoundingClientRect();
  const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const ny = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
  showEngine.programmerSettings.panNorm = nx;
  showEngine.programmerSettings.tiltNorm = ny;
  ensureTargetSelection();
  showEngine.applyProgrammerToHeads(currentRig.fixtures, selectedHeadNos);
  drawXYPad();
}

xyCanvas.addEventListener('pointerdown', (e) => {
  draggingXY = true;
  xyCanvas.setPointerCapture(e.pointerId);
  updateXYFromEvent(e);
});
xyCanvas.addEventListener('pointermove', (e) => {
  if (draggingXY) updateXYFromEvent(e);
});
xyCanvas.addEventListener('pointerup', () => {
  draggingXY = false;
});
drawXYPad();

function pushProgrammerChange() {
  ensureTargetSelection();
  showEngine.applyProgrammerToHeads(currentRig.fixtures, selectedHeadNos);
}

document.getElementById('slPanFan').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  document.getElementById('valPanFan').textContent = `${v}%`;
  showEngine.programmerSettings.panFan = v / 100;
  pushProgrammerChange();
});

document.querySelectorAll('.swatch').forEach((sw) => {
  sw.addEventListener('click', () => {
    showEngine.programmerSettings.color = sw.dataset.rgb.split(',').map(Number);
    pushProgrammerChange();
  });
});

document.getElementById('colorPicker').addEventListener('input', (e) => {
  const hex = e.target.value;
  showEngine.programmerSettings.color = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  pushProgrammerChange();
});

document.getElementById('slProgDim').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  document.getElementById('valProgDim').textContent = `${Math.round((v / 255) * 100)}%`;
  showEngine.programmerSettings.dimmer = v;
  pushProgrammerChange();
});

document.getElementById('slProgStrobe').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  document.getElementById('valProgStrobe').textContent = v < 16 ? 'Open' : `${Math.round(1.4 + ((v - 16) / 229) * 20)} Hz`;
  showEngine.programmerSettings.strobe = v;
  pushProgrammerChange();
});

document.getElementById('slProgZoom').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  const deg = (2.3 + (v / 255) * 14.7).toFixed(1);
  document.getElementById('valProgZoom').textContent = `${deg}°`;
  showEngine.programmerSettings.zoomDmx = v;
  pushProgrammerChange();
});

document.getElementById('selGobo').addEventListener('change', (e) => {
  showEngine.programmerSettings.goboDmx = Number(e.target.value);
  pushProgrammerChange();
});

document.getElementById('selPrism').addEventListener('change', (e) => {
  showEngine.programmerSettings.prismDmx = Number(e.target.value);
  pushProgrammerChange();
});

document.getElementById('selFx').addEventListener('change', (e) => {
  showEngine.programmerSettings.fxType = e.target.value;
  pushProgrammerChange();
});

document.getElementById('btnClearProg').addEventListener('click', () => {
  showEngine.clearProgrammer();
});

// --- Executor Show Cues & Transport ---
const cueStrip = document.getElementById('cueStrip');
function renderCueButtons() {
  cueStrip.innerHTML = '';
  for (const cue of SHOW_CUES) {
    const btn = document.createElement('button');
    btn.className = `cue-btn ${showEngine.activeCue === cue.id ? 'active' : ''}`;
    btn.style.setProperty('--cue-color', cue.accent);
    btn.textContent = cue.name;
    btn.addEventListener('click', () => {
      showEngine.activeCue = cue.id;
      showEngine.autoCycleCues = false;
      document.getElementById('btnAutoCue').classList.remove('active');
      renderCueButtons();
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'uiSync', cue: cue.id }));
    });
    cueStrip.appendChild(btn);
  }
}
renderCueButtons();

document.getElementById('btnPlayPause').addEventListener('click', (e) => {
  showEngine.playing = !showEngine.playing;
  e.currentTarget.classList.toggle('active', showEngine.playing);
  e.currentTarget.textContent = showEngine.playing ? '⏸ Show Läuft' : '▶️ Show Pause';
});

document.getElementById('btnAutoCue').addEventListener('click', (e) => {
  showEngine.autoCycleCues = !showEngine.autoCycleCues;
  e.currentTarget.classList.toggle('active', showEngine.autoCycleCues);
});

document.getElementById('slBpm').addEventListener('input', (e) => {
  showEngine.bpm = Number(e.target.value);
  document.getElementById('valBpm').textContent = showEngine.bpm;
});

const tapTimes = [];
document.getElementById('btnTapBpm').addEventListener('click', () => {
  const now = performance.now();
  tapTimes.push(now);
  while (tapTimes.length > 5) tapTimes.shift();
  if (tapTimes.length >= 2) {
    const avgMs = (tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1);
    const bpm = Math.max(60, Math.min(185, Math.round(60000 / avgMs)));
    showEngine.bpm = bpm;
    document.getElementById('slBpm').value = bpm;
    document.getElementById('valBpm').textContent = bpm;
  }
});

document.getElementById('btnMicAudio').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    const active = await showEngine.toggleMicrophoneAudio();
    btn.classList.toggle('active', active);
  } catch {
    showToast('⚠️ Mikrofonzugriff vom Browser blockiert');
  }
});

document.getElementById('btnHighlight').addEventListener('click', (e) => {
  showEngine.highlight = !showEngine.highlight;
  e.currentTarget.classList.toggle('active', showEngine.highlight);
});

document.getElementById('btnBlackout').addEventListener('click', (e) => {
  showEngine.blackout = !showEngine.blackout;
  e.currentTarget.classList.toggle('active', showEngine.blackout);
});

document.getElementById('slGrandMaster').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  document.getElementById('valGm').textContent = `${v}%`;
  showEngine.grandMaster = v / 100;
});

// --- 512-Channel Live DMX Scope ---
const dmxDrawer = document.getElementById('dmxDrawer');
const dmxCanvas = document.getElementById('dmxCanvas');
const dmxCtx = dmxCanvas.getContext('2d');

document.getElementById('btnDmxScope').addEventListener('click', (e) => {
  const hidden = dmxDrawer.classList.toggle('hidden');
  e.currentTarget.classList.toggle('active', !hidden);
});

document.querySelectorAll('.uni-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.uni-tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    inspectedUniverse = Number(btn.dataset.uni);
  });
});

function renderDmxScope(universes) {
  if (dmxDrawer.classList.contains('hidden')) return;
  const buf = universes[inspectedUniverse];
  const w = dmxCanvas.width;
  const h = dmxCanvas.height;
  dmxCtx.clearRect(0, 0, w, h);

  const barW = w / 512;
  dmxCtx.fillStyle = '#38bdf8';
  for (let i = 0; i < 512; i++) {
    const val = buf[i];
    if (val === 0) continue;
    const bh = (val / 255) * (h - 6);
    dmxCtx.fillRect(i * barW, h - bh, Math.max(1.2, barW - 0.3), bh);
  }
}

// --- MagicQ Setup Modal, Loopback UDP Test & CSV Export ---
function triggerArtNetLoopbackTest() {
  fetch('/api/test-artnet', { method: 'POST' }).catch(() => {});
  showToast('⚡ Sende echte Art-Net 4 Pakete an UDP 127.0.0.1:6454 (6.5s Live-Test)');
}

document.getElementById('btnTestArtNet').addEventListener('click', triggerArtNetLoopbackTest);
document.getElementById('btnModalTestUdp').addEventListener('click', triggerArtNetLoopbackTest);

const magicqModal = document.getElementById('magicqModal');
document.getElementById('btnOpenMagicQModal').addEventListener('click', () => {
  renderPatchTable();
  magicqModal.classList.remove('hidden');
});
document.getElementById('btnCloseModal').addEventListener('click', () => {
  magicqModal.classList.add('hidden');
});

document.getElementById('btnDownloadCsv').addEventListener('click', () => {
  const csv = generateMagicQPatchCSV(currentRig);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `magicq-patch-${currentRig.id}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function renderPatchTable() {
  const tbody = document.getElementById('patchTableBody');
  tbody.innerHTML = '';
  for (const f of currentRig.fixtures) {
    const def = FIXTURE_TYPES[f.type];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>#${f.headNo}</td>
      <td>${f.name}</td>
      <td>${def.label}</td>
      <td>${f.universe + 1}-${String(f.address).padStart(3, '0')}</td>
      <td>0-${f.universe}</td>
      <td>${f.pos[0].toFixed(1)}, ${f.pos[1].toFixed(1)}, ${f.pos[2].toFixed(1)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// --- HUD Visibility & Keyboard Shortcuts ---
let hudVisible = true;
function toggleHud() {
  hudVisible = !hudVisible;
  document.getElementById('topbar').classList.toggle('hidden', !hudVisible);
  document.getElementById('dockLeft').classList.toggle('hidden', !hudVisible);
  document.getElementById('dockRight').classList.toggle('hidden', !hudVisible);
  document.getElementById('bottomDock').classList.toggle('hidden', !hudVisible);
  document.getElementById('btnRestoreHud').classList.toggle('hidden', hudVisible);
}
document.getElementById('btnToggleHud').addEventListener('click', toggleHud);
document.getElementById('btnRestoreHud').addEventListener('click', toggleHud);

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (['1', '2', '3', '4', '5', '6'].includes(e.key)) {
    const map = { '1': 'foh', '2': 'low', '3': 'aerial', '4': 'wingL', '5': 'booth', '6': 'orbit' };
    const btn = document.querySelector(`.cam-btn[data-cam="${map[e.key]}"]`);
    if (btn) btn.click();
  }
});

window.addEventListener('resize', () => stage.resize());

// --- Main 60–120 FPS Animation Loop + Background-Window Keepalive (for side-by-side MagicQ use) ---
let prevTime = performance.now();
let lastFrameAt = prevTime;
let fpsFrames = 0;
let fpsTimer = prevTime;
let prevRenderedCue = showEngine.activeCue;

function renderStep(now) {
  lastFrameAt = now;
  const dt = Math.min(0.05, Math.max(0.001, (now - prevTime) / 1000));
  prevTime = now;
  const timeSec = now / 1000;

  const { universes } = showEngine.computeFrame(currentRig, timeSec, selectedHeadNos);
  if (showEngine.activeCue !== prevRenderedCue) {
    prevRenderedCue = showEngine.activeCue;
    renderCueButtons();
  }

  stage.updateAndRender(universes, timeSec, dt, showEngine.lastPulse);
  renderDmxScope(universes);

  fpsFrames++;
  if (now - fpsTimer >= 600) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsTimer));
    document.getElementById('fpsBadge').textContent = `${fps} FPS`;
    fpsFrames = 0;
    fpsTimer = now;
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  renderStep(now);
}

requestAnimationFrame(animate);
setInterval(() => {
  const now = performance.now();
  if (now - lastFrameAt > 42) renderStep(now);
}, 33);
