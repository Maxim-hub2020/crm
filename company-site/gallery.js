import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const host = document.querySelector('[data-gallery-scene]');
const canvas = document.querySelector('[data-gallery-canvas]');
const sections = [...document.querySelectorAll('[data-scene]')];
const controls = document.querySelector('[data-controls]');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const mobile = matchMedia('(max-width: 680px)');
const variant = document.querySelector('[data-variant]');
const openButton = document.querySelector('[data-open]');
const explodeButton = document.querySelector('[data-explode]');
const autoButton = document.querySelector('[data-auto]');
const state = { scene: 'overview', angle: 0, tilt: 0, open: false, exploded: false, auto: !reduced.matches && !mobile.matches, light: .75 };
const options = {
  showers: [['corner','Угловая'],['niche','В нишу'],['walkin','Перегородка'],['slider','Раздвижная']],
  mirrors: [['round','Круглое'],['arch','Арочное'],['soft','Скруглённое'],['organic','Фигурное']],
  furniture: [['vanity','Тумба'],['wide','Консоль'],['cabinet','Шкаф']],
};
let renderer, scene, camera, products, mirrors, shower, furniture, door, drawers, ledMaterial, metal;
let frame = 0, previousTime = 0, yaw = 0, tilt = 0, opened = 0, exploded = 0, environmentTarget;
const materials = [];
const dynamicResources = [];
const productGroups = {};
let suspended = false, currentVariant = 'round';
const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const mat = (params)=>{const m=new THREE.MeshStandardMaterial(params);materials.push(m);return m;};
const box = (parent,w,h,d,material,x=0,y=0,z=0)=>{
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);
  mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;
};
const mesh = (parent,geometry,material,x=0,y=0,z=0)=>{
  const m=new THREE.Mesh(geometry,material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;
};
const parts = [];
function movable(object,offset){
  parts.push({object,base:object.position.clone(),offset:new THREE.Vector3(...offset)});
  return object;
}
function clearProduct(group){
  const nodes=new Set();group.traverse(o=>nodes.add(o));
  for(let i=parts.length-1;i>=0;i--)if(nodes.has(parts[i].object))parts.splice(i,1);
  group.traverse(o=>{o.geometry?.dispose();if(o.isReflector)o.dispose();});
  group.clear();
}
function outline(kind){
  const s=new THREE.Shape();
  if(kind==='round')s.absarc(0,0,1.25,0,Math.PI*2,false);
  else if(kind==='organic'){
    s.moveTo(0,1.16);s.bezierCurveTo(.8,1.22,1.14,.72,.92,.1);s.bezierCurveTo(1.08,-.78,.45,-1.2,-.16,-1.1);s.bezierCurveTo(-1.08,-1.2,-1.1,-.4,-.84,.17);s.bezierCurveTo(-1,.93,-.56,1.22,0,1.16);
  }else if(kind==='arch'){
    s.moveTo(-.87,-1.05);s.lineTo(.87,-1.05);s.lineTo(.87,.2);s.absarc(0,.2,.87,0,Math.PI,false);s.lineTo(-.87,-1.05);
  }else{
    const x=.98,y=1.06,r=.24;s.moveTo(-x+r,-y);s.lineTo(x-r,-y);s.quadraticCurveTo(x,-y,x,-y+r);s.lineTo(x,y-r);s.quadraticCurveTo(x,y,x-r,y);s.lineTo(-x+r,y);s.quadraticCurveTo(-x,y,-x,y-r);s.lineTo(-x,-y+r);s.quadraticCurveTo(-x,-y,-x+r,-y);
  }
  return s;
}
function makeMirror(kind='round'){
  clearProduct(mirrors);
  const shape=outline(kind);
  const back=mesh(mirrors,new THREE.ExtrudeGeometry(shape,{depth:.07,bevelEnabled:true,bevelThickness:.018,bevelSize:.018,bevelSegments:2,curveSegments:64}),metal,0,2.5,-.12);
  movable(back,[0,0,-.7]);
  const surface=new Reflector(new THREE.ShapeGeometry(shape,64),{color:0xcac1b0,textureWidth:mobile.matches?512:1024,textureHeight:mobile.matches?512:1024,clipBias:.003,multisample:0});
  surface.position.set(0,2.5,0);mirrors.add(surface);movable(surface,[.45,0,.65]);
  const points=shape.getPoints(128).map(p=>new THREE.Vector3(p.x,p.y,0));
  const path=new THREE.CatmullRomCurve3(points,true);
  const ring=mesh(mirrors,new THREE.TubeGeometry(path,160,.022,8,true),ledMaterial,0,2.5,-.035);movable(ring,[-.45,0,.2]);
  const glow=new THREE.PointLight(0xffcd84,4,5,2);glow.position.set(0,2.5,.4);mirrors.add(glow);mirrors.userData.glow=glow;
}
function makeShower(kind='corner'){
  clearProduct(shower);while(dynamicResources.length)dynamicResources.pop().dispose();
  const glass=new THREE.MeshPhysicalMaterial({color:0xe1e8df,metalness:.08,roughness:.025,clearcoat:1,thickness:.008,ior:1.5,envMapIntensity:1.8,transparent:true,opacity:.16,depthWrite:false,side:THREE.DoubleSide});
  dynamicResources.push(glass);
  const panel=(w,h,x,z,rot=0)=>{
    const g=new THREE.Group();g.position.set(x,h/2+.28,z);shower.add(g);
    box(g,w,h,.012,glass);box(g,.025,h,.028,metal,-w/2,0);box(g,.025,h,.028,metal,w/2,0);box(g,w,.02,.025,metal,0,h/2);
    g.rotation.y=rot;return g;
  };
  const base=mesh(shower,new THREE.BoxGeometry(1.95,.14,1.75),materials[0],0,.21,0);movable(base,[0,-.15,0]);
  if(kind==='walkin'){
    movable(panel(1.9,2.35,0,0),[0,0,.55]);door=null;return;
  }
  movable(panel(.92,2.35,-.52,.78),[-.48,0,.4]);
  if(kind!=='niche')movable(panel(1.58,2.35,-.98,0,Math.PI/2),[-.7,0,0]);
  const hinge=new THREE.Group();hinge.position.set(-.03,.28,.79);shower.add(hinge);door=hinge;door.userData.slider=kind==='slider';
  const leaf=new THREE.Group();leaf.position.set(.48,1.175,0);hinge.add(leaf);
  box(leaf,.93,2.35,.014,glass);
  box(leaf,.018,2.35,.03,metal,-.465,0);box(leaf,.018,2.35,.03,metal,.465,0);
  for(const y of [-.75,.75])box(leaf,.095,.10,.05,metal,-.46,y,.015);
  box(leaf,.032,.30,.06,metal,.33,0,.045);
  movable(hinge,[.55,0,.5]);
  const rail=box(shower,1.94,.032,.035,metal,0,2.64,.8);movable(rail,[0,.32,0]);
  const hardware=new THREE.Group();hardware.position.set(-.48,1.65,-.62);shower.add(hardware);
  const stem=mesh(hardware,new THREE.CylinderGeometry(.018,.018,.65,12),metal);stem.rotation.z=Math.PI/2;
  mesh(hardware,new THREE.CylinderGeometry(.17,.17,.025,32),metal,.27,-.06,0);
}
function makeFurniture(kind='vanity'){
  clearProduct(furniture);drawers=[];
  const wood=materials[1],stone=materials[0];const w=kind==='wide'?2.8:kind==='cabinet'?1.55:2.15;const h=kind==='cabinet'?2.5:.85;const y=h/2+.45;
  const carcass=new THREE.Group();carcass.position.y=y;furniture.add(carcass);
  box(carcass,w,.06,.9,wood,0,-h/2);box(carcass,w,.06,.9,wood,0,h/2);
  for(const x of [-w/2,w/2])box(carcass,.055,h,.9,wood,x,0);
  box(carcass,w,h,.045,wood,0,0,-.43);movable(carcass,[0,0,-.35]);
  const count=kind==='cabinet'?3:2;
  for(let i=0;i<count;i++){
    const d=new THREE.Group();d.position.set(0,y+h/2-(i+.5)*h/count,.3);furniture.add(d);
    box(d,w-.07,h/count-.045,.055,wood,0,0,.17);box(d,w-.15,.025,.64,wood,0,-h/count/2+.03,-.13);
    box(d,w-.12,.018,.025,metal,0,h/count/2-.015,.20);drawers.push(d);movable(d,[(i%2?1:-1)*.3,(count-1-i)*.18,.45+i*.15]);
  }
  const top=box(furniture,w+.14,.095,1.02,stone,0,y+h/2+.075,0);movable(top,[0,.65,0]);
  if(kind!=='cabinet'){
    const profile=[[.05,0],[.18,.015],[.29,.10],[.37,.24],[.38,.255],[.355,.26],[.32,.12],[.21,.055],[.05,.05]].map(([r,h])=>new THREE.Vector2(r,h));
    const bowl=mesh(furniture,new THREE.LatheGeometry(profile,64),stone,0,y+h/2+.125,.06);movable(bowl,[0,.75,0]);
    const faucet=box(furniture,.03,.29,.03,metal,0,y+h/2+.24,-.28);movable(faucet,[0,.6,0]);
    box(furniture,.03,.03,.19,metal,0,y+h/2+.385,-.2);
  }
}
function resize(){
  if(!renderer)return;
  const width=host.clientWidth,height=host.clientHeight;renderer.setSize(width,height,false);camera.aspect=width/Math.max(height,1);camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio,mobile.matches?1.35:1.7));requestFrame();
}
function cameraTarget(){
  const overview=state.scene==='overview';
  return overview?new THREE.Vector3(4.2,3.3,6.8):new THREE.Vector3(2.1,2.7,6.5);
}
function syncUI(){
  const key=state.scene,product=key!=='overview';
  document.body.dataset.scene=key;controls.querySelector('.product-controls').hidden=!product;
  openButton.hidden=!(key==='showers'||key==='furniture');openButton.textContent=key==='furniture'?(state.open?'Закрыть ящики':'Открыть ящики'):(state.open?'Закрыть дверь':'Открыть дверь');openButton.setAttribute('aria-pressed',state.open);
  openButton.disabled=key==='showers'&&variant.value==='walkin';
  explodeButton.setAttribute('aria-pressed',state.exploded);explodeButton.textContent=state.exploded?'Собрать':'Разобрать';autoButton.setAttribute('aria-pressed',state.auto);
  document.querySelector('[data-variant-label]').textContent=key==='showers'?'Тип':key==='furniture'?'Изделие':'Форма';
  document.querySelectorAll('.scene-pagination a,.gallery-header nav a').forEach(a=>{if(a.hash==='#'+(key==='overview'?'top':key))a.setAttribute('aria-current','true');else a.removeAttribute('aria-current');});
  canvas.setAttribute('aria-label','3D-изделие. Потяните для вращения или используйте стрелки клавиатуры.');
}
function selectScene(key){
  if(state.scene===key)return;
  state.scene=key;state.angle=0;state.tilt=0;state.open=false;state.exploded=false;state.auto=false;
  variant.replaceChildren(...(options[key]||[]).map(([value,text])=>new Option(text,value)));
  for(const [name,g] of Object.entries(productGroups)){g.visible=key==='overview'||key===name;g.position.copy(key==='overview'?g.userData.overview:new THREE.Vector3());g.scale.setScalar(key==='overview'?.80:1);}
  if(key==='mirrors')makeMirror('round');if(key==='showers')makeShower('corner');if(key==='furniture')makeFurniture('vanity');
  syncUI();document.querySelector('[data-scene-status]').textContent=key==='mirrors'?'Зеркала':key==='showers'?'Душевые':key==='furniture'?'Мебель':'Коллекция';requestFrame();
}
function syncScroll(){
  const contact=document.querySelector('#contact').getBoundingClientRect();const atContact=contact.top<innerHeight*.5;
  document.body.classList.toggle('is-contact',atContact);host.style.opacity=atContact?'0':'1';suspended=atContact;
  if(!atContact){const nearest=sections.reduce((a,b)=>Math.abs(a.getBoundingClientRect().top)<Math.abs(b.getBoundingClientRect().top)?a:b);
    host.querySelector('.scene-fallback').src='/assets/images/gallery/'+(nearest.dataset.scene==='overview'?'mirrors':nearest.dataset.scene)+'.webp';
    if(products)selectScene(nearest.dataset.scene);
  }
  requestFrame();
}
document.querySelectorAll('a[href^="#"]').forEach(a=>a.addEventListener('click',event=>{
  const target=document.querySelector(a.hash);if(!target)return;event.preventDefault();history.replaceState(null,'',a.hash);
  target.scrollIntoView({behavior:'instant'});if(target.dataset.scene&&products)selectScene(target.dataset.scene);syncScroll();
}));
variant.addEventListener('change',()=>{
  state.exploded=false;state.open=false;currentVariant=variant.value;
  if(state.scene==='mirrors')makeMirror(variant.value);else if(state.scene==='showers')makeShower(variant.value);else makeFurniture(variant.value);
  syncUI();requestFrame();
});
openButton.addEventListener('click',()=>{state.open=!state.open;syncUI();requestFrame();});
explodeButton.addEventListener('click',()=>{state.exploded=!state.exploded;syncUI();requestFrame();});
autoButton.addEventListener('click',()=>{state.auto=!state.auto;syncUI();requestFrame();});
document.querySelector('[data-light]').addEventListener('input',e=>{state.light=+e.target.value/100;requestFrame();});
document.querySelector('[data-finish]').addEventListener('change',e=>{metal.color.set({bronze:0xb2915f,black:0x222322,chrome:0xcbd1d3}[e.target.value]);metal.roughness=e.target.value==='chrome'?.16:.32;requestFrame();});
let pointer=null;
canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;pointer={x:e.clientX,y:e.clientY,id:e.pointerId,dragged:false};state.auto=false;syncUI();});
canvas.addEventListener('pointermove',e=>{
  if(!pointer||e.pointerId!==pointer.id)return;
  const dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;
  if(!pointer.dragged&&Math.abs(dx)<6)return;
  if(!pointer.dragged&&Math.abs(dy)>Math.abs(dx)*1.5){pointer=null;return;}
  if(!pointer.dragged){pointer.dragged=true;canvas.setPointerCapture(e.pointerId);}
  state.angle+=dx*.007;state.tilt=clamp(state.tilt+dy*.002,-.17,.17);pointer.x=e.clientX;pointer.y=e.clientY;requestFrame();
});
const endPointer=()=>{pointer=null;};canvas.addEventListener('pointerup',endPointer);canvas.addEventListener('pointercancel',endPointer);
canvas.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();state.angle+=(e.key==='ArrowLeft'?-.2:.2);requestFrame();}});
function requestFrame(){if(renderer&&!frame&&!suspended&&!document.hidden)frame=requestAnimationFrame(render);}
function render(time){
  frame=0;if(suspended||document.hidden||!products){previousTime=0;return;}
  const dt=previousTime?Math.min((time-previousTime)/1000,.05):1/60;previousTime=time;const rate=reduced.matches?1:1-Math.exp(-dt*9);
  if(state.auto&&!reduced.matches)state.angle+=dt*.22;
  yaw+=(state.angle-yaw)*rate;tilt+=(state.tilt-tilt)*rate;opened+=((state.open?1:0)-opened)*rate;exploded+=((state.exploded?1:0)-exploded)*rate;
  products.rotation.set(tilt,yaw,0);camera.position.lerp(cameraTarget(),rate);camera.lookAt(0,state.scene==='overview'?1.65:1.45,0);
  for(const p of parts)p.object.position.copy(p.base).addScaledVector(p.offset,exploded);
  if(door){door.rotation.y=door.userData.slider?0:-opened*Math.PI*.47;if(door.userData.slider)door.position.x=-.03-opened*.9;}
  for(const d of drawers||[])d.position.z+=opened*.52;
  ledMaterial.emissiveIntensity=2+state.light*4;scene.userData.key.intensity=30+state.light*65;scene.userData.fill.intensity=12+state.light*20;if(mirrors.userData.glow)mirrors.userData.glow.intensity=state.light*4;
  renderer.render(scene,camera);canvas.dataset.rotation=yaw.toFixed(3);canvas.dataset.open=opened.toFixed(3);canvas.dataset.exploded=exploded.toFixed(3);
  if((state.auto&&!reduced.matches)||Math.abs(yaw-state.angle)>.0001||Math.abs(tilt-state.tilt)>.0001||Math.abs(opened-(state.open?1:0))>.0001||Math.abs(exploded-(state.exploded?1:0))>.0001||camera.position.distanceTo(cameraTarget())>.001)requestFrame();else previousTime=0;
}
async function init(){
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  scene=new THREE.Scene();scene.background=new THREE.Color(0x28231c);
  camera=new THREE.PerspectiveCamera(40,1,.05,60);camera.position.copy(cameraTarget());
  const pmrem=new THREE.PMREMGenerator(renderer);const room=new RoomEnvironment();environmentTarget=pmrem.fromScene(room,.04);scene.environment=environmentTarget.texture;room.dispose();pmrem.dispose();
  const loader=new THREE.TextureLoader();
  const stoneTexture=await loader.loadAsync('/assets/images/gallery/stone.webp');stoneTexture.colorSpace=THREE.SRGBColorSpace;stoneTexture.wrapS=stoneTexture.wrapT=THREE.RepeatWrapping;stoneTexture.repeat.set(2,2);
  const stone=mat({color:0xc6b59b,map:stoneTexture,roughness:.72});
  // Grain is a geometry material detail; central product models remain real meshes.
  const wood=mat({color:0x382317,roughness:.42});
  wood.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\nfloat grain = sin(vViewPosition.y*165.0 + sin(vViewPosition.x*8.0)*2.0 + sin(vViewPosition.y*22.0)*3.0); diffuseColor.rgb *= 0.94 + grain*0.035;');};
  metal=mat({color:0xb2915f,metalness:.9,roughness:.3});
  ledMaterial=mat({color:0xffe3b0,emissive:0xffbf60,emissiveIntensity:5,roughness:.3});
  products=new THREE.Group();scene.add(products);
  shower=new THREE.Group();mirrors=new THREE.Group();furniture=new THREE.Group();
  Object.assign(productGroups,{showers:shower,mirrors,furniture});
  shower.userData.overview=new THREE.Vector3(-1.45,0,-.1);mirrors.userData.overview=new THREE.Vector3(1.12,.3,-.5);furniture.userData.overview=new THREE.Vector3(1.12,0,.02);
  for(const g of Object.values(productGroups)){products.add(g);g.position.copy(g.userData.overview);g.scale.setScalar(.8);}
  makeShower();makeMirror();makeFurniture();
  const stage=mesh(scene,new THREE.CylinderGeometry(2.75,2.82,.22,96),stone,0,.02,0);
  const line=mesh(scene,new THREE.TorusGeometry(2.8,.012,8,120),ledMaterial,0,-.05,0);line.rotation.x=Math.PI/2;
  const floor=mesh(scene,new THREE.CircleGeometry(3.8,96),mat({color:0x524b41,map:stoneTexture,roughness:.55}),0,-.11,0);floor.rotation.x=-Math.PI/2;
  const wall=box(scene,18,10,.15,stone,0,4.9,-5);
  const archShape=new THREE.Shape();archShape.moveTo(-1.3,0);archShape.lineTo(1.3,0);archShape.lineTo(1.3,3);archShape.absarc(0,3,1.3,0,Math.PI,false);archShape.lineTo(-1.3,0);
  const arch=mesh(scene,new THREE.ExtrudeGeometry(archShape,{depth:.15,bevelEnabled:false}),mat({color:0x25221c,roughness:1}),-3,-.1,-4.88);
  wall.visible=false;arch.visible=false;
  // The full panoramic architecture also appears in the mirror's live reflection.
  scene.add(new THREE.HemisphereLight(0xffecd1,0x39322c,2.2));
  const key=new THREE.SpotLight(0xffe0a7,90,25,.7,.7,1.7);key.position.set(0,7,4);key.target.position.set(0,1,0);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.bias=-.001;scene.add(key,key.target);scene.userData.key=key;
  const fill=new THREE.PointLight(0xf3d7b2,30,20,1.6);fill.position.set(-4,3,2);scene.add(fill);scene.userData.fill=fill;
  const backlight=new THREE.PointLight(0xffcb88,45,12,1.6);backlight.position.set(2,4,-3);scene.add(backlight);
  loader.load('/assets/images/gallery/environment.webp',texture=>{
    texture.mapping=THREE.EquirectangularReflectionMapping;texture.colorSpace=THREE.SRGBColorSpace;
    const generator=new THREE.PMREMGenerator(renderer);environmentTarget.dispose();environmentTarget=generator.fromEquirectangular(texture);scene.environment=environmentTarget.texture;scene.background=texture;scene.backgroundIntensity=.50;scene.backgroundRotation.y=2.7;generator.dispose();requestFrame();
  });
  resize();host.classList.add('is-ready');canvas.dataset.ready='true';syncUI();syncScroll();requestFrame();
  const initial=document.querySelector(location.hash||'#top');if(initial)initial.scrollIntoView({behavior:'instant'});syncScroll();
}
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();suspended=true;state.auto=false;controls.hidden=true;host.classList.remove('is-ready');host.classList.add('is-fallback');});
window.addEventListener('scroll',syncScroll,{passive:true});window.addEventListener('resize',resize);document.addEventListener('visibilitychange',()=>{previousTime=0;requestFrame();});reduced.addEventListener('change',()=>{state.auto=false;syncUI();requestFrame();});
init().catch(error=>{console.warn('3D view unavailable:',error.message);host.classList.add('is-fallback');canvas.hidden=true;controls.hidden=true;});
