/**
 * Built-in Console Show Engine, Programmer Overrides, FX Generator & Art-Net/sACN Merger
 */

export const SHOW_CUES = [
  { id: 0, name: '1 · Cyber Cathedral Fan', accent: '#38bdf8' },
  { id: 1, name: '2 · Prism Rave Tunnel', accent: '#e879f9' },
  { id: 2, name: '3 · Festival Amber Drop', accent: '#fb923c' },
  { id: 3, name: '4 · Ocean Tilt Wave', accent: '#2dd4bf' },
  { id: 4, name: '5 · Crimson Crossfire', accent: '#f43f5e' },
  { id: 5, name: '6 · UV Neon Ballyhoo', accent: '#a855f7' },
  { id: 6, name: '7 · Xenon Strobe Storm', accent: '#f8fafc' },
  { id: 7, name: '8 · Arena Finale Gold', accent: '#facc15' },
];

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hslToRgbBytes(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [clampByte(f(0) * 255), clampByte(f(8) * 255), clampByte(f(4) * 255)];
}

export class ShowEngine {
  constructor() {
    this.inputMode = 'auto'; // 'auto' | 'artnet' | 'internal'
    this.activeCue = 0;
    this.playing = true;
    this.autoCycleCues = false;
    this.bpm = 126;
    this.grandMaster = 1.0;
    this.blackout = false;
    this.highlight = false;

    // Audio-reactive beat energy (0..1)
    this.audioActive = false;
    this.audioEnergy = 0;
    this._audioCtx = null;
    this._analyser = null;
    this._audioBins = null;

    // DMX buffers: 64 Universes matching MagicQ PC's full free Art-Net/sACN output
    this.externalUniverses = Array.from({ length: 64 }, () => new Uint8Array(512));
    this.internalUniverses = Array.from({ length: 64 }, () => new Uint8Array(512));
    this.outputUniverses = Array.from({ length: 64 }, () => new Uint8Array(512));
    this.lastExternalPacketMs = 0;
    this.lastPulse = 0;

    // Programmer manual override state per headNo
    this.programmerOverrides = new Map();
    this.programmerSettings = {
      panNorm: 0.5,     // 0..1 (0.5 = center)
      tiltNorm: 0.58,   // 0..1 (0.5 = straight down/up, >0.5 = toward audience)
      panFan: 0.0,      // -1..+1 symmetrical fan spread
      dimmer: 255,
      strobe: 0,
      color: [0, 216, 255],
      goboDmx: 0,
      prismDmx: 0,
      zoomDmx: 28,
      fxType: 'none',   // 'none' | 'circle' | 'tiltwave' | 'fig8'
      fxSpeed: 1.0,
      fxSize: 0.25,
    };
  }

  ingestExternalUniverse(uni, bytes512) {
    if (uni >= 0 && uni < this.externalUniverses.length) {
      this.externalUniverses[uni].set(bytes512);
      this.lastExternalPacketMs = performance.now();
    }
  }

  isExternalLive() {
    return this.lastExternalPacketMs > 0 && (performance.now() - this.lastExternalPacketMs) < 3500;
  }

  clearProgrammer() {
    this.programmerOverrides.clear();
  }

  applyProgrammerToHeads(fixtures, selectedHeadNos) {
    const selected = fixtures.filter((f) => selectedHeadNos.has(f.headNo));
    const count = selected.length;
    selected.forEach((f, idx) => {
      // Normalized symmetric index in [-1 .. +1] for Pan Fanning!
      const sym = count > 1 ? (idx / (count - 1)) * 2 - 1 : 0;
      this.programmerOverrides.set(f.headNo, {
        ...this.programmerSettings,
        color: [...this.programmerSettings.color],
        symIndex: sym,
      });
    });
  }

  async toggleMicrophoneAudio() {
    if (this.audioActive) {
      this.audioActive = false;
      if (this._audioCtx) {
        await this._audioCtx.close().catch(() => {});
        this._audioCtx = null;
      }
      return false;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this._audioCtx.createMediaStreamSource(stream);
    this._analyser = this._audioCtx.createAnalyser();
    this._analyser.fftSize = 256;
    src.connect(this._analyser);
    this._audioBins = new Uint8Array(this._analyser.frequencyBinCount);
    this.audioActive = true;
    return true;
  }

  _sampleAudioEnergy() {
    if (!this.audioActive || !this._analyser || !this._audioBins) {
      this.audioEnergy = 0;
      return 0;
    }
    this._analyser.getByteFrequencyData(this._audioBins);
    // Focus on kick/bass sub-bins 1..14
    let sum = 0;
    for (let i = 1; i <= 14; i++) {
      sum += this._audioBins[i];
    }
    const norm = Math.min(1, sum / (14 * 215));
    this.audioEnergy = norm;
    return norm;
  }

  _writePanTilt16(buf, base, panNorm, tiltNorm) {
    const p16 = Math.max(0, Math.min(65535, Math.round(panNorm * 65535)));
    const t16 = Math.max(0, Math.min(65535, Math.round(tiltNorm * 65535)));
    buf[base + 0] = (p16 >> 8) & 0xff;
    buf[base + 1] = p16 & 0xff;
    buf[base + 2] = (t16 >> 8) & 0xff;
    buf[base + 3] = t16 & 0xff;
  }

  computeFrame(rig, timeSec, selectedHeadNos) {
    const beatRate = this.bpm / 60;
    const beatPos = this.playing ? timeSec * beatRate : 1.25;
    const kickEnv = Math.pow(Math.max(0, 1 - (beatPos % 1)), 2.4);
    const audioBoost = this._sampleAudioEnergy();
    const pulse = this.audioActive ? audioBoost : kickEnv;
    this.lastPulse = pulse;

    if (this.playing && this.autoCycleCues) {
      this.activeCue = Math.floor(beatPos / 16) % SHOW_CUES.length;
    }

    // Clear internal universes
    for (const u of this.internalUniverses) u.fill(0);

    const cue = this.activeCue;

    // Group counters for clean symmetric fanning
    const groupCounts = {};
    const groupIdx = {};
    for (const f of rig.fixtures) {
      groupCounts[f.group] = (groupCounts[f.group] || 0) + 1;
    }

    for (const f of rig.fixtures) {
      const idx = groupIdx[f.group] || 0;
      groupIdx[f.group] = idx + 1;
      const total = groupCounts[f.group] || 1;
      const sym = total > 1 ? (idx / (total - 1)) * 2 - 1 : 0; // -1 .. +1 left-to-right
      const isOdd = idx % 2 === 1;

      const buf = this.internalUniverses[f.universe];
      const base = f.address - 1;

      if (f.type === 'beam16') {
        const isFloor = f.mount === 'floor';
        let pan = 0.5;
        let tilt = isFloor ? 0.56 : 0.61;
        let dim = 255;
        let strobe = 0;
        let rgb = [0, 215, 255];
        let white = 0;
        let gobo = 0;
        let prism = 0;
        let zoom = 22;

        if (cue === 0) {
          // 1: Cyber Cathedral Symmetrical Fan
          pan = 0.5 - sym * 0.085 + Math.sin(beatPos * 0.5) * 0.025;
          tilt = (isFloor ? 0.59 : 0.64) + Math.cos(beatPos * 0.5 + Math.abs(sym) * 1.4) * 0.055;
          rgb = isOdd ? [220, 245, 255] : [0, 195, 255];
          gobo = 0;
          prism = 0;
          zoom = 14;
        } else if (cue === 1) {
          // 2: Prism Rave Tunnel
          const ph = beatPos * 0.85 + idx * 0.55;
          pan = 0.5 + Math.sin(ph) * 0.095;
          tilt = (isFloor ? 0.58 : 0.65) + Math.cos(ph) * 0.075;
          rgb = isOdd ? [255, 20, 210] : [0, 240, 255];
          gobo = 80;   // Starburst
          prism = 168; // Rotating 8-facet prism
          zoom = 45;
        } else if (cue === 2) {
          // 3: Festival Amber Drop
          pan = 0.5 + sym * 0.065;
          tilt = (isFloor ? 0.55 : 0.62) + Math.sin(beatPos * 1.0 + idx * 0.4) * 0.06;
          rgb = isOdd ? [255, 130, 10] : [255, 35, 15];
          dim = clampByte(175 + pulse * 80);
          gobo = 48;
          prism = isFloor ? 150 : 0;
          zoom = 30;
        } else if (cue === 3) {
          // 4: Ocean Sine Tilt Wave
          pan = 0.5 + sym * 0.04;
          tilt = (isFloor ? 0.57 : 0.61) + Math.sin(beatPos * 1.2 - idx * 0.65) * 0.11;
          rgb = hslToRgbBytes(0.48 + idx * 0.03, 0.95, 0.54);
          gobo = 48; // Tunnel ring
          prism = 0;
          zoom = 36;
        } else if (cue === 4) {
          // 5: Crimson Laser Crossfire
          pan = 0.5 + (isOdd ? -0.09 : 0.09) + Math.sin(beatPos * 0.6) * 0.02;
          tilt = isFloor ? 0.60 : 0.65;
          rgb = [255, 12, 32];
          zoom = 8; // Ultra-tight pencil beam
          strobe = (Math.floor(beatPos) % 4 === 3 && isOdd) ? 195 : 0;
        } else if (cue === 5) {
          // 6: UV Neon Ballyhoo
          const ph = beatPos * 1.35 + idx * 0.85;
          pan = 0.5 + Math.sin(ph) * 0.13;
          tilt = (isFloor ? 0.57 : 0.62) + Math.sin(ph * 2.0) * 0.08;
          rgb = isOdd ? [170, 30, 255] : [40, 255, 120];
          gobo = 112; // Cyber Triangle
          prism = 155;
          zoom = 38;
        } else if (cue === 6) {
          // 7: Xenon Strobe Storm
          pan = 0.5 - sym * 0.07;
          tilt = isFloor ? 0.62 : 0.67;
          rgb = [215, 238, 255];
          white = 255;
          strobe = 212;
          zoom = 55;
        } else {
          // 8: Arena Finale Gold + Rainbow Symmetrical Sweep
          pan = 0.5 - sym * 0.10 + Math.sin(beatPos * 0.7) * 0.05;
          tilt = (isFloor ? 0.60 : 0.65) + Math.cos(beatPos * 0.7 + Math.abs(sym) * 1.2) * 0.07;
          rgb = isFloor ? [255, 195, 45] : hslToRgbBytes(beatPos * 0.08 + Math.abs(sym) * 0.25, 0.92, 0.56);
          gobo = 80;
          prism = 165;
          zoom = 40;
        }

        this._writePanTilt16(buf, base, pan, tilt);
        buf[base + 4] = dim;
        buf[base + 5] = strobe;
        buf[base + 6] = rgb[0];
        buf[base + 7] = rgb[1];
        buf[base + 8] = rgb[2];
        buf[base + 9] = white;
        buf[base + 11] = gobo;
        buf[base + 12] = prism;
        buf[base + 13] = zoom;
      } else if (f.type === 'wash12') {
        let pan = 0.5 + sym * 0.05;
        let tilt = 0.58 + Math.sin(beatPos * 0.6 + idx * 0.5) * 0.05;
        let dim = clampByte(190 + pulse * 65);
        let strobe = cue === 6 ? 200 : 0;
        let rgb = [20, 90, 255];
        let zoom = 145;

        if (cue === 0) rgb = [18, 85, 255];
        else if (cue === 1) rgb = [160, 20, 255];
        else if (cue === 2) rgb = [255, 85, 10];
        else if (cue === 3) rgb = [0, 165, 190];
        else if (cue === 4) rgb = idx === 2 || idx === 3 ? [255, 245, 240] : [180, 10, 25];
        else if (cue === 5) rgb = isOdd ? [255, 20, 145] : [95, 20, 255];
        else if (cue === 6) rgb = [220, 240, 255];
        else rgb = [255, 165, 45];

        this._writePanTilt16(buf, base, pan, tilt);
        buf[base + 4] = dim;
        buf[base + 5] = strobe;
        buf[base + 6] = rgb[0];
        buf[base + 7] = rgb[1];
        buf[base + 8] = rgb[2];
        buf[base + 10] = zoom;
      } else if (f.type === 'pixelbar26') {
        buf[base + 0] = 255;
        buf[base + 1] = cue === 6 ? 208 : 0;
        for (let c = 0; c < 8; c++) {
          const globalPix = idx * 8 + c; // 0..31 across stage backdrop
          const wave = 0.5 + 0.5 * Math.sin(beatPos * 2.5 - globalPix * 0.32);
          let pr = 0;
          let pg = 0;
          let pb = 0;

          if (cue === 0) {
            pr = wave * 40;
            pg = wave * 200;
            pb = 90 + wave * 165;
          } else if (cue === 1 || cue === 5) {
            [pr, pg, pb] = hslToRgbBytes(beatPos * 0.18 + globalPix / 32, 0.95, 0.15 + wave * 0.42);
          } else if (cue === 2) {
            pr = 120 + wave * 135;
            pg = wave * 95;
            pb = 5;
          } else if (cue === 4) {
            const chaser = Math.abs(((beatPos * 8) % 32) - globalPix) < 3.5 ? 1 : 0.12;
            pr = 255 * chaser;
            pg = 15 * chaser;
            pb = 20 * chaser;
          } else {
            pr = wave * 255;
            pg = wave * 185;
            pb = (1 - wave) * 240;
          }

          buf[base + 2 + c * 3 + 0] = clampByte(pr);
          buf[base + 2 + c * 3 + 1] = clampByte(pg);
          buf[base + 2 + c * 3 + 2] = clampByte(pb);
        }
      } else if (f.type === 'blinder4') {
        let blinderDim = 0;
        let strobe = 0;
        let warmth = 185;
        let chase = 0;

        if (cue === 2) {
          blinderDim = clampByte(85 + pulse * 170);
          warmth = 220;
          chase = 90;
        } else if (cue === 6) {
          blinderDim = 255;
          strobe = 215;
          warmth = 30;
        } else if (cue === 7) {
          blinderDim = clampByte(110 + pulse * 145);
          warmth = 195;
        } else if (this.audioActive && pulse > 0.62) {
          blinderDim = clampByte((pulse - 0.5) * 420);
        }

        buf[base + 0] = blinderDim;
        buf[base + 1] = strobe;
        buf[base + 2] = warmth;
        buf[base + 3] = chase;
      }

      // Apply Manual Programmer Overrides (if user edited fixtures in UI)
      const ov = this.programmerOverrides.get(f.headNo);
      if (ov) {
        let pNorm = ov.panNorm - ov.symIndex * ov.panFan * 0.16;
        let tNorm = ov.tiltNorm;
        if (ov.fxType !== 'none') {
          const ph = timeSec * ov.fxSpeed * 2.4 + idx * 0.55;
          if (ov.fxType === 'circle') {
            pNorm += Math.sin(ph) * ov.fxSize * 0.22;
            tNorm += Math.cos(ph) * ov.fxSize * 0.18;
          } else if (ov.fxType === 'tiltwave') {
            tNorm += Math.sin(ph) * ov.fxSize * 0.24;
          } else if (ov.fxType === 'fig8') {
            pNorm += Math.sin(ph) * ov.fxSize * 0.24;
            tNorm += Math.sin(ph * 2) * ov.fxSize * 0.14;
          }
        }

        if (f.type === 'beam16' || f.type === 'wash12') {
          this._writePanTilt16(buf, base, Math.max(0, Math.min(1, pNorm)), Math.max(0, Math.min(1, tNorm)));
          buf[base + 4] = ov.dimmer;
          buf[base + 5] = ov.strobe;
          buf[base + 6] = ov.color[0];
          buf[base + 7] = ov.color[1];
          buf[base + 8] = ov.color[2];
          buf[base + 9] = 0;
          if (f.type === 'beam16') {
            buf[base + 11] = ov.goboDmx;
            buf[base + 12] = ov.prismDmx;
            buf[base + 13] = ov.zoomDmx;
          } else {
            buf[base + 10] = ov.zoomDmx;
          }
        } else if (f.type === 'pixelbar26') {
          buf[base + 0] = ov.dimmer;
          buf[base + 1] = ov.strobe;
          for (let c = 0; c < 8; c++) {
            buf[base + 2 + c * 3 + 0] = ov.color[0];
            buf[base + 2 + c * 3 + 1] = ov.color[1];
            buf[base + 2 + c * 3 + 2] = ov.color[2];
          }
        } else if (f.type === 'blinder4') {
          buf[base + 0] = ov.dimmer;
          buf[base + 1] = ov.strobe;
        }
      }
    }

    // Choose source universe (Live Art-Net/sACN vs Internal Show Engine)
    const useExternal =
      this.inputMode === 'artnet' || (this.inputMode === 'auto' && this.isExternalLive());

    const src = useExternal ? this.externalUniverses : this.internalUniverses;
    for (let u = 0; u < this.outputUniverses.length; u++) {
      this.outputUniverses[u].set(src[u]);
    }

    // Highlight mode (MagicQ style: selected heads go full open white for stage aiming!)
    if (this.highlight && selectedHeadNos.size > 0) {
      for (const f of rig.fixtures) {
        if (!selectedHeadNos.has(f.headNo)) continue;
        const buf = this.outputUniverses[f.universe];
        const base = f.address - 1;
        if (f.type === 'beam16' || f.type === 'wash12') {
          buf[base + 4] = 255;
          buf[base + 5] = 0;
          buf[base + 6] = 255;
          buf[base + 7] = 255;
          buf[base + 8] = 255;
        } else if (f.type === 'pixelbar26') {
          buf[base + 0] = 255;
          buf[base + 1] = 0;
          for (let i = 2; i < 26; i++) buf[base + i] = 255;
        } else if (f.type === 'blinder4') {
          buf[base + 0] = 255;
          buf[base + 1] = 0;
        }
      }
    }

    // Grand Master & Blackout scaling on Dimmer channels
    const masterScale = this.blackout ? 0 : this.grandMaster;
    if (masterScale < 0.999) {
      for (const f of rig.fixtures) {
        const buf = this.outputUniverses[f.universe];
        const base = f.address - 1;
        const dimOffset = (f.type === 'beam16' || f.type === 'wash12') ? 4 : 0;
        buf[base + dimOffset] = clampByte(buf[base + dimOffset] * masterScale);
      }
    }

    return {
      universes: this.outputUniverses,
      usingExternal: useExternal,
    };
  }
}
