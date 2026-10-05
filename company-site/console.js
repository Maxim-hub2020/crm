import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createModelFactory } from './gallery-models.js?v=20261004-console2';
import { catalog } from './gallery-catalog.js?v=20261004-console2';

const $=s=>document.querySelector(s),canvas=$('[data-gallery-canvas]'),host=$('[data-gallery-scene]');
const contact=$('#contact'),help=$('[data-help-dialog]'),track=$('[data-model-track]');
const reduced=matchMedia('(prefers-reduced-motion: reduce)'),mobile=matchMedia('(max-width:760px)');
const state={category:'showers',index:0,angle:0,tilt:0,open:false,explode:false,auto:false,finish:'bronze',light:.75};
if(new URLSearchParams(location.search).get('service')==='mirrors')state.category='mirrors';
let renderer,scene,camera,factory,model,frame=0,lastTime=0,yaw=0,tilt=0,opened=0,exploded=0,reveal=1,failed=false;
const reflection={texture:null,floor:null};
const current=()=>catalog[state.category][state.index];
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
function routeHash(){return `#${state.category}/${current().id}`;}
function updateUI(rebuild=false){
  const item=current(),mirror=state.category==='mirrors';
  document.body.dataset.scene=state.category;document.body.dataset.model=item.id;
  $('[data-product-name]').textContent=item.name;$('[data-product-name]').classList.toggle('is-long',item.name.length>16);
  $('[data-product-description]').textContent=item.description;
  $('[data-spec-material]').textContent=mirror?'Зеркало с LED-подсветкой':'Закалённое стекло';
  $('[data-spec-layout]').textContent=mirror?'По вашим размерам':`${item.panels} ${item.panels===1?'стекло':item.panels===2?'стекла':'стекла'} · по вашим размерам`;
  $('[data-details]').href=mirror?'/zerkala/':'/dushevye/';
  $('.header-calculate').href=`/calculator/?product=${mirror?'mirror':'shower'}`;
  $('[data-collection-label]').textContent=mirror?'Зеркала':'Душевые';
  $('[data-model-count]').textContent=`${String(state.index+1).padStart(2,'0')} / ${catalog[state.category].length}`;
  $('button[data-open]').disabled=failed||!item.doors;$('button[data-open]').hidden=mirror;
  $('button[data-open]').textContent=state.open?'Закрыть':'Открыть';
  for(const [key,selector] of [['open','button[data-open]'],['explode','[data-explode]'],['auto','[data-auto]']])$(selector).setAttribute('aria-pressed',String(state[key]));
  $('[data-explode]').textContent=state.explode?'Собрать':'Разобрать';
  $('[data-auto]').textContent=state.auto?'Остановить':'Вращать';
  $('.light-control').hidden=!mirror;
  document.querySelectorAll('[data-finish]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.finish===state.finish)));
  document.querySelectorAll('.gallery-header nav a').forEach(a=>{if(a.hash===`#${state.category}`)a.setAttribute('aria-current','true');else a.removeAttribute('aria-current');});
  if(rebuild){track.replaceChildren(...catalog[state.category].map((entry,i)=>{
    const b=document.createElement('button');b.type='button';b.className='model-card';b.dataset.model=entry.id;b.title=entry.title;b.setAttribute('aria-label',entry.title);
    const img=document.createElement('img');img.src=`/assets/images/console/${entry.id}.webp`;img.alt='';img.width=155;img.height=92;
    const name=document.createElement('span');name.textContent=entry.name;
    const number=document.createElement('span');number.className='card-number';number.textContent=String(i+1).padStart(2,'0');
    b.append(img,name,number);b.addEventListener('click',()=>select(state.category,i));return b;
  }));}
  track.querySelectorAll('button').forEach((b,i)=>b.setAttribute('aria-pressed',String(i===state.index)));
  const selected=track.children[state.index];
  if(selected){const left=selected.offsetLeft-track.offsetLeft;track.scrollTo({left:left-(track.clientWidth-selected.clientWidth)/2,behavior:reduced.matches?'instant':'smooth'});}
  $('.scene-fallback').src=`/assets/images/console/${item.id}.webp`;$('.scene-fallback').alt=item.title;
  $('[data-scene-status]').textContent=item.title;
}
function select(category,index=0,writeHash=true){
  const changed=state.category!==category;state.category=category;state.index=(index+catalog[category].length)%catalog[category].length;
  state.angle=0;state.tilt=0;state.open=false;state.explode=false;state.auto=false;yaw=0;opened=0;exploded=0;reveal=reduced.matches?1:0;
  if(factory){if(model)scene.remove(model.group);model=factory.create(category,current().kind);scene.add(model.group);factory.setFinish(state.finish);}
  if(writeHash)history.replaceState(null,'',routeHash());
  updateUI(changed||!track.childElementCount);requestFrame();
}
function step(delta){select(state.category,state.index+delta);}
function changeCategory(){select(state.category==='showers'?'mirrors':'showers');}
function toggle(key){if(failed||!model)return;if(key==='open'&&!current().doors)return;state[key]=!state[key];updateUI();requestFrame();}
function finish(value){state.finish=value;factory?.setFinish(value);updateUI();requestFrame();}
function showContact(){
  state.auto=false;updateUI();
  $('[data-service-select]').value=state.category==='mirrors'?'Зеркала':'Душевые';
  const finishLabel=$(`[data-finish="${state.finish}"]`).getAttribute('aria-label');
  const summary=`${current().title}. Отделка: ${finishLabel}.`;
  $('[data-selected-summary]').textContent=current().title;
  const message=$('textarea[name=message]');if(!message.value||message.dataset.autoValue===message.value){message.value=summary;message.dataset.autoValue=summary;}
  if(!contact.open)contact.showModal();history.replaceState(null,'','#contact');
}
contact.addEventListener('close',()=>{history.replaceState(null,'',routeHash());requestFrame();});
$('[data-close-contact]').addEventListener('click',()=>contact.close());
$('[data-help]').addEventListener('click',()=>help.showModal());$('[data-close-help]').addEventListener('click',()=>help.close());
for(const dialog of [contact,help])dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
document.querySelectorAll('a[href^="#"]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();if(a.hash==='#contact')showContact();else select(a.hash==='#mirrors'?'mirrors':'showers');}));
$('[data-previous]').addEventListener('click',()=>step(-1));$('[data-next]').addEventListener('click',()=>step(1));
$('button[data-open]').addEventListener('click',()=>toggle('open'));$('[data-explode]').addEventListener('click',()=>toggle('explode'));$('[data-auto]').addEventListener('click',()=>toggle('auto'));
document.querySelectorAll('[data-finish]').forEach(b=>b.addEventListener('click',()=>finish(b.dataset.finish)));
$('[data-light]').addEventListener('input',e=>{state.light=Number(e.target.value)/100;requestFrame();});
function applyHash(){const [category,id]=location.hash.slice(1).split('/');if(category==='contact'){showContact();return;}const next=category==='mirrors'?'mirrors':'showers';const i=catalog[next].findIndex(v=>v.id===id);select(next,Math.max(i,0),false);}
window.addEventListener('hashchange',applyHash);
function modalOpen(){return !!document.querySelector('dialog[open]');}
document.addEventListener('keydown',e=>{
  if(modalOpen()||e.altKey||e.ctrlKey||e.metaKey||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();step(e.key==='ArrowLeft'?-1:1);}
  else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();changeCategory();}
  else if(e.code==='Space'&&e.target===canvas){e.preventDefault();toggle('open');}
  else if(e.key.toLowerCase()==='x')toggle('explode');else if(e.key.toLowerCase()==='r')toggle('auto');
});
let pointer;
canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;pointer={id:e.pointerId,x:e.clientX,y:e.clientY};state.auto=false;canvas.setPointerCapture(e.pointerId);updateUI();});
canvas.addEventListener('pointermove',e=>{if(!pointer||pointer.id!==e.pointerId)return;state.angle+=(e.clientX-pointer.x)*.008;state.tilt=clamp(state.tilt+(e.clientY-pointer.y)*.002,-.12,.15);pointer.x=e.clientX;pointer.y=e.clientY;requestFrame();});
canvas.addEventListener('pointerup',()=>{pointer=null;});canvas.addEventListener('pointercancel',()=>{pointer=null;});

// Standard Gamepad mapping: DualSense/DualShock, Xbox and compatible controllers.
let padTimer=0,previousButtons=[],lastDirection=0,lastStep=0;
function pollPad(){
  const pad=Array.from(navigator.getGamepads?.()||[]).find(p=>p?.connected);
  if(!pad){clearInterval(padTimer);padTimer=0;previousButtons=[];$('[data-gamepad-status]').textContent='Геймпад отключён. Можно продолжить мышью или клавиатурой.';return;}
  $('[data-gamepad-status]').textContent='Геймпад подключён. Правый стик вращает модель.';
  const buttons=pad.buttons.map(b=>b.pressed),pressed=i=>buttons[i]&&!previousButtons[i];
  if(!document.hidden&&!modalOpen()){
    const dir=buttons[14]?-1:buttons[15]?1:0,now=performance.now();
    if(dir&&(dir!==lastDirection||now-lastStep>330)){step(dir);lastStep=now;}lastDirection=dir;
    if(pressed(4)||pressed(5)||pressed(12)||pressed(13))changeCategory();
    if(pressed(0))toggle('open');if(pressed(2))toggle('explode');if(pressed(3)){const a=['bronze','chrome','black'];finish(a[(a.indexOf(state.finish)+1)%3]);}if(pressed(9))showContact();
    const x=pad.axes[2]||0,y=pad.axes[3]||0;if(Math.abs(x)>.15||Math.abs(y)>.15){state.auto=false;state.angle+=x*.05;state.tilt=clamp(state.tilt+y*.006,-.12,.15);requestFrame();}
  }else if(pressed(1)){document.querySelector('dialog[open]')?.close();}
  previousButtons=buttons;
}
function connectPad(){if(!padTimer)padTimer=setInterval(pollPad,32);}
window.addEventListener('gamepadconnected',connectPad);window.addEventListener('gamepaddisconnected',pollPad);
if(Array.from(navigator.getGamepads?.()||[]).some(Boolean))connectPad();

function resize(){
  if(!renderer)return;const w=host.clientWidth,h=host.clientHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio,mobile.matches?1.4:1.65));renderer.setSize(w,h,false);camera.aspect=w/h;
  camera.clearViewOffset();camera.setViewOffset(w,h,mobile.matches?0:-w*.205,mobile.matches?h*.015:h*.115,w,h);camera.updateProjectionMatrix();requestFrame();
}
function cameraPosition(){return mobile.matches?new THREE.Vector3(5.3,3.1,9.0):new THREE.Vector3(3.5,2.7,6.0);}
function requestFrame(){if(renderer&&!frame&&!failed&&!document.hidden)frame=requestAnimationFrame(render);}
function render(time){
  frame=0;if(!model||failed||document.hidden)return;
  const dt=lastTime?Math.min((time-lastTime)/1000,.05):1/60;lastTime=time;const rate=reduced.matches?1:1-Math.exp(-dt*10);
  if(state.auto&&!reduced.matches&&!modalOpen())state.angle+=dt*.22;
  yaw+=(state.angle-yaw)*rate;tilt+=(state.tilt-tilt)*rate;opened+=((state.open?1:0)-opened)*rate;exploded+=((state.explode?1:0)-exploded)*rate;reveal+=(1-reveal)*rate;
  model.group.rotation.set(tilt,yaw,0);model.group.position.y=-(1-reveal)*.05;
  for(const p of model.parts)p.node.position.copy(p.base).addScaledVector(p.offset,exploded);
  for(const d of model.doors){d.node.rotation.y=d.rotation+(d.slide?0:opened*d.sign*Math.PI*.47);if(d.slide)d.node.position.addScaledVector(d.slide,opened);}
  factory.setLight(state.light);camera.position.copy(cameraPosition());camera.lookAt(0,1.25,0);
  renderer.render(scene,camera);
  canvas.dataset.rotation=yaw.toFixed(3);canvas.dataset.open=opened.toFixed(3);canvas.dataset.exploded=exploded.toFixed(3);canvas.dataset.doors=String(model.doors.length);canvas.dataset.model=current().id;
  if((state.auto&&!reduced.matches&&!modalOpen())||Math.abs(yaw-state.angle)>.001||Math.abs(tilt-state.tilt)>.001||Math.abs(opened-(state.open?1:0))>.001||Math.abs(exploded-(state.explode?1:0))>.001||reveal<.999)requestFrame();else lastTime=0;
}
function fallback(error){failed=true;host.classList.remove('is-ready');host.classList.add('is-fallback');$('[data-controls]').hidden=true;canvas.setAttribute('aria-hidden','true');console.warn('3D fallback:',error?.message||'WebGL unavailable');}
async function init(){
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true,powerPreference:'high-performance'});
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  scene=new THREE.Scene();scene.fog=new THREE.FogExp2(0x080e18,.085);camera=new THREE.PerspectiveCamera(35,1,.05,70);
  const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();let env=pmrem.fromScene(room,.03);scene.environment=env.texture;room.dispose();pmrem.dispose();
  const loader=new THREE.TextureLoader();const stone=await loader.loadAsync('/assets/images/console/slate.webp');stone.colorSpace=THREE.SRGBColorSpace;stone.wrapS=stone.wrapT=THREE.RepeatWrapping;stone.repeat.set(1,1);stone.anisotropy=renderer.capabilities.getMaxAnisotropy();
  factory=createModelFactory(stone,reflection);
  const floorTexture=stone.clone();floorTexture.repeat.set(22,22);floorTexture.needsUpdate=true;
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(60,60),new THREE.MeshStandardMaterial({color:0x60738d,map:floorTexture,bumpMap:floorTexture,bumpScale:.004,roughness:.4,metalness:.20,envMapIntensity:.2}));floor.rotation.x=-Math.PI/2;floor.position.y=-.005;floor.receiveShadow=true;scene.add(floor);
  reflection.floor=floor;
  scene.add(new THREE.HemisphereLight(0xd4e5ff,0x253043,1.15));
  const key=new THREE.SpotLight(0xf3f5ff,65,20,.65,.9,1.5);key.position.set(-3,6,5);key.target.position.set(0,1,0);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.bias=-.0002;key.shadow.normalBias=.015;key.shadow.radius=4;scene.add(key,key.target);
  const rim=new THREE.PointLight(0x92c3ff,30,12,1.4);rim.position.set(3,3,-2);scene.add(rim);
  const warm=new THREE.PointLight(0xffe2b9,12,10,1.4);warm.position.set(-2,2,1);scene.add(warm);
  loader.load('/assets/images/gallery/environment.webp',texture=>{
    texture.mapping=THREE.EquirectangularReflectionMapping;texture.colorSpace=THREE.SRGBColorSpace;
    const p=new THREE.PMREMGenerator(renderer);env.dispose();env=p.fromEquirectangular(texture);scene.environment=env.texture;scene.environmentRotation.y=1.2;p.dispose();
    reflection.texture=texture;
    const roomMap=texture.clone();roomMap.mapping=THREE.UVMapping;roomMap.needsUpdate=true;
    const roomWall=new THREE.Mesh(new THREE.PlaneGeometry(10,5),new THREE.MeshBasicMaterial({map:roomMap,color:0xc4d5e6,fog:false}));
    roomWall.position.set(-4.7,.1,8);roomWall.rotation.y=Math.PI;roomWall.visible=false;scene.add(roomWall);reflection.room=roomWall;
    requestFrame();
  });
  select(state.category,state.index,false);resize();host.classList.add('is-ready');canvas.dataset.ready='true';requestFrame();
}
window.addEventListener('resize',resize);document.addEventListener('visibilitychange',()=>{lastTime=0;requestFrame();});reduced.addEventListener('change',()=>{state.auto=false;updateUI();requestFrame();});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();fallback();});
applyHash();init().catch(fallback);
