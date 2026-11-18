/**
 * L8-Class Custom GLSL Shaders:
 * 1) Volumetric Light Shafts with coherent 3D FBM Haze & Gobo Ray Carving
 * 2) Stage Floor Gobo Cookie Projection Shader
 * 3) SMD LED Video Wall Shader (Concert Backdrop Matrix)
 */

export const VOLUMETRIC_VERTEX_SHADER = /* glsl */ `
  uniform float uTopRadius;
  uniform float uBottomRadius;
  uniform float uLength;

  varying float vProgress;
  varying vec2 vRadialDir;
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec3 vNormalView;

  void main() {
    float t = clamp(-position.y, 0.0, 1.0);
    vProgress = t;

    vec2 radDir = length(position.xz) > 0.0001 ? normalize(position.xz) : vec2(1.0, 0.0);
    vRadialDir = radDir;

    float radius = mix(uTopRadius, uBottomRadius, t);
    vec3 morphedPos = vec3(radDir.x * radius, -t * uLength, radDir.y * radius);

    float dr = uBottomRadius - uTopRadius;
    vec3 localNormal = normalize(vec3(radDir.x * uLength, dr, radDir.y * uLength));

    vec4 worldPos = modelMatrix * vec4(morphedPos, 1.0);
    vec4 mvPos = viewMatrix * worldPos;

    vWorldPos = worldPos.xyz;
    vViewPos = -mvPos.xyz;
    vNormalView = normalize(normalMatrix * localNormal);

    gl_Position = projectionMatrix * mvPos;
  }
`;

export const VOLUMETRIC_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uHazeDensity;
  uniform float uHazeSpeed;
  uniform float uEdgePower;
  uniform float uTime;
  uniform float uGoboIndex;
  uniform float uGoboRot;

  varying float vProgress;
  varying vec2 vRadialDir;
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec3 vNormalView;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise3D(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));

    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);

    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);

    return mix(nxy0, nxy1, f.z);
  }

  float fbmHaze(vec3 p) {
    float v = 0.0;
    v += 0.56 * noise3D(p);
    v += 0.29 * noise3D(p * 2.17 + vec3(4.2, 1.7, -2.8));
    v += 0.15 * noise3D(p * 4.41 - vec3(1.9, 3.1, 2.4));
    return v;
  }

  float goboMask(float idx, vec2 dir, float rot) {
    if (idx < 0.5) return 1.0;
    float ang = atan(dir.y, dir.x) + rot;
    if (idx < 1.5) {
      return 0.72 + 0.28 * cos(ang * 2.0);
    }
    if (idx < 2.5) {
      float rays = pow(max(0.0, 0.5 + 0.5 * cos(ang * 8.0)), 3.6);
      return 0.08 + 0.92 * rays;
    }
    if (idx < 3.5) {
      float tri = pow(max(0.0, 0.5 + 0.5 * cos(ang * 3.0)), 3.0);
      return 0.10 + 0.90 * tri;
    }
    if (idx < 4.5) {
      float dots = smoothstep(0.35, 0.85, 0.5 + 0.5 * cos(ang * 12.0));
      return 0.08 + 0.92 * dots;
    }
    float blades = pow(max(0.0, 0.5 + 0.5 * cos(ang * 4.0)), 5.5);
    return 0.07 + 0.93 * blades;
  }

  void main() {
    if (uIntensity <= 0.002) discard;

    // Smooth analytical clipping against stage deck, riser & upstage backdrop wall
    float stageFloorY = (vWorldPos.z > 4.6 || abs(vWorldPos.x) > 8.6) ? -0.95 : 0.0;
    float floorFade = smoothstep(stageFloorY - 0.02, stageFloorY + 0.10, vWorldPos.y);
    float wallFade = smoothstep(-4.98, -4.75, vWorldPos.z);
    if (floorFade * wallFade <= 0.001) discard;

    vec3 viewDir = normalize(vViewPos);
    vec3 normDir = normalize(vNormalView);
    float grazing = abs(dot(viewDir, normDir));
    float edgeSoft = pow(clamp(grazing, 0.0, 1.0), uEdgePower);

    // Hot discharge arc near optical lens + realistic inverse axial falloff
    float nearLensCore = exp(-vProgress * 6.2) * 0.58;
    float axialFalloff = pow(max(0.0, 1.0 - vProgress), 1.55) + nearLensCore;

    float camDist = length(vViewPos);
    float camFade = smoothstep(0.18, 1.15, camDist);

    // Coherent 3D volumetric haze field across the entire arena
    vec3 hazeCoord = vWorldPos * 0.44 + vec3(uTime * 0.28 * uHazeSpeed, -uTime * 0.15 * uHazeSpeed, uTime * 0.20 * uHazeSpeed);
    float hazeCloud = fbmHaze(hazeCoord);
    float hazeFactor = mix(0.40, 0.34 + 1.08 * hazeCloud, clamp(uHazeDensity, 0.0, 1.5));

    float gobo = goboMask(uGoboIndex, vRadialDir, uGoboRot);

    float alpha = uIntensity * edgeSoft * axialFalloff * camFade * floorFade * wallFade * hazeFactor * gobo * (0.085 + 0.22 * uHazeDensity);

    // Rich saturated color shaft with white-hot arc core right at the lens
    vec3 coreTint = mix(uColor, vec3(1.0), clamp(nearLensCore * uIntensity * 0.55, 0.0, 0.58));
    gl_FragColor = vec4(coreTint * alpha * 1.45, clamp(alpha, 0.0, 0.88));
  }
`;

export const COOKIE_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const COOKIE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uGoboIndex;
  uniform float uGoboRot;
  uniform float uSoftness;

  varying vec2 vUv;

  void main() {
    if (uIntensity <= 0.003) discard;
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;

    float ang = atan(p.y, p.x) + uGoboRot;
    float mask = 1.0;

    if (uGoboIndex > 0.5 && uGoboIndex < 1.5) {
      mask = smoothstep(0.35, 0.58, r) * (1.0 - smoothstep(0.76, 0.96, r));
    } else if (uGoboIndex >= 1.5 && uGoboIndex < 2.5) {
      float rays = pow(max(0.0, 0.5 + 0.5 * cos(ang * 8.0)), 3.0);
      float center = 1.0 - smoothstep(0.0, 0.26, r);
      mask = max(center, rays * (1.0 - smoothstep(0.65, 0.98, r)));
    } else if (uGoboIndex >= 2.5 && uGoboIndex < 3.5) {
      float tri = cos(floor(0.5 + ang / 2.094395) * 2.094395 - ang) * r;
      mask = (1.0 - smoothstep(0.42, 0.54, tri)) * smoothstep(0.18, 0.30, tri);
    } else if (uGoboIndex >= 3.5 && uGoboIndex < 4.5) {
      float ringDots = smoothstep(0.55, 0.85, 0.5 + 0.5 * cos(ang * 10.0)) * smoothstep(0.32, 0.48, r);
      float inner = 1.0 - smoothstep(0.0, 0.24, r);
      mask = max(inner, ringDots);
    } else if (uGoboIndex >= 4.5) {
      float crossBars = max(1.0 - smoothstep(0.03, 0.11, abs(p.x)), 1.0 - smoothstep(0.03, 0.11, abs(p.y)));
      float ring = smoothstep(0.62, 0.72, r) * (1.0 - smoothstep(0.76, 0.88, r));
      mask = max(crossBars, ring);
    }

    float radialFalloff = pow(max(0.0, 1.0 - r), uSoftness);
    float alpha = uIntensity * mask * radialFalloff * 0.78;
    vec3 col = mix(uColor, vec3(1.0), clamp(alpha * 0.38, 0.0, 0.45));
    gl_FragColor = vec4(col * alpha * 1.45, clamp(alpha, 0.0, 0.9));
  }
`;

export const LED_WALL_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const LED_WALL_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uBeatPulse;
  uniform vec3 uPrimaryColor;
  uniform float uMode;
  uniform float uBrightness;

  varying vec2 vUv;

  void main() {
    if (uMode < 0.5 || uBrightness <= 0.005) {
      gl_FragColor = vec4(0.015, 0.018, 0.026, 1.0);
      return;
    }

    vec2 res = vec2(192.0, 96.0);
    vec2 cellUv = fract(vUv * res);
    vec2 qUv = (floor(vUv * res) + 0.5) / res;
    vec2 p = (qUv - 0.5) * vec2(2.0, 1.0);

    float diode = smoothstep(0.48, 0.28, max(abs(cellUv.x - 0.5), abs(cellUv.y - 0.5)));

    vec3 col = vec3(0.0);
    if (uMode < 1.5) {
      float dist = length(p);
      float rings = pow(max(0.0, 0.5 + 0.5 * sin(dist * 16.0 - uTime * 3.8)), 5.0);
      float crossLine = smoothstep(0.035, 0.0, abs(p.y)) + smoothstep(0.025, 0.0, abs(p.x)) * 0.5;
      float diag = pow(max(0.0, 1.0 - abs(abs(p.x) - abs(p.y) * 1.8) * 6.0), 3.0);
      float energy = (rings * 0.75 + crossLine * 0.45 + diag * 0.55) * (0.55 + uBeatPulse * 0.75);
      col = mix(uPrimaryColor * 0.18, uPrimaryColor * 1.25 + vec3(0.12), clamp(energy, 0.0, 1.15));
    } else if (uMode < 2.5) {
      float band = floor(qUv.x * 32.0);
      float h = 0.15 + 0.68 * abs(sin(band * 0.73 + uTime * 3.1)) * (0.45 + uBeatPulse * 0.75);
      float mirrorY = abs(qUv.y - 0.5) * 2.0;
      float active = step(mirrorY, h);
      col = active * mix(uPrimaryColor, vec3(1.0, 0.95, 0.98), mirrorY * 0.55);
    } else {
      float wave = 0.5 + 0.5 * sin(p.x * 3.2 + uTime * 1.2);
      col = uPrimaryColor * (0.22 + 0.48 * (1.0 - qUv.y) + 0.18 * wave);
    }

    vec3 finalCol = max(vec3(0.012, 0.015, 0.022), col * diode * uBrightness);
    gl_FragColor = vec4(finalCol, 1.0);
  }
`;
