import * as THREE from 'three';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';
import { Reflector } from '/vendor/three/examples/jsm/objects/Reflector.js';
import { EffectComposer } from '/vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '/vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '/vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '/vendor/three/examples/jsm/postprocessing/OutputPass.js';

import {
  VOLUMETRIC_VERTEX_SHADER,
  VOLUMETRIC_FRAGMENT_SHADER,
  COOKIE_VERTEX_SHADER,
  COOKIE_FRAGMENT_SHADER,
  LED_WALL_VERTEX_SHADER,
  LED_WALL_FRAGMENT_SHADER,
} from './shaders.js';
import { decodeFixtureState } from './rigData.js';

export const CAMERA_PRESETS = {
  foh: { name: 'FOH Front', pos: [0, 4.2, 16.2], target: [0, 2.7, -1.2] },
  low: { name: 'Stage Lip Low', pos: [0, 1.15, 9.8], target: [0, 3.2, -2.5] },
  aerial: { name: 'Aerial Birdseye', pos: [11.5, 11.2, 13.0], target: [0, 2.2, -1.0] },
  wingL: { name: 'Side Wing Left', pos: [-11.2, 3.4, 5.4], target: [0.8, 2.6, -1.8] },
  booth: { name: 'DJ / Artist POV', pos: [0, 2.35, -3.5], target: [0, 2.5, 8.0] },
  orbit: { name: 'Auto-Orbit Cinema', pos: [0, 4.6, 15.8], target: [0, 2.7, -1.2], autoOrbit: true },
};

function createStageDeckGridTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0e1117';
  ctx.fillRect(0, 0, 512, 512);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.065)';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, 508, 508);
  ctx.beginPath();
  ctx.moveTo(0, 256);
  ctx.lineTo(512, 256);
  ctx.moveTo(256, 0);
  ctx.lineTo(256, 512);
  ctx.stroke();

  for (let i = 0; i < 900; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const w = 10 + Math.random() * 45;
    ctx.fillStyle = `rgba(255,255,255,${(Math.random() * 0.018).toFixed(4)})`;
    ctx.fillRect(x, y, w, 1);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 5);
  tex.anisotropy = 4;
  return tex;
}

function renderLabelCanvas(canvas, text, subtext) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = 'rgba(9, 13, 22, 0.86)';
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(8, 8, 240, 80, 14);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 25px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(text.slice(0, 16), 128, 43);

  ctx.fillStyle = '#38bdf8';
  ctx.font = '20px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(subtext, 128, 73);
}

function createLabelSprite(text, subtext) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  renderLabelCanvas(canvas, text, subtext);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.15, 0.44, 1);
  sprite.userData.labelCanvas = canvas;
  sprite.userData.labelTex = tex;
  return sprite;
}

export class StageEngine {
  constructor(container, onSelectFixture) {
    this.container = container;
    this.onSelectFixture = onSelectFixture;

    this.atmosphere = {
      hazeDensity: 0.88,
      hazeSpeed: 0.9,
      bloomStrength: 0.54,
      worklight: 0.14,
      floorReflection: true,
      showLabels: false,
      motorPhysics: true,
      ledWallMode: 1,
      ledWallBrightness: 0.68,
    };

    this.selectedHeadNos = new Set();
    this.fixtureNodes = [];
    this.volumetricMeshes = [];
    this.rigGroup = new THREE.Group();
    this.cookieGroup = new THREE.Group();
    this.labelSprites = [];
    this.autoOrbit = false;
    this.camTransition = null;

    this._tmpVecA = new THREE.Vector3();
    this._tmpVecB = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._drawBufferSize = new THREE.Vector2();

    this._initRendererAndScene();
    this._buildStageArchitecture();
    this._initDynamicClusterLights();
    this._bindInteraction();
  }

  _initRendererAndScene() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x04060b);
    this.scene.fog = new THREE.FogExp2(0x050811, 0.021);

    this.camera = new THREE.PerspectiveCamera(46, w / h, 0.2, 90);
    this.camera.position.set(0, 4.2, 16.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 2.7, -1.2);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.maxDistance = 38;
    this.controls.minDistance = 2.0;
    this.controls.maxPolarAngle = Math.PI * 0.53;
    this.controls.update();

    // Post-processing HDR pipeline tuned for saturated L8 beam colors + crisp white cores
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), this.atmosphere.bloomStrength, 0.48, 0.42);
    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);

    this.sharedConeGeom = new THREE.CylinderGeometry(1, 1, 1, 44, 1, true);
    this.sharedConeGeom.translate(0, -0.5, 0);

    this.sharedCookieGeom = new THREE.PlaneGeometry(2, 2);
    this.sharedCookieGeom.rotateX(-Math.PI / 2);

    this.scene.add(this.rigGroup);
    this.scene.add(this.cookieGroup);
  }

  _buildStageArchitecture() {
    const arch = new THREE.Group();

    this.hemiLight = new THREE.HemisphereLight(0x2a3958, 0x090b10, 0.28 + this.atmosphere.worklight * 1.6);
    this.scene.add(this.hemiLight);

    this.workDirLight = new THREE.DirectionalLight(0xa5b8d8, this.atmosphere.worklight * 1.8);
    this.workDirLight.position.set(5, 14, 10);
    this.scene.add(this.workDirLight);

    // Arena Pit Floor (y = -0.95)
    const pitGeo = new THREE.PlaneGeometry(68, 68);
    pitGeo.rotateX(-Math.PI / 2);
    const pitMesh = new THREE.Mesh(
      pitGeo,
      new THREE.MeshStandardMaterial({ color: 0x06080d, roughness: 0.86, metalness: 0.15 })
    );
    pitMesh.position.y = -0.95;
    arch.add(pitMesh);

    // Real-time Planar Stage Reflector
    const reflGeo = new THREE.PlaneGeometry(17.2, 9.6);
    this.stageReflector = new Reflector(reflGeo, {
      clipBias: 0.003,
      textureWidth: 1024,
      textureHeight: 1024,
      color: 0x262e3e,
    });
    this.stageReflector.rotation.x = -Math.PI / 2;
    this.stageReflector.position.set(0, -0.003, -0.2);
    arch.add(this.stageReflector);

    // Semi-glossy Stage Deck over Reflector
    const deckTex = createStageDeckGridTexture();
    const deckSurfaceGeo = new THREE.PlaneGeometry(17.2, 9.6);
    deckSurfaceGeo.rotateX(-Math.PI / 2);
    this.deckSurfaceMat = new THREE.MeshStandardMaterial({
      map: deckTex,
      color: 0x131720,
      roughness: 0.3,
      metalness: 0.48,
      transparent: true,
      opacity: 0.77,
    });
    const deckSurface = new THREE.Mesh(deckSurfaceGeo, this.deckSurfaceMat);
    deckSurface.position.set(0, 0.0, -0.2);
    arch.add(deckSurface);

    const plinthMat = new THREE.MeshStandardMaterial({ color: 0x0b0e15, roughness: 0.7, metalness: 0.3 });
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(17.24, 0.94, 9.64), plinthMat);
    plinth.position.set(0, -0.48, -0.2);
    arch.add(plinth);

    const lip = new THREE.Mesh(
      new THREE.BoxGeometry(17.22, 0.035, 0.05),
      new THREE.MeshBasicMaterial({ color: 0x1e3a5f })
    );
    lip.position.set(0, 0.01, 4.6);
    arch.add(lip);

    // Center Artist / DJ Riser + Booth Silhouette
    const riserMat = new THREE.MeshStandardMaterial({ color: 0x121722, roughness: 0.36, metalness: 0.58 });
    const riser = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.42, 2.3), riserMat);
    riser.position.set(0, 0.21, -2.55);
    arch.add(riser);

    const boothDesk = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.95, 0.74), riserMat);
    boothDesk.position.set(0, 0.88, -2.3);
    arch.add(boothDesk);

    const boothLedStrip = new THREE.Mesh(
      new THREE.BoxGeometry(2.05, 0.08, 0.04),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
    );
    boothLedStrip.position.set(0, 1.16, -1.92);
    this.boothAccentMesh = boothLedStrip;
    arch.add(boothLedStrip);

    // Stage Access Stairs
    for (const side of [-1, 1]) {
      for (let s = 0; s < 3; s++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.28, 0.36), plinthMat);
        step.position.set(side * 6.8, -0.81 + s * 0.28, 5.35 - s * 0.35);
        arch.add(step);
      }
    }

    // Upstage Acoustic Backdrop Wall
    const backWall = new THREE.Mesh(
      new THREE.BoxGeometry(17.2, 7.3, 0.25),
      new THREE.MeshStandardMaterial({ color: 0x0a0e17, roughness: 0.64, metalness: 0.35 })
    );
    backWall.position.set(0, 3.55, -5.12);
    arch.add(backWall);

    // L8-Style Center Upstage SMD LED Video Wall (7.8m x 3.5m)
    const ledFrame = new THREE.Mesh(new THREE.BoxGeometry(8.05, 3.72, 0.14), riserMat);
    ledFrame.position.set(0, 3.15, -4.92);
    arch.add(ledFrame);

    this.ledWallMat = new THREE.ShaderMaterial({
      vertexShader: LED_WALL_VERTEX_SHADER,
      fragmentShader: LED_WALL_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uBeatPulse: { value: 0 },
        uPrimaryColor: { value: new THREE.Color(0x00d8ff) },
        uMode: { value: this.atmosphere.ledWallMode },
        uBrightness: { value: this.atmosphere.ledWallBrightness },
      },
    });
    this.ledWallMesh = new THREE.Mesh(new THREE.PlaneGeometry(7.8, 3.5), this.ledWallMat);
    this.ledWallMesh.position.set(0, 3.15, -4.83);
    arch.add(this.ledWallMesh);

    // Audience Front Crowd Barrier
    const barrier = new THREE.Mesh(
      new THREE.BoxGeometry(16.8, 1.05, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x161b26, roughness: 0.5, metalness: 0.6 })
    );
    barrier.position.set(0, -0.42, 6.2);
    arch.add(barrier);

    this.scene.add(arch);
  }

  _initDynamicClusterLights() {
    this.clusterLights = [];
    const positions = [
      [0, 5.2, -3.5],
      [-4.8, 4.8, -0.5],
      [4.8, 4.8, -0.5],
      [0, 3.2, -4.2],
      [0, 5.5, 3.8],
    ];
    for (const p of positions) {
      const pl = new THREE.PointLight(0xffffff, 0, 19, 1.55);
      pl.position.set(p[0], p[1], p[2]);
      this.scene.add(pl);
      this.clusterLights.push(pl);
    }
  }

  _createBoxTruss(length, axis = 'x') {
    const group = new THREE.Group();
    const chordMat = new THREE.MeshStandardMaterial({
      color: 0x7c8798,
      roughness: 0.32,
      metalness: 0.82,
    });
    const span = 0.16;
    const offsets = [
      [-span, -span],
      [span, -span],
      [-span, span],
      [span, span],
    ];

    const chordGeo = new THREE.CylinderGeometry(0.022, 0.022, length, 8);
    for (const [ox, oy] of offsets) {
      const chord = new THREE.Mesh(chordGeo, chordMat);
      chord.position.set(ox, 0, oy);
      group.add(chord);
    }

    const rungs = Math.max(2, Math.floor(length / 0.85));
    const rungGeo = new THREE.BoxGeometry(span * 2, 0.018, span * 2);
    const rungMat = new THREE.MeshStandardMaterial({
      color: 0x5c6675,
      roughness: 0.45,
      metalness: 0.75,
      wireframe: true,
    });
    for (let i = 0; i <= rungs; i++) {
      const y = -length / 2 + (i / rungs) * length;
      const rung = new THREE.Mesh(rungGeo, rungMat);
      rung.position.set(0, y, 0);
      group.add(rung);
    }

    if (axis === 'x') group.rotation.z = Math.PI / 2;
    else if (axis === 'z') group.rotation.x = Math.PI / 2;
    return group;
  }

  _createVolumetricMaterial(edgePower = 1.5) {
    return new THREE.ShaderMaterial({
      vertexShader: VOLUMETRIC_VERTEX_SHADER,
      fragmentShader: VOLUMETRIC_FRAGMENT_SHADER,
      uniforms: {
        uTopRadius: { value: 0.09 },
        uBottomRadius: { value: 0.9 },
        uLength: { value: 14.0 },
        uColor: { value: new THREE.Color(0x00d8ff) },
        uIntensity: { value: 0.0 },
        uHazeDensity: { value: this.atmosphere.hazeDensity },
        uHazeSpeed: { value: this.atmosphere.hazeSpeed },
        uEdgePower: { value: edgePower },
        uTime: { value: 0 },
        uGoboIndex: { value: 0 },
        uGoboRot: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }

  _createCookieMaterial(softness = 1.6) {
    return new THREE.ShaderMaterial({
      vertexShader: COOKIE_VERTEX_SHADER,
      fragmentShader: COOKIE_FRAGMENT_SHADER,
      uniforms: {
        uColor: { value: new THREE.Color(0x00d8ff) },
        uIntensity: { value: 0.0 },
        uGoboIndex: { value: 0 },
        uGoboRot: { value: 0 },
        uSoftness: { value: softness },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  loadRig(rig) {
    while (this.rigGroup.children.length > 0) {
      this.rigGroup.remove(this.rigGroup.children[0]);
    }
    while (this.cookieGroup.children.length > 0) {
      this.cookieGroup.remove(this.cookieGroup.children[0]);
    }
    this.fixtureNodes = [];
    this.volumetricMeshes = [];
    this.labelSprites = [];

    for (const t of rig.trusses) {
      const truss = this._createBoxTruss(t.length, t.axis);
      truss.position.set(t.pos[0], t.pos[1], t.pos[2]);
      this.rigGroup.add(truss);
    }

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1a202c,
      roughness: 0.42,
      metalness: 0.65,
    });

    for (const fix of rig.fixtures) {
      const root = new THREE.Group();
      root.position.set(fix.pos[0], fix.pos[1], fix.pos[2]);
      root.userData.headNo = fix.headNo;

      const selRing = new THREE.Mesh(
        new THREE.RingGeometry(0.28, 0.34, 28),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.92, depthWrite: false })
      );
      selRing.rotation.x = -Math.PI / 2;
      selRing.position.y = fix.mount === 'hanging' ? 0.12 : 0.03;
      selRing.visible = this.selectedHeadNos.has(fix.headNo);
      root.add(selRing);

      const mqAddr = `U${fix.universe + 1}.${String(fix.address).padStart(3, '0')}`;
      const label = createLabelSprite(`#${fix.headNo} ${fix.name}`, mqAddr);
      label.position.set(0, fix.mount === 'hanging' ? 0.52 : 0.72, 0);
      label.visible = this.atmosphere.showLabels;
      root.add(label);
      this.labelSprites.push(label);

      const node = {
        fixture: fix,
        root,
        selRing,
        labelSprite: label,
        goboAngle: 0,
        prismAngle: 0,
        // Physical lamp solver state (motor inertia & tungsten thermal glow)
        curPanRad: null,
        curTiltRad: null,
        thermalDim: 0,
      };

      if (fix.type === 'beam16' || fix.type === 'wash12') {
        const isWash = fix.type === 'wash12';
        const signY = fix.mount === 'hanging' ? -1 : 1;

        const baseMesh = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.11, 0.28), bodyMat);
        baseMesh.position.y = signY * 0.055;
        baseMesh.userData.headNo = fix.headNo;
        root.add(baseMesh);

        const yokeGroup = new THREE.Group();
        yokeGroup.position.y = signY * 0.11;
        root.add(yokeGroup);

        for (const sx of [-0.15, 0.15]) {
          const arm = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.28, 0.07), bodyMat);
          arm.position.set(sx, signY * 0.14, 0);
          arm.userData.headNo = fix.headNo;
          yokeGroup.add(arm);
        }

        const headGroup = new THREE.Group();
        headGroup.position.y = signY * 0.24;
        yokeGroup.add(headGroup);

        const headRadius = isWash ? 0.145 : 0.115;
        const headLen = isWash ? 0.24 : 0.34;
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(headRadius * 0.92, headRadius, headLen, 20), bodyMat);
        barrel.userData.headNo = fix.headNo;
        headGroup.add(barrel);

        const lensMat = new THREE.MeshBasicMaterial({ color: 0x05070a });
        const lens = new THREE.Mesh(new THREE.CircleGeometry(headRadius * 0.88, 24), lensMat);
        lens.rotation.x = Math.PI / 2;
        lens.position.y = -headLen / 2 - 0.004;
        lens.userData.headNo = fix.headNo;
        headGroup.add(lens);

        const coneMat = this._createVolumetricMaterial(isWash ? 2.4 : 1.45);
        coneMat.uniforms.uTopRadius.value = isWash ? 0.13 : 0.082;
        coneMat.uniforms.uLength.value = isWash ? 13.5 : 17.5;
        const mainCone = new THREE.Mesh(this.sharedConeGeom, coneMat);
        mainCone.position.y = -headLen / 2;
        mainCone.frustumCulled = false;
        headGroup.add(mainCone);
        this.volumetricMeshes.push(mainCone);

        let prismGroup = null;
        const prismMats = [];
        if (!isWash) {
          prismGroup = new THREE.Group();
          prismGroup.position.y = -headLen / 2;
          prismGroup.visible = false;
          const facets = 6;
          const splayRad = THREE.MathUtils.degToRad(5.6);
          for (let f = 0; f < facets; f++) {
            const ang = (f / facets) * Math.PI * 2;
            const pMat = this._createVolumetricMaterial(1.4);
            pMat.uniforms.uTopRadius.value = 0.055;
            pMat.uniforms.uBottomRadius.value = 0.52;
            pMat.uniforms.uLength.value = 17.0;
            const subCone = new THREE.Mesh(this.sharedConeGeom, pMat);
            subCone.frustumCulled = false;
            subCone.rotation.z = Math.cos(ang) * splayRad;
            subCone.rotation.x = Math.sin(ang) * splayRad;
            prismGroup.add(subCone);
            prismMats.push(pMat);
            this.volumetricMeshes.push(subCone);
          }
          headGroup.add(prismGroup);
        }

        const cookieMat = this._createCookieMaterial(isWash ? 2.2 : 1.35);
        const cookieMesh = new THREE.Mesh(this.sharedCookieGeom, cookieMat);
        cookieMesh.visible = false;
        this.cookieGroup.add(cookieMesh);

        Object.assign(node, {
          yokeGroup,
          headGroup,
          lensMat,
          mainCone,
          coneMat,
          prismGroup,
          prismMats,
          cookieMesh,
          cookieMat,
          headLen,
        });
      } else if (fix.type === 'pixelbar26') {
        const barBody = new THREE.Mesh(new THREE.BoxGeometry(2.65, 0.14, 0.14), bodyMat);
        barBody.userData.headNo = fix.headNo;
        root.add(barBody);

        const cellMats = [];
        for (let c = 0; c < 8; c++) {
          const cx = -1.12 + c * 0.32;
          const cMat = new THREE.MeshBasicMaterial({ color: 0x05070a });
          const cellMesh = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.095, 0.03), cMat);
          cellMesh.position.set(cx, 0, 0.072);
          cellMesh.userData.headNo = fix.headNo;
          root.add(cellMesh);
          cellMats.push(cMat);
        }

        const glowMat = this._createCookieMaterial(2.4);
        const glowPlane = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.8), glowMat);
        glowPlane.position.set(0, -0.4, -0.18);
        root.add(glowPlane);
        this.volumetricMeshes.push(glowPlane);

        Object.assign(node, { cellMats, glowMat });
      } else if (fix.type === 'blinder4') {
        const pod = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.18), bodyMat);
        pod.rotation.x = 0.35;
        pod.userData.headNo = fix.headNo;
        root.add(pod);

        const cellMats = [];
        const offsets = [
          [-0.14, 0.14], [0.14, 0.14],
          [-0.14, -0.14], [0.14, -0.14],
        ];
        for (const [ox, oy] of offsets) {
          const cMat = new THREE.MeshBasicMaterial({ color: 0x0b0907 });
          const lens = new THREE.Mesh(new THREE.CircleGeometry(0.115, 20), cMat);
          lens.position.set(ox, oy, 0.095);
          lens.userData.headNo = fix.headNo;
          pod.add(lens);
          cellMats.push(cMat);
        }

        const coneMat = this._createVolumetricMaterial(2.8);
        coneMat.uniforms.uTopRadius.value = 0.26;
        coneMat.uniforms.uBottomRadius.value = 4.6;
        coneMat.uniforms.uLength.value = 9.5;
        const floodCone = new THREE.Mesh(this.sharedConeGeom, coneMat);
        floodCone.rotation.x = -Math.PI * 0.38;
        floodCone.frustumCulled = false;
        root.add(floodCone);
        this.volumetricMeshes.push(floodCone);

        Object.assign(node, { cellMats, coneMat, floodCone });
      }

      this.rigGroup.add(root);
      this.fixtureNodes.push(node);
    }
  }

  /**
   * Live update a fixture's 3D coordinates & DMX address label on the fly without reloading the scene!
   */
  refreshFixtureLiveMetadata(headNo) {
    const node = this.fixtureNodes.find((n) => n.fixture.headNo === headNo);
    if (!node) return;
    const fix = node.fixture;
    node.root.position.set(fix.pos[0], fix.pos[1], fix.pos[2]);
    const mqAddr = `U${fix.universe + 1}.${String(fix.address).padStart(3, '0')}`;
    renderLabelCanvas(node.labelSprite.userData.labelCanvas, `#${fix.headNo} ${fix.name}`, mqAddr);
    node.labelSprite.userData.labelTex.needsUpdate = true;
  }

  setSelectedHeads(headNosIter) {
    this.selectedHeadNos = new Set(headNosIter);
    for (const n of this.fixtureNodes) {
      n.selRing.visible = this.selectedHeadNos.has(n.fixture.headNo);
    }
  }

  setAtmosphere(partial) {
    Object.assign(this.atmosphere, partial);
    this.bloomPass.strength = this.atmosphere.bloomStrength;
    this.hemiLight.intensity = 0.25 + this.atmosphere.worklight * 1.8;
    this.workDirLight.intensity = this.atmosphere.worklight * 2.0;
    this.stageReflector.visible = Boolean(this.atmosphere.floorReflection);
    this.deckSurfaceMat.opacity = this.atmosphere.floorReflection ? 0.77 : 0.98;
    this.ledWallMat.uniforms.uMode.value = Number(this.atmosphere.ledWallMode);
    this.ledWallMat.uniforms.uBrightness.value = Number(this.atmosphere.ledWallBrightness);
    for (const s of this.labelSprites) {
      s.visible = Boolean(this.atmosphere.showLabels);
    }
  }

  setCameraPreset(key) {
    const preset = CAMERA_PRESETS[key];
    if (!preset) return;
    this.autoOrbit = Boolean(preset.autoOrbit);
    this.camTransition = {
      startPos: this.camera.position.clone(),
      endPos: new THREE.Vector3(...preset.pos),
      startTarget: this.controls.target.clone(),
      endTarget: new THREE.Vector3(...preset.target),
      progress: 0,
    };
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  _bindInteraction() {
    let downX = 0;
    let downY = 0;

    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
      if (this.autoOrbit) this.autoOrbit = false;
    });

    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      this._raycaster.setFromCamera(this._pointer, this.camera);
      const hits = this._raycaster.intersectObjects(this.rigGroup.children, true);
      for (const hit of hits) {
        if (hit.object.geometry === this.sharedConeGeom) continue;
        let cur = hit.object;
        while (cur) {
          if (cur.userData && cur.userData.headNo) {
            if (this.onSelectFixture) {
              this.onSelectFixture(cur.userData.headNo, e.shiftKey || e.metaKey);
            }
            return;
          }
          cur = cur.parent;
        }
      }
    });
  }

  _stepMotorAngle(cur, target, maxSpeedRadPerSec, smoothFactor, dt) {
    if (cur === null || !this.atmosphere.motorPhysics) return target;
    const diff = target - cur;
    const desiredStep = diff * Math.min(1, dt * smoothFactor);
    const maxStep = maxSpeedRadPerSec * dt;
    return cur + THREE.MathUtils.clamp(desiredStep, -maxStep, maxStep);
  }

  updateAndRender(universes, timeSec, dt, beatPulse = 0) {
    if (this.camTransition) {
      this.camTransition.progress = Math.min(1, this.camTransition.progress + dt * 2.8);
      const ease = 1 - Math.pow(1 - this.camTransition.progress, 3);
      this.camera.position.lerpVectors(this.camTransition.startPos, this.camTransition.endPos, ease);
      this.controls.target.lerpVectors(this.camTransition.startTarget, this.camTransition.endTarget, ease);
      if (this.camTransition.progress >= 1) this.camTransition = null;
    } else if (this.autoOrbit) {
      const ang = timeSec * 0.22;
      this.camera.position.x = Math.sin(ang) * 15.6;
      this.camera.position.z = Math.cos(ang) * 14.2 + 1.5;
      this.camera.position.y = 4.1 + Math.sin(timeSec * 0.41) * 1.6;
    }
    this.controls.update();

    const acc = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];

    for (const node of this.fixtureNodes) {
      const fix = node.fixture;
      const state = decodeFixtureState(fix, universes, timeSec);

      if (fix.type === 'beam16' || fix.type === 'wash12') {
        const isWash = fix.type === 'wash12';

        // L8-style physical Pan/Tilt motor inertia (Sharpy beams whip faster than wash heads)
        const maxVel = isWash ? 5.4 : 8.2;
        const spring = isWash ? 11.0 : 15.5;
        node.curPanRad = this._stepMotorAngle(node.curPanRad, state.panRad, maxVel, spring, dt);
        node.curTiltRad = this._stepMotorAngle(node.curTiltRad, state.tiltRad, maxVel, spring, dt);

        node.yokeGroup.rotation.y = node.curPanRad;
        node.headGroup.rotation.x = fix.mount === 'hanging' ? -node.curTiltRad : Math.PI + node.curTiltRad;

        const [r, g, b] = state.color;
        const lum = Math.max(r, g, b, 0.001);
        const effIntensity = state.intensity * Math.min(1.15, (r + g + b) * 0.65);

        const lensBoost = effIntensity > 0.01 ? 0.25 + effIntensity * 2.6 : 0.03;
        node.lensMat.color.setRGB(
          Math.max(0.02, r * lensBoost),
          Math.max(0.025, g * lensBoost),
          Math.max(0.035, b * lensBoost)
        );

        const beamLen = isWash ? 13.5 : 17.5;
        const halfAngleRad = THREE.MathUtils.degToRad(state.coneAngleDeg * 0.5);
        const bottomRadius = Math.max(0.16, Math.tan(halfAngleRad) * beamLen);

        if (state.goboSpinSpeed) node.goboAngle += state.goboSpinSpeed * dt;
        else node.goboAngle = 0;

        const u = node.coneMat.uniforms;
        u.uColor.value.setRGB(r / lum, g / lum, b / lum);
        u.uBottomRadius.value = bottomRadius;
        u.uHazeDensity.value = this.atmosphere.hazeDensity;
        u.uHazeSpeed.value = this.atmosphere.hazeSpeed;
        u.uEdgePower.value = state.edgeSoftness;
        u.uTime.value = timeSec;
        u.uGoboIndex.value = state.goboIndex;
        u.uGoboRot.value = node.goboAngle;

        if (node.prismGroup && state.prismActive && effIntensity > 0.005) {
          node.prismGroup.visible = true;
          node.prismAngle += state.prismRotSpeed * dt;
          node.prismGroup.rotation.y = node.prismAngle;
          u.uIntensity.value = effIntensity * 0.34;

          for (const pMat of node.prismMats) {
            pMat.uniforms.uColor.value.copy(u.uColor.value);
            pMat.uniforms.uIntensity.value = effIntensity * 0.62;
            pMat.uniforms.uBottomRadius.value = Math.max(0.24, bottomRadius * 0.55);
            pMat.uniforms.uHazeDensity.value = this.atmosphere.hazeDensity;
            pMat.uniforms.uHazeSpeed.value = this.atmosphere.hazeSpeed;
            pMat.uniforms.uTime.value = timeSec;
            pMat.uniforms.uGoboIndex.value = state.goboIndex;
            pMat.uniforms.uGoboRot.value = node.goboAngle;
          }
        } else {
          if (node.prismGroup) node.prismGroup.visible = false;
          u.uIntensity.value = effIntensity;
        }

        node.headGroup.updateWorldMatrix(true, false);
        this._tmpVecA.set(0, -node.headLen / 2, 0).applyMatrix4(node.headGroup.matrixWorld);
        node.headGroup.getWorldQuaternion(this._tmpQuat);
        this._tmpVecB.set(0, -1, 0).applyQuaternion(this._tmpQuat).normalize();

        if (effIntensity > 0.015 && this._tmpVecB.y < -0.08) {
          const hitDist = (0.006 - this._tmpVecA.y) / this._tmpVecB.y;
          if (hitDist > 0.2 && hitDist < 22.0) {
            const hitX = this._tmpVecA.x + this._tmpVecB.x * hitDist;
            const hitZ = this._tmpVecA.z + this._tmpVecB.z * hitDist;
            if (Math.abs(hitX) <= 8.55 && hitZ >= -4.95 && hitZ <= 4.55) {
              const spotRad = Math.max(0.2, Math.tan(halfAngleRad) * hitDist * (state.prismActive ? 2.1 : 1.15));
              node.cookieMesh.visible = true;
              node.cookieMesh.position.set(hitX, 0.006, hitZ);
              node.cookieMesh.scale.set(spotRad, 1, spotRad / Math.max(0.38, Math.abs(this._tmpVecB.y)));
              node.cookieMesh.rotation.y = Math.atan2(this._tmpVecB.x, this._tmpVecB.z);
              node.cookieMat.uniforms.uColor.value.copy(u.uColor.value);
              node.cookieMat.uniforms.uIntensity.value = effIntensity * Math.min(1, 7.5 / (hitDist + 3.0));
              node.cookieMat.uniforms.uGoboIndex.value = state.goboIndex;
              node.cookieMat.uniforms.uGoboRot.value = node.goboAngle;
            } else {
              node.cookieMesh.visible = false;
            }
          } else {
            node.cookieMesh.visible = false;
          }
        } else {
          node.cookieMesh.visible = false;
        }

        const bucket = fix.pos[0] < -1.5 ? 1 : fix.pos[0] > 1.5 ? 2 : 0;
        acc[bucket][0] += r * state.intensity;
        acc[bucket][1] += g * state.intensity;
        acc[bucket][2] += b * state.intensity;
        acc[bucket][3] += 1;
      } else if (fix.type === 'pixelbar26') {
        for (let c = 0; c < 8; c++) {
          const [cr, cg, cb] = state.cells[c];
          node.cellMats[c].color.setRGB(
            Math.max(0.02, cr * 2.4),
            Math.max(0.02, cg * 2.4),
            Math.max(0.03, cb * 2.4)
          );
        }
        const [ar, ag, ab] = state.color;
        const maxC = Math.max(ar, ag, ab, 0.001);
        node.glowMat.uniforms.uColor.value.setRGB(ar / maxC, ag / maxC, ab / maxC);
        node.glowMat.uniforms.uIntensity.value = Math.min(1, (ar + ag + ab) * 0.55);

        acc[3][0] += ar * 1.4;
        acc[3][1] += ag * 1.4;
        acc[3][2] += ab * 1.4;
        acc[3][3] += 1;
      } else if (fix.type === 'blinder4') {
        // L8-style Tungsten Halogen Filament Thermal Inertia & Blackbody Redshift!
        if (this.atmosphere.motorPhysics) {
          const rate = state.intensity > node.thermalDim ? 15.0 : 3.6; // Fast heat-up, warm 350ms afterglow decay!
          node.thermalDim += (state.intensity - node.thermalDim) * Math.min(1, dt * rate);
        } else {
          node.thermalDim = state.intensity;
        }

        const effDim = node.thermalDim;
        const redshift = 1.0 - effDim;
        const r = 1.0;
        const g = Math.max(0.24, state.color[1] - redshift * 0.36);
        const b = Math.max(0.03, state.color[2] - redshift * 0.48);

        for (let c = 0; c < 4; c++) {
          const m = effDim * state.cellMults[c];
          node.cellMats[c].color.setRGB(
            Math.max(0.03, r * m * 3.4),
            Math.max(0.022, g * m * 3.4),
            Math.max(0.015, b * m * 3.4)
          );
        }
        node.coneMat.uniforms.uColor.value.setRGB(r, g, b);
        node.coneMat.uniforms.uIntensity.value = effDim * 0.65;
        node.coneMat.uniforms.uHazeDensity.value = this.atmosphere.hazeDensity;
        node.coneMat.uniforms.uHazeSpeed.value = this.atmosphere.hazeSpeed;
        node.coneMat.uniforms.uTime.value = timeSec;

        acc[4][0] += r * effDim * 2.0;
        acc[4][1] += g * effDim * 2.0;
        acc[4][2] += b * effDim * 2.0;
        acc[4][3] += 1;
      }
    }

    for (let i = 0; i < 5; i++) {
      const [sr, sg, sb, count] = acc[i];
      if (count > 0 && sr + sg + sb > 0.01) {
        const nr = sr / count;
        const ng = sg / count;
        const nb = sb / count;
        const peak = Math.max(nr, ng, nb, 0.001);
        this.clusterLights[i].color.setRGB(nr / peak, ng / peak, nb / peak);
        this.clusterLights[i].intensity = peak * (i === 4 ? 16.0 : 9.5);
      } else {
        this.clusterLights[i].intensity = 0;
      }
    }

    // Sync SMD LED Video Wall & DJ Booth Accent to live dominant rig color + beat pulse
    this.ledWallMat.uniforms.uTime.value = timeSec;
    this.ledWallMat.uniforms.uBeatPulse.value = beatPulse;
    if (acc[0][3] > 0 && acc[0][0] + acc[0][1] + acc[0][2] > 0.04) {
      const m = Math.max(acc[0][0], acc[0][1], acc[0][2], 0.01);
      const cr = acc[0][0] / m;
      const cg = acc[0][1] / m;
      const cb = acc[0][2] / m;
      this.ledWallMat.uniforms.uPrimaryColor.value.lerp(new THREE.Color(cr, cg, cb), Math.min(1, dt * 4.5));
      this.boothAccentMesh.material.color.setRGB(0.15 + cr * 0.85, 0.15 + cg * 0.85, 0.15 + cb * 0.85);
    }

    this.composer.render();
  }
}
