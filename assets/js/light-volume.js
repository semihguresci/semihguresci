// Light through dust: a single-scattering volume lit by a spotlight, rendered with WebGPU.
// Density is a baked 3D value-noise volume inside an analytic ellipsoid envelope. Each frame adds
// one jittered estimate per pixel to a running average that restarts when the light moves.
// MODEL is shared with tools/render_dust_reference.py, which renders the static fallback image.

export const MODEL = {
  "sigmaA": 0.10,
  "sigmaS": 0.90,
  "g": 0.30,
  "noiseSize": 64,
  "noiseBase": 3,
  "noiseOctaves": 4,
  "domainExtent": 9.5,
  "ellipsoid": [4.6, 3.1, 1.7],
  "drift": [0.40, 0.12, 0.05],
  "warpAmount": 0.045,
  "warpSpeed": 0.9,
  "wispLow": 0.40,
  "wispHigh": 0.66,
  "densityFloor": 0.02,
  "densityGain": 0.5,
  "camera": [0.0, 0.1, 6.2],
  "fovTan": 0.42,
  "lightPosition": [-3.0, 2.3, 0.6],
  "lightTarget": [1.35, -1.15, -0.15],
  "lightColor": [1.0, 0.84, 0.64],
  "lightIntensity": 170,
  "cosInner": 0.96,
  "cosOuter": 0.90,
  "ambient": [0.035, 0.05, 0.08],
  "glare": 0.25,
  "background": [0.004, 0.0055, 0.008],
  "exposure": 1.0
};

const QUALITY = {
  auto: { label: 'Auto', viewSteps: 48, lightSteps: 4, scale: 0.6, adaptive: true },
  eco: { label: 'Eco', viewSteps: 32, lightSteps: 3, scale: 0.45, adaptive: false },
  balanced: { label: 'Balanced', viewSteps: 48, lightSteps: 4, scale: 0.6, adaptive: false },
  ultra: { label: 'Ultra', viewSteps: 80, lightSteps: 6, scale: 1, adaptive: false }
};

const ACCUMULATION_LIMIT = 8;
const MAX_RENDER_PIXELS = 1000000;
const MAX_CANVAS_PIXELS = 2400000;
const GPU_BUDGET_MS = 10;
const SCALE_MIN = 0.5;
const SCALE_MAX = 1;
const SCALE_STEP = 0.0625;
const FRAME_INTERVAL_MS = 14;
const HISTORY = 120;
const IDLE_MS = 3500;

const number = value => Number(value).toFixed(6);
const vec3 = ([x, y, z]) => `vec3f(${number(x)}, ${number(y)}, ${number(z)})`;

function bakeShader() {
  return /* wgsl */ `
const NOISE_BASE: u32 = ${MODEL.noiseBase}u;
const NOISE_OCTAVES: u32 = ${MODEL.noiseOctaves}u;

@group(0) @binding(0) var volume: texture_storage_3d<rgba16float, write>;

fn hash3(p: vec3u) -> f32 {
  var h = p.x * 1664525u + p.y * 1013904223u + p.z * 2246822519u;
  h = h ^ (h >> 16u);
  h = h * 2654435761u;
  h = h ^ (h >> 15u);
  h = h * 2246822519u;
  h = h ^ (h >> 13u);
  return f32(h & 0xffffffu) / 16777215.0;
}

fn lattice(lo: vec3u, hi: vec3u, x: bool, y: bool, z: bool) -> f32 {
  return hash3(vec3u(select(lo.x, hi.x, x), select(lo.y, hi.y, y), select(lo.z, hi.z, z)));
}

fn valueNoise(x: vec3f, period: u32) -> f32 {
  let cell = floor(x);
  let f = x - cell;
  let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let lo = vec3u(vec3i(cell)) % vec3u(period);
  let hi = (lo + vec3u(1u)) % vec3u(period);
  let x00 = mix(lattice(lo, hi, false, false, false), lattice(lo, hi, true, false, false), w.x);
  let x10 = mix(lattice(lo, hi, false, true, false), lattice(lo, hi, true, true, false), w.x);
  let x01 = mix(lattice(lo, hi, false, false, true), lattice(lo, hi, true, false, true), w.x);
  let x11 = mix(lattice(lo, hi, false, true, true), lattice(lo, hi, true, true, true), w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

@compute @workgroup_size(4, 4, 4)
fn bake(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(volume);
  if (any(id >= size)) {
    return;
  }
  let uvw = (vec3f(id) + vec3f(0.5)) / vec3f(size);
  var sum = 0.0;
  var norm = 0.0;
  var amp = 1.0;
  var period = NOISE_BASE;
  for (var o = 0u; o < NOISE_OCTAVES; o++) {
    sum += amp * valueNoise(uvw * f32(period), period);
    norm += amp;
    amp *= 0.5;
    period *= 2u;
  }
  let v = sum / norm;
  textureStore(volume, vec3i(id), vec4f(v, v, v, 1.0));
}
`;
}

function renderShader() {
  return /* wgsl */ `
const CENTER = vec3f(0.0, 0.0, 0.0);
const EXTENT = ${number(MODEL.domainExtent)};
const ELLIPSOID = ${vec3(MODEL.ellipsoid)};
const DRIFT = ${vec3(MODEL.drift)};
const BACKGROUND = ${vec3(MODEL.background)};
const GLARE = ${number(MODEL.glare)};
const WISP_LOW = ${number(MODEL.wispLow)};
const WISP_HIGH = ${number(MODEL.wispHigh)};
const DENSITY_FLOOR = ${number(MODEL.densityFloor)};
const DENSITY_GAIN = ${number(MODEL.densityGain)};

@group(0) @binding(0) var<uniform> u: array<vec4f, 8>;
@group(0) @binding(1) var volumeTex: texture_3d<f32>;
@group(0) @binding(2) var volumeSampler: sampler;
@group(0) @binding(3) var accumTex: texture_2d<f32>;
@group(0) @binding(4) var clampSampler: sampler;

fn ignNoise(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

fn safeAxis(x: f32) -> f32 {
  return select(-1.0, 1.0, x >= 0.0) * max(abs(x), 1e-6);
}

fn boxSpan(origin: vec3f, dir: vec3f, halfSize: vec3f) -> vec2f {
  let inv = 1.0 / vec3f(safeAxis(dir.x), safeAxis(dir.y), safeAxis(dir.z));
  let a = (-halfSize - origin) * inv;
  let b = (halfSize - origin) * inv;
  let lo = min(a, b);
  let hi = max(a, b);
  return vec2f(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

fn densityAt(p: vec3f, time: f32) -> f32 {
  let q = p / ELLIPSOID;
  let r2 = dot(q, q);
  if (r2 >= 1.0) {
    return 0.0;
  }
  let envelope = (1.0 - r2) * (1.0 - r2);
  var uvw = (p - CENTER) / EXTENT + vec3f(0.5) + DRIFT * time / EXTENT;
  let phase = ${number(MODEL.warpSpeed)} * time;
  uvw += ${number(MODEL.warpAmount)} * vec3f(sin(phase + 6.0 * uvw.y + 1.7), cos(0.8 * phase + 5.0 * uvw.z), sin(0.6 * phase + 4.0 * uvw.x));
  let n = textureSampleLevel(volumeTex, volumeSampler, uvw, 0.0).r;
  let wisps = smoothstep(WISP_LOW, WISP_HIGH, n);
  return envelope * (DENSITY_FLOOR + DENSITY_GAIN * wisps);
}

fn phaseHG(cosTheta: f32, g: f32) -> f32 {
  let denom = 1.0 + g * g - 2.0 * g * cosTheta;
  return (1.0 - g * g) / (12.566370614359172 * pow(denom, 1.5));
}

fn lightTransmittance(p: vec3f, toLight: vec3f, dist: f32, steps: u32, jitter: f32, time: f32, sigmaT: f32) -> f32 {
  let exitDistance = boxSpan(p, toLight, ELLIPSOID).y;
  let len = max(0.0, min(dist, exitDistance));
  let ds = len / f32(steps);
  var tau = 0.0;
  for (var j = 0u; j < steps; j++) {
    tau += densityAt(p + toLight * ((f32(j) + jitter) * ds), time) * ds;
  }
  return exp(-sigmaT * tau);
}

@vertex
fn fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

@fragment
fn trace(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let resolution = u[0].xy;
  let frameIndex = u[0].z;
  let blend = u[0].w;
  let camera = u[1].xyz;
  let fovTan = u[1].w;
  let lightPos = u[2].xyz;
  let lightIntensity = u[2].w;
  let lightDir = u[3].xyz;
  let cosInner = u[3].w;
  let lightColor = u[4].xyz;
  let cosOuter = u[4].w;
  let ambient = u[5].xyz;
  let time = u[5].w;
  let sigmaA = u[6].x;
  let sigmaS = u[6].y;
  let g = u[6].z;
  let viewSteps = u32(u[7].x);
  let lightSteps = u32(u[7].y);

  let sigmaT = sigmaA + sigmaS;
  let albedo = sigmaS / sigmaT;
  let jitter = ignNoise(frag.xy + vec2f(frameIndex * 5.588238));
  let lightJitter = fract(jitter + 0.618034);

  let uv = vec2f(frag.x * 2.0 - resolution.x, resolution.y - frag.y * 2.0) / resolution.y;
  let rd = normalize(vec3f(uv * fovTan, -1.0));
  let span = boxSpan(camera, rd, ELLIPSOID);
  let t0 = max(span.x, 0.0);
  let t1 = span.y;

  var radiance = vec3f(0.0);
  var viewT = 1.0;
  if (t1 > t0) {
    let ds = (t1 - t0) / f32(viewSteps);
    for (var i = 0u; i < viewSteps; i++) {
      let p = camera + rd * (t0 + (f32(i) + jitter) * ds);
      let rho = densityAt(p, time);
      if (rho > 0.0) {
        let segT = exp(-sigmaT * rho * ds);
        let scatter = albedo * (1.0 - segT);
        let delta = lightPos - p;
        let d2 = max(dot(delta, delta), 1e-4);
        let d = sqrt(d2);
        let toLight = delta / d;
        let cone = smoothstep(cosOuter, cosInner, dot(-toLight, lightDir));
        var key = vec3f(0.0);
        if (cone > 0.0) {
          let lightT = lightTransmittance(p, toLight, d, lightSteps, lightJitter, time, sigmaT);
          key = lightColor * (lightIntensity * cone * lightT / d2) * phaseHG(dot(rd, toLight), g);
        }
        radiance += viewT * scatter * (key + ambient);
        viewT *= segT;
      }
    }
  }

  let toLamp = lightPos - camera;
  let along = dot(toLamp, rd);
  let across = toLamp - rd * along;
  let across2 = dot(across, across);
  let halo = 1.0 / (1.0 + 400.0 * across2) + 0.15 / (1.0 + 12.0 * across2);
  if (along > 0.0) {
    radiance += viewT * GLARE * lightColor * halo;
  }

  let background = BACKGROUND * (0.85 + 0.15 * exp(-dot(uv, uv) * 0.7));
  let hdr = radiance + background * viewT;
  let previous = textureLoad(accumTex, vec2i(frag.xy), 0).rgb;
  let color = select(mix(previous, hdr, blend), hdr, blend >= 1.0);
  return vec4f(color, 1.0);
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + vec3f(0.03))) / (x * (2.43 * x + vec3f(0.59)) + vec3f(0.14)), vec3f(0.0), vec3f(1.0));
}

fn toSrgb(c: vec3f) -> vec3f {
  let low = c * 12.92;
  let high = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(high, low, c <= vec3f(0.0031308));
}

@fragment
fn present(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let exposure = u[6].w;
  let canvasSize = u[7].zw;
  let uv = frag.xy / canvasSize;
  let texel = 1.0 / vec2f(textureDimensions(accumTex));
  var glow = vec3f(0.0);
  for (var k = 0u; k < 8u; k++) {
    let angle = f32(k) * 0.7853982;
    let offset = vec2f(cos(angle), sin(angle)) * texel * 7.0;
    glow += max(textureSampleLevel(accumTex, clampSampler, uv + offset, 0.0).rgb - vec3f(0.6), vec3f(0.0));
  }
  let scene = textureSampleLevel(accumTex, clampSampler, uv, 0.0).rgb + glow * (0.5 / 8.0);
  var mapped = aces(scene * exposure);
  let d = uv - vec2f(0.5);
  mapped *= 1.0 - 0.6 * dot(d, d);
  let dither = (ignNoise(frag.xy + vec2f(17.0, 9.0)) + ignNoise(frag.xy * 1.37 + vec2f(3.0, 31.0)) - 1.0) / 255.0;
  return vec4f(clamp(toSrgb(clamp(mapped, vec3f(0.0), vec3f(1.0))) + vec3f(dither), vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
}

function halfToFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

async function checkShader(module, label) {
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(message => message.type === 'error');
  if (errors.length) {
    throw new Error(`${label} shader: ${errors.map(message => `line ${message.lineNum}: ${message.message}`).join('; ')}`);
  }
}

export async function createLightVolume(canvas, options = {}) {
  if (!navigator.gpu) throw new Error('WebGPU is not available');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const timed = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timed ? ['timestamp-query'] : [] });
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('no WebGPU canvas context');
  const format = navigator.gpu.getPreferredCanvasFormat();

  const renderModule = device.createShaderModule({ label: 'light volume render', code: renderShader() });
  const bakeModule = device.createShaderModule({ label: 'light volume bake', code: bakeShader() });
  await checkShader(renderModule, 'render');
  await checkShader(bakeModule, 'bake');

  let failed = false;
  let disposed = false;
  const fail = error => {
    if (failed || disposed) return;
    failed = true;
    console.warn('Light volume:', error.message);
    options.onFailure?.(error);
  };
  device.lost.then(info => {
    if (info.reason !== 'destroyed') fail(new Error(info.message || 'GPU device lost'));
  });
  device.addEventListener('uncapturederror', event => {
    event.preventDefault();
    fail(new Error(event.error.message));
  });

  const size = MODEL.noiseSize;
  const volume = device.createTexture({
    label: 'dust density volume',
    size: [size, size, size],
    dimension: '3d',
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
  });
  const volumeView = volume.createView({ dimension: '3d' });
  const bakeLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } }]
  });
  const bakePipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bakeLayout] }),
    compute: { module: bakeModule, entryPoint: 'bake' }
  });
  const bakeEncoder = device.createCommandEncoder();
  const bakePass = bakeEncoder.beginComputePass();
  bakePass.setPipeline(bakePipeline);
  bakePass.setBindGroup(0, device.createBindGroup({ layout: bakeLayout, entries: [{ binding: 0, resource: volumeView }] }));
  bakePass.dispatchWorkgroups(size / 4, size / 4, size / 4);
  bakePass.end();
  device.queue.submit([bakeEncoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  const renderLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ]
  });
  const renderPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [renderLayout] });
  const tracePipeline = await device.createRenderPipelineAsync({
    label: 'trace and accumulate',
    layout: renderPipelineLayout,
    vertex: { module: renderModule, entryPoint: 'fullscreen' },
    fragment: { module: renderModule, entryPoint: 'trace', targets: [{ format: 'rgba16float' }] },
    primitive: { topology: 'triangle-list' }
  });
  const presentPipeline = await device.createRenderPipelineAsync({
    label: 'present',
    layout: renderPipelineLayout,
    vertex: { module: renderModule, entryPoint: 'fullscreen' },
    fragment: { module: renderModule, entryPoint: 'present', targets: [{ format }] },
    primitive: { topology: 'triangle-list' }
  });

  const repeatSampler = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat', magFilter: 'linear', minFilter: 'linear' });
  const clampSampler = device.createSampler({ addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', magFilter: 'linear', minFilter: 'linear' });
  const uniformBuffer = device.createBuffer({ label: 'frame parameters', size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uniforms = new Float32Array(32);
  const timing = timed ? {
    set: device.createQuerySet({ type: 'timestamp', count: 2 }),
    resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
    read: device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    busy: false
  } : null;

  const state = {
    quality: QUALITY[options.quality] ? options.quality : 'auto',
    viewSteps: 0,
    lightSteps: 0,
    scale: 1,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    width: 0,
    height: 0,
    targets: [],
    traceGroups: [],
    presentGroups: [],
    frameIndex: 0,
    accumulated: 0,
    gpuMs: null,
    previousDirection: null,
    samples: []
  };

  function targetSize() {
    let width = Math.max(16, Math.round(state.canvasWidth * state.scale));
    let height = Math.max(16, Math.round(state.canvasHeight * state.scale));
    const pixels = width * height;
    if (pixels > MAX_RENDER_PIXELS) {
      const k = Math.sqrt(MAX_RENDER_PIXELS / pixels);
      width = Math.max(16, Math.floor(width * k));
      height = Math.max(16, Math.floor(height * k));
    }
    return [width, height];
  }

  function allocate() {
    const [width, height] = targetSize();
    if (width === state.width && height === state.height && state.targets.length === 2) return;
    for (const target of state.targets) target.destroy();
    state.width = width;
    state.height = height;
    state.targets = [0, 1].map(() => device.createTexture({
      label: 'accumulated radiance',
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
    }));
    const views = state.targets.map(target => target.createView());
    const group = (history, present) => device.createBindGroup({
      layout: renderLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: volumeView },
        { binding: 2, resource: repeatSampler },
        { binding: 3, resource: history },
        { binding: 4, resource: clampSampler }
      ]
    });
    state.traceGroups = [0, 1].map(p => group(views[1 - p]));
    state.presentGroups = [0, 1].map(p => group(views[p]));
    state.accumulated = 0;
  }

  function setQuality(name) {
    const key = QUALITY[name] ? name : 'auto';
    const preset = QUALITY[key];
    state.quality = key;
    state.viewSteps = preset.viewSteps;
    state.lightSteps = preset.lightSteps;
    state.scale = preset.scale;
    state.samples = [];
    allocate();
  }

  function adapt(ms) {
    if (!QUALITY[state.quality].adaptive) return;
    state.samples.push(ms);
    if (state.samples.length < 24) return;
    const mean = state.samples.reduce((sum, value) => sum + value, 0) / state.samples.length;
    state.samples.length = 0;
    let next = state.scale;
    if (mean > GPU_BUDGET_MS) next = Math.max(SCALE_MIN, next - SCALE_STEP);
    else if (mean < GPU_BUDGET_MS * 0.6) next = Math.min(SCALE_MAX, next + SCALE_STEP);
    if (next !== state.scale) {
      state.scale = next;
      allocate();
    }
  }

  function readTiming() {
    timing.busy = true;
    timing.read.mapAsync(GPUMapMode.READ).then(() => {
      const [begin, end] = new BigUint64Array(timing.read.getMappedRange().slice(0));
      timing.read.unmap();
      const ms = Number(end - begin) / 1e6;
      if (Number.isFinite(ms) && ms >= 0) {
        state.gpuMs = ms;
        options.onTiming?.(ms);
        adapt(ms);
      }
    }).catch(() => {}).finally(() => {
      timing.busy = false;
    });
  }

  function lightDirection(aimX, aimY) {
    const target = MODEL.lightTarget;
    const origin = MODEL.lightPosition;
    const dx = target[0] + aimX * 0.6 - origin[0];
    const dy = target[1] + aimY * 0.4 - origin[1];
    const dz = target[2] - origin[2];
    const inverse = 1 / Math.hypot(dx, dy, dz);
    return [dx * inverse, dy * inverse, dz * inverse];
  }

  function writeUniforms(time, direction, blend) {
    const camera = MODEL.camera;
    const light = MODEL.lightPosition;
    const color = MODEL.lightColor;
    const ambient = MODEL.ambient;
    uniforms.set([state.width, state.height, state.frameIndex, blend], 0);
    uniforms.set([camera[0], camera[1], camera[2], MODEL.fovTan], 4);
    uniforms.set([light[0], light[1], light[2], MODEL.lightIntensity], 8);
    uniforms.set([direction[0], direction[1], direction[2], MODEL.cosInner], 12);
    uniforms.set([color[0], color[1], color[2], MODEL.cosOuter], 16);
    uniforms.set([ambient[0], ambient[1], ambient[2], time], 20);
    uniforms.set([MODEL.sigmaA, MODEL.sigmaS, MODEL.g, MODEL.exposure], 24);
    uniforms.set([state.viewSteps, state.lightSteps, state.canvasWidth, state.canvasHeight], 28);
    device.queue.writeBuffer(uniformBuffer, 0, uniforms);
  }

  function frame(time, aimX, aimY) {
    if (failed || disposed) return;
    const direction = lightDirection(aimX, aimY);
    const previous = state.previousDirection;
    if (previous && Math.hypot(direction[0] - previous[0], direction[1] - previous[1], direction[2] - previous[2]) > 1e-3) {
      state.accumulated = 0;
    }
    state.previousDirection = direction;
    const count = Math.min(state.accumulated + 1, ACCUMULATION_LIMIT);
    state.accumulated = count;
    writeUniforms(time, direction, 1 / count);

    const p = state.frameIndex & 1;
    const timestamps = Boolean(timing) && !timing.busy;
    const encoder = device.createCommandEncoder();
    const trace = encoder.beginRenderPass({
      colorAttachments: [{ view: state.targets[p].createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: timestamps ? { querySet: timing.set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined
    });
    trace.setPipeline(tracePipeline);
    trace.setBindGroup(0, state.traceGroups[p]);
    trace.draw(3);
    trace.end();
    if (timestamps) {
      encoder.resolveQuerySet(timing.set, 0, 2, timing.resolve, 0);
      encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 16);
    }
    const present = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }]
    });
    present.setPipeline(presentPipeline);
    present.setBindGroup(0, state.presentGroups[p]);
    present.draw(3);
    present.end();
    device.queue.submit([encoder.finish()]);
    state.frameIndex += 1;
    if (timestamps) readTiming();
  }

  async function readLinear() {
    const width = state.width;
    const height = state.height;
    const source = state.targets[(state.frameIndex + 1) & 1];
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const bits = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    const data = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width * 4; x++) {
        data[y * width * 4 + x] = halfToFloat(bits[(y * bytesPerRow) / 2 + x]);
      }
    }
    return { width, height, data };
  }

  function setCanvasSize(width, height) {
    canvas.width = width;
    canvas.height = height;
    state.canvasWidth = width;
    state.canvasHeight = height;
    context.configure({ device, format, alphaMode: 'opaque' });
    allocate();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      for (const target of state.targets) target.destroy();
      volume.destroy();
      uniformBuffer.destroy();
      if (timing) {
        timing.set.destroy();
        timing.resolve.destroy();
        timing.read.destroy();
      }
      device.destroy();
    } catch (error) {
      console.warn('Light volume: cleanup failed', error);
    }
  }

  context.configure({ device, format, alphaMode: 'opaque' });
  setQuality(state.quality);

  return {
    get info() {
      return {
        timing: timed,
        gpuMs: state.gpuMs,
        quality: state.quality,
        scale: state.scale,
        width: state.width,
        height: state.height,
        viewSteps: state.viewSteps,
        lightSteps: state.lightSteps,
        accumulated: state.accumulated,
        converged: state.accumulated >= ACCUMULATION_LIMIT
      };
    },
    frame,
    setCanvasSize,
    setQuality,
    readLinear,
    dispose
  };
}

const clamp = (value, low = -1, high = 1) => Math.min(high, Math.max(low, value));

function wander(time) {
  return { x: 0.35 * Math.sin(time * 0.11), y: 0.22 * Math.sin(time * 0.067 + 1.3) };
}

function boot(host) {
  const canvas = host.querySelector('[data-volume-canvas]');
  const still = host.querySelector('[data-volume-still]');
  const stage = host.hasAttribute('data-volume-stage') ? host : host.querySelector('[data-volume-stage]');
  const status = host.querySelector('[data-status]');
  const pause = host.querySelector('[data-pause]');
  const quality = host.querySelector('[data-quality]');
  const hud = {
    gpu: host.querySelector('[data-hud="gpu"]'),
    gpuLabel: host.querySelector('[data-hud-label]'),
    scale: host.querySelector('[data-hud="scale"]'),
    size: host.querySelector('[data-hud="size"]'),
    steps: host.querySelector('[data-hud="steps"]'),
    accum: host.querySelector('[data-hud="accum"]'),
    spark: host.querySelector('[data-spark]'),
    budget: host.querySelector('[data-budget]')
  };
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const session = {
    renderer: null,
    failed: false,
    paused: motion.matches,
    time: 0,
    last: 0,
    drawn: 0,
    frameMs: 0,
    raf: 0,
    inView: true,
    pageVisible: !document.hidden,
    aim: { x: 0, y: 0 },
    pointer: null,
    keys: { x: 0, y: 0 },
    lastInput: -Infinity,
    lastHud: 0,
    history: []
  };

  const visible = () => session.inView && session.pageVisible;

  function requestFrame() {
    if (!session.raf && session.renderer && visible()) session.raf = requestAnimationFrame(tick);
  }

  function goal(now) {
    const base = session.pointer ?? (now - session.lastInput > IDLE_MS ? wander(session.time) : { x: 0, y: 0 });
    return { x: clamp(base.x + session.keys.x), y: clamp(base.y + session.keys.y) };
  }

  function sizeCanvas() {
    if (!session.renderer) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fit = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (rect.width * rect.height * dpr * dpr)));
    const scale = dpr * fit;
    session.renderer.setCanvasSize(Math.max(1, Math.round(rect.width * scale)), Math.max(1, Math.round(rect.height * scale)));
  }

  function drawSpark() {
    const width = 180;
    const height = 40;
    const pad = 3;
    const peak = Math.max(16, ...session.history);
    const y = value => (height - pad - (value / peak) * (height - 2 * pad)).toFixed(1);
    const step = width / (HISTORY - 1);
    hud.spark.setAttribute('points', session.history.map((value, index) => `${(index * step).toFixed(1)},${y(value)}`).join(' '));
    hud.budget.setAttribute('y1', y(GPU_BUDGET_MS));
    hud.budget.setAttribute('y2', y(GPU_BUDGET_MS));
  }

  function readout(now) {
    if (now - session.lastHud < 250) return;
    session.lastHud = now;
    const info = session.renderer.info;
    hud.gpuLabel.textContent = info.timing ? 'GPU' : 'Frame';
    hud.budget.style.display = info.timing ? '' : 'none';
    if (info.timing) {
      hud.gpu.textContent = info.gpuMs === null ? '—' : info.gpuMs.toFixed(2);
    } else {
      hud.gpu.textContent = session.frameMs ? session.frameMs.toFixed(1) : '—';
    }
    hud.scale.textContent = `${info.scale.toFixed(2)}×`;
    hud.size.textContent = `${info.width}×${info.height}`;
    hud.steps.textContent = `${info.viewSteps} view · ${info.lightSteps} light`;
    hud.accum.textContent = `${info.accumulated}/${ACCUMULATION_LIMIT} frames`;
    drawSpark();
  }

  function applyPaused() {
    const label = session.paused ? 'Play animation' : 'Pause animation';
    pause.setAttribute('aria-label', label);
    pause.title = label;
    host.dataset.mode = session.paused ? 'paused' : 'live';
    status.textContent = session.paused ? 'Paused' : 'Live';
  }

  function setPaused(value) {
    session.paused = value;
    session.last = 0;
    applyPaused();
    requestFrame();
  }

  function tick(now) {
    session.raf = 0;
    const renderer = session.renderer;
    if (!renderer || !visible()) return;
    if (session.drawn && now - session.drawn < FRAME_INTERVAL_MS) {
      requestFrame();
      return;
    }
    const dt = session.last ? Math.min((now - session.last) / 1000, 0.1) : 0;
    if (session.drawn) {
      const interval = now - session.drawn;
      session.frameMs = session.frameMs ? session.frameMs * 0.9 + interval * 0.1 : interval;
    }
    session.last = now;
    session.drawn = now;
    if (!session.paused) session.time += dt;
    const target = goal(now);
    const ease = 1 - Math.exp(-dt * 4);
    session.aim.x += (target.x - session.aim.x) * ease;
    session.aim.y += (target.y - session.aim.y) * ease;
    const settled = Math.abs(target.x - session.aim.x) + Math.abs(target.y - session.aim.y) < 0.002;
    renderer.frame(session.time, session.aim.x, session.aim.y);
    readout(now);
    if (!session.paused || !settled || !renderer.info.converged) requestFrame();
  }

  function setPointer(event) {
    if (!session.renderer || event.target.closest('button, select, label')) return;
    const rect = stage.getBoundingClientRect();
    session.pointer = {
      x: clamp(((event.clientX - rect.left) / rect.width) * 2 - 1),
      y: clamp(1 - ((event.clientY - rect.top) / rect.height) * 2)
    };
    session.lastInput = performance.now();
    requestFrame();
  }

  function releasePointer() {
    session.pointer = null;
    session.lastInput = performance.now();
    requestFrame();
  }

  function stop(message) {
    cancelAnimationFrame(session.raf);
    session.raf = 0;
    session.failed = true;
    try {
      session.renderer?.dispose();
    } catch {
      /* The device may already be gone. */
    }
    session.renderer = null;
    canvas.hidden = true;
    still.hidden = false;
    host.dataset.state = 'static';
    host.dataset.mode = 'static';
    status.textContent = message;
    pause.disabled = true;
    quality.disabled = true;
    hud.gpu.textContent = '—';
  }

  async function start() {
    try {
      const renderer = await createLightVolume(canvas, {
        quality: quality.value,
        onTiming: ms => {
          session.history.push(ms);
          if (session.history.length > HISTORY) session.history.shift();
        },
        onFailure: () => stop('Static render · GPU error')
      });
      if (session.failed) {
        renderer.dispose();
        return;
      }
      session.renderer = renderer;
      sizeCanvas();
      renderer.frame(session.time, session.aim.x, session.aim.y);
      canvas.hidden = false;
      still.hidden = true;
      host.dataset.state = 'live';
      pause.disabled = false;
      quality.disabled = false;
      applyPaused();
      readout(performance.now());
      requestFrame();
    } catch (error) {
      console.info('Light volume: static render.', error);
      stop('Static render · WebGPU unavailable');
    }
  }

  pause.addEventListener('click', () => setPaused(!session.paused));
  quality.addEventListener('change', () => {
    session.renderer?.setQuality(quality.value);
    requestFrame();
  });
  stage.addEventListener('pointerdown', setPointer);
  stage.addEventListener('pointermove', setPointer);
  stage.addEventListener('pointerleave', releasePointer);
  stage.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch') releasePointer();
  });
  canvas.addEventListener('keydown', event => {
    const step = 0.1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      setPaused(!session.paused);
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      session.keys = { x: 0, y: 0 };
    } else if (moves[event.key]) {
      event.preventDefault();
      session.keys.x = clamp(session.keys.x + moves[event.key][0], -0.8, 0.8);
      session.keys.y = clamp(session.keys.y + moves[event.key][1], -0.8, 0.8);
    } else {
      return;
    }
    session.lastInput = performance.now();
    requestFrame();
  });
  motion.addEventListener('change', event => setPaused(event.matches));
  document.addEventListener('visibilitychange', () => {
    session.pageVisible = !document.hidden;
    session.last = 0;
    requestFrame();
  });
  new IntersectionObserver(([entry]) => {
    session.inView = entry.isIntersecting;
    session.last = 0;
    requestFrame();
  }, { threshold: 0.05 }).observe(stage);
  new ResizeObserver(() => {
    sizeCanvas();
    requestFrame();
  }).observe(stage);

  start();
}

const host = document.querySelector('[data-volume]');
if (host) boot(host);
