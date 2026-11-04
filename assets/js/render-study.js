/* Light through dust: prescribed density, Beer-Lambert extinction, single scattering.
 * Optical coefficients use normalized scene units. Multiple scattering is omitted.
 * Deterministic midpoint quadrature; exact integration inside each constant segment.
 */
(() => {
  'use strict';
  let canvas = document.getElementById('render-study');
  if (!canvas) return;
  const stage = canvas.closest('.scene-stage') || canvas.parentElement;
  const fallback = document.getElementById('render-fallback');
  const engineLabel = document.querySelector('.scene-index');
  const interactionHelp = document.getElementById('render-help');
  const pauseButton = document.getElementById('render-pause');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const MODEL = {
    "sigmaA": 0.12,
    "sigmaS": 0.78,
    "g": 0.35,
    "viewSteps": 64,
    "lightSteps": 6,
    "boundsMin": [-2.6, -1.85, -1.2],
    "boundsMax": [2.6, 1.85, 1.2],
    "densityRadius": [2.55, 1.8, 1.15],
    "camera": [0, 0.10, 6.2],
    "fovTan": 0.42,
    "lightPosition": [-2.8, 1.9, 0.85],
    "lightTarget": [1.35, -1.15, -0.15],
    "lightColor": [1, 0.88, 0.70],
    "lightIntensity": 144,
    "cosInner": 0.9781476007,
    "cosOuter": 0.9510565163,
    "exposure": 3,
    "background": [0.0025, 0.0035, 0.005]
  };
  let paused = reducedMotion.matches, backend = null, recovering = false, inView = true;
  let frame = 0, lastPaint = 0, lastTime = 0, time = 0;
  let targetX = 0, targetY = 0, pointerX = 0, pointerY = 0;
  // Ten vec4s. The same optical model and packing are used by WGSL and GLSL.
  const uniforms = new Float32Array(40);
  uniforms.set([MODEL.sigmaA, MODEL.sigmaS, MODEL.g, MODEL.exposure], 4);
  uniforms.set([...MODEL.lightPosition, MODEL.lightIntensity], 8);
  uniforms.set([...MODEL.camera, MODEL.fovTan], 16);
  uniforms.set([...MODEL.boundsMin, MODEL.cosOuter], 20);
  uniforms.set([...MODEL.boundsMax, 0], 24);
  uniforms.set([...MODEL.densityRadius, 0], 28);
  uniforms.set([...MODEL.lightColor, 0], 32);
  uniforms.set([...MODEL.background, 0], 36);

  const wgsl = `
    struct Params {
      resolution: vec4f, optics: vec4f, lightPosition: vec4f, lightDirection: vec4f,
      camera: vec4f, boundsMin: vec4f, boundsMax: vec4f, densityRadius: vec4f,
      lightColor: vec4f, background: vec4f,
    }
    @group(0) @binding(0) var<uniform> params: Params;
    const VIEW_STEPS: u32 = 64u;
    const LIGHT_STEPS: u32 = 6u;
    fn segmentT(sigmaT: f32, density: f32, ds: f32) -> f32 {
      return exp(-sigmaT * density * ds);
    }
    fn scatterWeight(sigmaA: f32, sigmaS: f32, transmittance: f32) -> f32 {
      let sigmaT = sigmaA + sigmaS;
      if (sigmaT <= 0.0) { return 0.0; }
      return (sigmaS / sigmaT) * (1.0 - transmittance);
    }
    // Incoming propagation is -toLight; outgoing propagation is -rd.
    fn phaseHG(mu: f32, g: f32) -> f32 {
      return (1.0 - g * g) / (12.566370614359172 * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
    }
    fn densityAt(p: vec3f) -> f32 {
      let q = p / params.densityRadius.xyz;
      let support = max(0.0, 1.0 - dot(q, q));
      let w = p + vec3f(params.resolution.w * 0.025, params.resolution.w * 0.008, 0.0);
      let layer = 0.5 + 0.5 * sin(w.x * 3.2 + w.y * 4.2 + w.z * 0.65 + 0.35 * sin(w.y * 2.1));
      let layer2 = 0.5 + 0.5 * sin(w.x * 1.3 - w.y * 3.1 + w.z * 0.9 + 0.7);
      return support * support * (0.08 + 0.60 * layer * layer + 0.16 * layer2);
    }
    fn safeAxis(x: f32) -> f32 {
      return select(1.0, -1.0, x < 0.0) * max(abs(x), 0.000001);
    }
    fn boxInterval(origin: vec3f, direction: vec3f) -> vec2f {
      let safe = vec3f(safeAxis(direction.x), safeAxis(direction.y), safeAxis(direction.z));
      let a = (params.boundsMin.xyz - origin) / safe;
      let b = (params.boundsMax.xyz - origin) / safe;
      let lo = min(a, b);
      let hi = max(a, b);
      return vec2f(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
    }
    fn lightTransmittance(p: vec3f, toLight: vec3f, distance: f32, sigmaT: f32) -> f32 {
      let interval = boxInterval(p, toLight);
      let length = max(0.0, min(distance, interval.y));
      let ds = length / f32(LIGHT_STEPS);
      var opticalDepth = 0.0;
      for (var j = 0u; j < LIGHT_STEPS; j++) {
        opticalDepth += densityAt(p + toLight * ((f32(j) + 0.5) * ds)) * ds;
      }
      return exp(-sigmaT * opticalDepth);
    }
    fn linearToSRGB(color: vec3f) -> vec3f {
      return select(color * 12.92, 1.055 * pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.4)) - vec3f(0.055), color > vec3f(0.0031308));
    }
    @vertex fn volumeVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
      let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
      return vec4f(positions[index], 0.0, 1.0);
    }
    @fragment fn volumeFragment(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
      let uv = vec2f(pixel.x * 2.0 - params.resolution.x, params.resolution.y - pixel.y * 2.0) / params.resolution.y;
      let rd = normalize(vec3f(uv * params.camera.w, -1.0));
      let origin = params.camera.xyz;
      let interval = boxInterval(origin, rd);
      let start = max(0.0, interval.x);
      let end = interval.y;
      let sigmaT = params.optics.x + params.optics.y;
      var radiance = vec3f(0.0);
      var viewT = 1.0;
      if (end > start) {
        let ds = (end - start) / f32(VIEW_STEPS);
        for (var i = 0u; i < VIEW_STEPS; i++) {
          let p = origin + rd * (start + (f32(i) + 0.5) * ds);
          let density = densityAt(p);
          if (density > 0.0) {
            let transmittance = segmentT(sigmaT, density, ds);
            let delta = params.lightPosition.xyz - p;
            let distanceSquared = max(dot(delta, delta), 0.0001);
            let distance = sqrt(distanceSquared);
            let toLight = delta / distance;
            let cosine = dot(-toLight, params.lightDirection.xyz);
            let spot = smoothstep(params.boundsMin.w, params.lightDirection.w, cosine);
            if (spot > 0.0) {
              let lightT = lightTransmittance(p, toLight, distance, sigmaT);
              let incident = params.lightColor.xyz * (params.lightPosition.w * spot * lightT / distanceSquared);
              let phase = phaseHG(clamp(dot(rd, toLight), -1.0, 1.0), params.optics.z);
              radiance += viewT * incident * phase * scatterWeight(params.optics.x, params.optics.y, transmittance);
            }
            viewT *= transmittance;
          }
        }
      }
      let background = params.background.xyz * (0.85 + 0.15 * exp(-dot(uv, uv) * 0.7));
      let linear = radiance + background * viewT;
      let mapped = vec3f(1.0) - exp(-linear * params.optics.w);
      return vec4f(linearToSRGB(clamp(mapped, vec3f(0.0), vec3f(1.0))), 1.0);
    }
  `;
  const glVertex = `#version 300 es
    precision highp float;
    void main() {
      vec2 p=gl_VertexID==0?vec2(-1.0,-1.0):gl_VertexID==1?vec2(3.0,-1.0):vec2(-1.0,3.0);
      gl_Position=vec4(p,0.0,1.0);
    }
  `;
  const glFragment = `#version 300 es
    precision highp float;
    uniform vec4 uResolution,uOptics,uLightPosition,uLightDirection,uCamera;
    uniform vec4 uBoundsMin,uBoundsMax,uDensityRadius,uLightColor,uBackground;
    out vec4 fragColor;
    const int VIEW_STEPS=64;
    const int LIGHT_STEPS=6;
    float segmentT(float sigmaT,float density,float ds) {return exp(-sigmaT*density*ds);}
    float scatterWeight(float sigmaA,float sigmaS,float transmittance) {
      float sigmaT=sigmaA+sigmaS;
      if(sigmaT<=0.0) return 0.0;
      return (sigmaS/sigmaT)*(1.0-transmittance);
    }
    float phaseHG(float mu,float g) {return (1.0-g*g)/(12.566370614359172*pow(1.0+g*g-2.0*g*mu,1.5));}
    float densityAt(vec3 p) {
      vec3 q=p/uDensityRadius.xyz;
      float support=max(0.0,1.0-dot(q,q));
      vec3 w=p+vec3(uResolution.w*0.025,uResolution.w*0.008,0.0);
      float layer=0.5+0.5*sin(w.x*3.2+w.y*4.2+w.z*0.65+0.35*sin(w.y*2.1));
      float layer2=0.5+0.5*sin(w.x*1.3-w.y*3.1+w.z*0.9+0.7);
      return support*support*(0.08+0.60*layer*layer+0.16*layer2);
    }
    float safeAxis(float x) {return (x<0.0?-1.0:1.0)*max(abs(x),0.000001);}
    vec2 boxInterval(vec3 origin,vec3 direction) {
      vec3 safe=vec3(safeAxis(direction.x),safeAxis(direction.y),safeAxis(direction.z));
      vec3 a=(uBoundsMin.xyz-origin)/safe,b=(uBoundsMax.xyz-origin)/safe;
      vec3 lo=min(a,b),hi=max(a,b);
      return vec2(max(max(lo.x,lo.y),lo.z),min(min(hi.x,hi.y),hi.z));
    }
    float lightTransmittance(vec3 p,vec3 toLight,float distance,float sigmaT) {
      vec2 interval=boxInterval(p,toLight);
      float length=max(0.0,min(distance,interval.y)),ds=length/float(LIGHT_STEPS),opticalDepth=0.0;
      for(int j=0;j<LIGHT_STEPS;j++) opticalDepth+=densityAt(p+toLight*((float(j)+0.5)*ds))*ds;
      return exp(-sigmaT*opticalDepth);
    }
    vec3 linearToSRGB(vec3 color) {return mix(color*12.92,1.055*pow(max(color,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),color));}
    void main() {
      vec2 uv=(gl_FragCoord.xy*2.0-uResolution.xy)/uResolution.y;
      vec3 rd=normalize(vec3(uv*uCamera.w,-1.0)),origin=uCamera.xyz;
      vec2 interval=boxInterval(origin,rd);
      float start=max(0.0,interval.x),end=interval.y,sigmaT=uOptics.x+uOptics.y,viewT=1.0;
      vec3 radiance=vec3(0.0);
      if(end>start) {
        float ds=(end-start)/float(VIEW_STEPS);
        for(int i=0;i<VIEW_STEPS;i++) {
          vec3 p=origin+rd*(start+(float(i)+0.5)*ds);
          float density=densityAt(p);
          if(density>0.0) {
            float transmittance=segmentT(sigmaT,density,ds);
            vec3 delta=uLightPosition.xyz-p;
            float distanceSquared=max(dot(delta,delta),0.0001),distance=sqrt(distanceSquared);
            vec3 toLight=delta/distance;
            float spot=smoothstep(uBoundsMin.w,uLightDirection.w,dot(-toLight,uLightDirection.xyz));
            if(spot>0.0) {
              float lightT=lightTransmittance(p,toLight,distance,sigmaT);
              vec3 incident=uLightColor.xyz*(uLightPosition.w*spot*lightT/distanceSquared);
              float phase=phaseHG(clamp(dot(rd,toLight),-1.0,1.0),uOptics.z);
              radiance+=viewT*incident*phase*scatterWeight(uOptics.x,uOptics.y,transmittance);
            }
            viewT*=transmittance;
          }
        }
      }
      vec3 background=uBackground.xyz*(0.85+0.15*exp(-dot(uv,uv)*0.7));
      vec3 linear=radiance+background*viewT;
      vec3 mapped=vec3(1.0)-exp(-linear*uOptics.w);
      fragColor=vec4(linearToSRGB(clamp(mapped,vec3(0.0),vec3(1.0))),1.0);
    }
  `;

  async function createWebGPU() {
    if(!navigator.gpu) throw new Error('WebGPU unavailable');
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'low-power'});
    if(!adapter) throw new Error('No WebGPU adapter');
    const device=await adapter.requestDevice();
    let result=null;
    device.lost.then(()=>{if(backend===result&&result)recoverToWebGL();}).catch(()=>{});
    device.addEventListener('uncapturederror',event=>{event.preventDefault();if(backend===result&&result)recoverToWebGL();});
    try {
      const context=canvas.getContext('webgpu');
      if(!context) throw new Error('No WebGPU canvas context');
      const format=navigator.gpu.getPreferredCanvasFormat();
      const shader=device.createShaderModule({label:'Dust / Beer-Lambert single scattering',code:wgsl});
      const errors=(await shader.getCompilationInfo()).messages.filter(message=>message.type==='error');
      if(errors.length) throw new Error(errors.map(message=>message.message).join(' '));
      const pipeline=await device.createRenderPipelineAsync({
        label:'Light through dust / deterministic volume integration',layout:'auto',
        vertex:{module:shader,entryPoint:'volumeVertex'},
        fragment:{module:shader,entryPoint:'volumeFragment',targets:[{format}]},
        primitive:{topology:'triangle-list'}
      });
      const buffer=device.createBuffer({label:'Volume model and spotlight',size:uniforms.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      const bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer}}]});
      result={
        name:'WebGPU',
        resize(){context.configure({device,format,alphaMode:'opaque'});},
        draw(){
          device.queue.writeBuffer(buffer,0,uniforms);
          const encoder=device.createCommandEncoder();
          const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}]});
          pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.draw(3);pass.end();
          device.queue.submit([encoder.finish()]);
        },
        dispose(){buffer.destroy();context.unconfigure();device.destroy();}
      };
      return result;
    }catch(error){device.destroy();throw error;}
  }
  function createWebGL(){
    const gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,powerPreference:'low-power'});
    if(!gl)throw new Error('WebGL 2 unavailable');
    if(!gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT)?.precision)throw new Error('Fragment high precision unavailable');
    function compile(type,source){
      const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const error=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(error);}
      return shader;
    }
    const vertex=compile(gl.VERTEX_SHADER,glVertex),fragment=compile(gl.FRAGMENT_SHADER,glFragment),program=gl.createProgram();
    gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
    gl.deleteShader(vertex);gl.deleteShader(fragment);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)){const error=gl.getProgramInfoLog(program);gl.deleteProgram(program);throw new Error(error);}
    const locations=['uResolution','uOptics','uLightPosition','uLightDirection','uCamera','uBoundsMin','uBoundsMax','uDensityRadius','uLightColor','uBackground'].map(name=>gl.getUniformLocation(program,name));
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();if(backend?.name==='WebGL 2')showStatic();});
    return {
      name:'WebGL 2',
      resize(width,height){gl.viewport(0,0,width,height);},
      draw(){gl.useProgram(program);locations.forEach((location,index)=>gl.uniform4fv(location,uniforms.subarray(index*4,index*4+4)));gl.drawArrays(gl.TRIANGLES,0,3);},
      dispose(){gl.deleteProgram(program);}
    };
  }
  function replaceCanvas(){const fresh=canvas.cloneNode(false);canvas.replaceWith(fresh);canvas=fresh;}
  function updateControls(){
    const available=Boolean(backend);
    if(interactionHelp)interactionHelp.textContent=available?'Move your pointer to steer the light.':'Static reference render of the volume study.';
    if(pauseButton){
      pauseButton.disabled=!available;
      pauseButton.setAttribute('aria-label',paused?'Play animation':'Pause animation');
      pauseButton.setAttribute('aria-pressed',String(paused));
      pauseButton.title=paused?'Play animation':'Pause animation';
      const icon=pauseButton.querySelector('span[aria-hidden="true"]');
      if(icon)icon.textContent=paused?'▶':'Ⅱ';
    }
    if(engineLabel)engineLabel.textContent=available?backend.name+' · '+(paused?'Paused':'Live'):'Reference · Static';
    canvas.dataset.renderer=available?(backend.name==='WebGPU'?'webgpu':'webgl2'):'static';
    canvas.dataset.model='single-scattering';
  }
  function showStatic(){
    if(frame)cancelAnimationFrame(frame);frame=0;
    const previous=backend;backend=null;
    try{previous?.dispose();}catch{/* A lost context can already be disposed. */}
    canvas.hidden=true;
    if(fallback){fallback.hidden=false;fallback.style.display='';}
    updateControls();
  }
  function resize(){
    const rect=stage.getBoundingClientRect(),widthCSS=Math.max(1,rect.width),heightCSS=Math.max(1,rect.height);
    const ratio=Math.min(window.devicePixelRatio||1,1.25,760/Math.max(widthCSS,heightCSS),Math.sqrt(300000/(widthCSS*heightCSS)));
    const width=Math.max(1,Math.round(widthCSS*ratio)),height=Math.max(1,Math.round(heightCSS*ratio));
    if(canvas.width!==width||canvas.height!==height||!canvas.dataset.sized){
      canvas.width=width;canvas.height=height;canvas.dataset.sized='true';backend.resize(width,height);
    }
  }
  function running(){return Boolean(backend)&&!paused&&inView&&!document.hidden;}
  function requestPaint(){if(!frame&&backend&&inView&&!document.hidden)frame=requestAnimationFrame(tick);}
  function tick(now){
    frame=0;
    if(!backend||!inView||document.hidden){lastTime=0;return;}
    const interval=1000/30,elapsed=now-lastPaint;
    if(lastPaint&&elapsed<interval-0.5){requestPaint();return;}
    const delta=lastTime?Math.min((now-lastTime)/1000,0.1):0;
    lastTime=now;lastPaint=now-(lastPaint&&elapsed>=interval?elapsed%interval:0);
    if(running())time+=delta;
    const smoothing=paused?1:1-Math.exp(-delta*7);
    pointerX+=(targetX-pointerX)*smoothing;pointerY+=(targetY-pointerY)*smoothing;
    try{
      resize();
      const dx=MODEL.lightTarget[0]+pointerX*0.5-MODEL.lightPosition[0];
      const dy=MODEL.lightTarget[1]+pointerY*0.35-MODEL.lightPosition[1];
      const dz=MODEL.lightTarget[2]-MODEL.lightPosition[2],inverse=1/Math.hypot(dx,dy,dz);
      uniforms.set([canvas.width,canvas.height,canvas.width/canvas.height,time],0);
      uniforms.set([dx*inverse,dy*inverse,dz*inverse,MODEL.cosInner],12);
      backend.draw();canvas.hidden=false;
      if(fallback){fallback.hidden=true;fallback.style.display='none';}
    }catch{if(backend?.name==='WebGPU')recoverToWebGL();else showStatic();return;}
    if(running())requestPaint();
  }
  function recoverToWebGL(){
    if(recovering)return;recovering=true;showStatic();
    try{replaceCanvas();delete canvas.dataset.sized;backend=createWebGL();updateControls();requestPaint();}
    catch(error){stage.dataset.webglFallback=error instanceof Error?error.message:'WebGL 2 unavailable';showStatic();}
    recovering=false;
  }
  pauseButton?.addEventListener('click',()=>{
    if(!backend)return;paused=!paused;lastTime=0;updateControls();requestPaint();
  });
  stage.addEventListener('pointermove',event=>{
    if(event.pointerType==='touch')return;
    if(event.target instanceof Element && event.target.closest('button'))return;
    const rect=stage.getBoundingClientRect();
    targetX=((event.clientX-rect.left)/rect.width-0.5)*2;
    targetY=(0.5-(event.clientY-rect.top)/rect.height)*2;requestPaint();
  },{passive:true});
  stage.addEventListener('pointerleave',()=>{targetX=0;targetY=0;requestPaint();});
  document.addEventListener('visibilitychange',()=>{
    lastTime=0;if(document.hidden&&frame){cancelAnimationFrame(frame);frame=0;}else requestPaint();
  });
  reducedMotion.addEventListener('change',event=>{paused=event.matches;lastTime=0;updateControls();requestPaint();});
  if('IntersectionObserver'in window)new IntersectionObserver(entries=>{
    inView=entries[0].isIntersecting;lastTime=0;
    if(!inView&&frame){cancelAnimationFrame(frame);frame=0;}else requestPaint();
  },{threshold:0.02}).observe(stage);
  if('ResizeObserver'in window)new ResizeObserver(requestPaint).observe(stage);
  else window.addEventListener('resize',requestPaint,{passive:true});
  updateControls();
  (async()=>{
    try{backend=await createWebGPU();delete canvas.dataset.sized;updateControls();requestPaint();}
    catch(error){stage.dataset.webgpuFallback=error instanceof Error?error.message:'WebGPU unavailable';recoverToWebGL();}
  })().catch(showStatic);
})();
