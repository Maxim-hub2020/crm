import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

// Dimensions are in metres. Every visible product part is actual geometry.
export function createModelFactory(stoneTexture,reflection={}) {
  const metal = new THREE.MeshPhysicalMaterial({color:0xb9a685,metalness:1,roughness:.23,clearcoat:.35});
  const stone = new THREE.MeshStandardMaterial({color:0xc8cbd0,map:stoneTexture,roughness:.45,bumpMap:stoneTexture,bumpScale:.002});
  const wall = new THREE.MeshStandardMaterial({color:0x626b79,map:stoneTexture,roughness:.52,bumpMap:stoneTexture,bumpScale:.002});
  wall.name='architecture';
  const ceramic = new THREE.MeshPhysicalMaterial({color:0xc0beb6,roughness:.26,clearcoat:.4});
  const black = new THREE.MeshStandardMaterial({color:0x10151b,roughness:.4,metalness:.25});
  const glass = new THREE.MeshPhysicalMaterial({color:0xe5f4f7,metalness:.03,roughness:.018,transparent:true,opacity:.075,depthWrite:false,envMapIntensity:1.25,clearcoat:1,side:THREE.DoubleSide});
  const silver = new THREE.MeshPhysicalMaterial({color:0xe1e8ef,metalness:1,roughness:.018,envMapIntensity:1.25,clearcoat:1});
  const led = new THREE.MeshStandardMaterial({color:0xfff5df,emissive:0xffdeb1,emissiveIntensity:3.2});
  const edge = new THREE.LineBasicMaterial({color:0xa7d9d9,transparent:true,opacity:.38});
  const seal = new THREE.MeshPhysicalMaterial({color:0xecf4f5,transparent:true,opacity:.23,roughness:.25,depthWrite:false});
  const glowCanvas=document.createElement('canvas');glowCanvas.width=glowCanvas.height=128;
  const ctx=glowCanvas.getContext('2d'),gradient=ctx.createRadialGradient(64,64,22,64,64,64);
  gradient.addColorStop(0,'rgba(255,222,167,.9)');gradient.addColorStop(.6,'rgba(255,209,143,.4)');gradient.addColorStop(1,'rgba(255,209,143,0)');ctx.fillStyle=gradient;ctx.fillRect(0,0,128,128);
  const glowMap=new THREE.CanvasTexture(glowCanvas);
  const glowMat=new THREE.MeshBasicMaterial({map:glowMap,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,opacity:.65});
  const shared=[metal,stone,wall,ceramic,black,glass,silver,led,edge,seal,glowMat];
  let current;

  function mesh(parent,geometry,material,position=[0,0,0]) {
    const node=new THREE.Mesh(geometry,material);node.position.set(...position);node.castShadow=material!==glass&&material!==glowMat;node.receiveShadow=material!==glass;parent.add(node);return node;
  }
  function box(parent,w,h,d,material,x=0,y=0,z=0,r=.006) {
    return mesh(parent,new RoundedBoxGeometry(w,h,d,2,Math.min(r,w/3,h/3,d/3)),material,[x,y,z]);
  }
  function cylinder(parent,r,length,material,x,y,z,axis='y') {
    const node=mesh(parent,new THREE.CylinderGeometry(r,r,length,24),material,[x,y,z]);
    if(axis==='z')node.rotation.x=Math.PI/2;if(axis==='x')node.rotation.z=Math.PI/2;return node;
  }
  function rod(parent,a,b,r=.012,material=metal) {
    const from=new THREE.Vector3(...a),to=new THREE.Vector3(...b),delta=to.clone().sub(from);
    const node=mesh(parent,new THREE.CylinderGeometry(r,r,delta.length(),24),material);
    node.position.copy(from.add(to).multiplyScalar(.5));node.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return node;
  }
  function screw(parent,x,y,z) {
    cylinder(parent,.0045,.002,metal,x,y,z,'z');box(parent,.005,.0008,.0008,black,x,y,z+.0015,.0002);
  }
  function movable(model,node,offset) {model.parts.push({node,base:node.position.clone(),offset:new THREE.Vector3(...offset)});return node;}
  function panel(parent,w,h,x,y,z,rotation=0) {
    const g=new THREE.Group();g.position.set(x,y,z);g.rotation.y=rotation;parent.add(g);
    const pane=mesh(g,new THREE.BoxGeometry(w,h,.01),glass);
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(pane.geometry),edge));return g;
  }
  function hinge(parent,x,y,z) {
    box(parent,.10,.064,.025,metal,x,y,z);
    cylinder(parent,.015,.073,metal,x,y,z+.008);
    for(const dx of [-.031,.031])screw(parent,x+dx,y,z+.014);
  }
  function handle(parent,x,y,z) {
    for(const dy of [-.11,.11]){
      cylinder(parent,.021,.005,metal,x,y+dy,z,'z');rod(parent,[x,y+dy,z],[x,y+dy,z+.053],.01);
    }
    rod(parent,[x,y-.135,z+.053],[x,y+.135,z+.053],.012);
    rod(parent,[x,y-.10,z-.022],[x,y+.10,z-.022],.009);
  }
  function makeShower(kind) {
    const model={group:new THREE.Group(),parts:[],doors:[],kind};const g=model.group;
    const dims={single:[1.45,1.05],panel:[1.65,1.05],'screen-door':[1.50,1.05],niche:[.95,1.05],'niche-plus':[1.40,1.05],corner:[1.05,1.10],'corner-plus':[1.40,1.10],'double-corner':[1.35,1.35],slider:[1.60,1.10],'slider-corner':[1.60,1.15],'slider-double':[1.50,1.50],trapezoid:[1.45,1.45]};
    const [w,d]=dims[kind];const L=-w/2,R=w/2,B=-d/2,F=d/2;
    movable(model,box(g,w+.13,.105,d+.13,stone,0,.07,0,.025),[0,-.1,0]);
    box(g,w,.015,d,ceramic,0,.127,0,.012);
    movable(model,box(g,w+.13,2.53,.085,wall,0,1.37,B-.035,.01),[0,0,-.25]);
    movable(model,box(g,.085,2.53,d+.13,wall,L-.035,1.37,0,.01),[-.25,0,0]);
    // Stone joints, drain and a recessed shelf make the scale readable.
    for(const x of [-w/4,w/4])box(g,.0025,2.51,.001,black,x,1.37,B+.009,.0003);
    box(g,w*.66,.008,.072,metal,0,.139,B+.20,.004);
    for(let i=0;i<16;i++)box(g,.018,.002,.042,black,-w*.30+i*w*.04,.144,B+.20,.001);
    box(g,.30,.018,.14,metal,w*.28,1.12,B+.08,.007);
    cylinder(g,.028,.16,black,w*.24,1.21,B+.08);cylinder(g,.024,.12,black,w*.34,1.19,B+.08);
    const hardware=new THREE.Group();hardware.position.set(.2,0,B+.75);g.add(hardware);
    rod(hardware,[-.38,1.10,-.675],[-.38,2.32,-.675],.018);
    const pipe=new THREE.CatmullRomCurve3([new THREE.Vector3(-.38,2.27,-.675),new THREE.Vector3(-.38,2.37,-.66),new THREE.Vector3(-.38,2.41,-.58),new THREE.Vector3(-.38,2.41,-.21)]);
    mesh(hardware,new THREE.TubeGeometry(pipe,24,.018,12,false),metal);
    cylinder(hardware,.17,.027,metal,-.38,2.39,-.19);
    cylinder(hardware,.158,.008,black,-.38,2.373,-.19);
    for(let ix=-3;ix<=3;ix++)for(let iz=-3;iz<=3;iz++)if(ix*ix+iz*iz<13)cylinder(hardware,.004,.008,ceramic,-.38+ix*.037,2.367,-.19+iz*.037);
    for(const y of [1.25,2.12]){cylinder(hardware,.034,.016,metal,-.38,y,-.698,'z');rod(hardware,[-.38,y,-.70],[-.38,y,-.675],.012);}
    box(hardware,.31,.08,.07,metal,-.38,1.08,-.66,.025);
    for(const x of [-.49,-.27])cylinder(hardware,.032,.065,metal,x,1.08,-.605,'z');
    const hose=new THREE.CatmullRomCurve3([new THREE.Vector3(-.27,1.03,-.62),new THREE.Vector3(-.20,.52,-.58),new THREE.Vector3(.02,.54,-.60),new THREE.Vector3(.03,1.35,-.62)]);
    mesh(hardware,new THREE.TubeGeometry(hose,48,.008,8,false),metal);
    rod(hardware,[.03,1.30,-.62],[.03,1.51,-.60],.018);cylinder(hardware,.029,.10,metal,.03,1.52,-.60);
    movable(model,hardware,[0,0,.16]);
    const height=2.22,mid=.15+height/2;
    function fixed(a,b){
      const length=Math.hypot(b[0]-a[0],b[1]-a[1]),rotation=-Math.atan2(b[1]-a[1],b[0]-a[0]);
      const p=panel(g,length-.006,height,(a[0]+b[0])/2,mid,(a[1]+b[1])/2,rotation);
      for(const y of [-.77,.77])box(p,.05,.045,.032,metal,-length/2+.02,y,.012);
      movable(model,p,[Math.sin(-rotation)*.15,0,Math.cos(rotation)*.15]);
    }
    function leaf(a,b,sign=-1,sliding=false){
      const length=Math.hypot(b[0]-a[0],b[1]-a[1]),rotation=-Math.atan2(b[1]-a[1],b[0]-a[0]);
      const pivot=new THREE.Group();pivot.position.set(a[0],.15,a[1]+(sliding?.025:0));pivot.rotation.y=rotation;g.add(pivot);
      const p=panel(pivot,length-.010,height,length/2,height/2,0);handle(p,length/2-.10,-.06,.014);
      box(p,length-.01,.018,.022,seal,0,-height/2+.012,0);
      box(p,.012,height,.018,seal,length/2-.006,0,0);
      if(sliding){for(const x of [.10,length-.1]){cylinder(pivot,.029,.032,metal,x,height-.035,.025,'z');box(pivot,.025,.09,.035,metal,x,height-.065,.012);}}
      else for(const y of [.36,1.86])hinge(pivot,0,y,.008);
      model.doors.push({node:pivot,rotation,sign,slide:sliding?new THREE.Vector3(-(b[0]-a[0])*.92,0,-(b[1]-a[1])*.92):null});
      movable(model,pivot,[.10,0,.18]);
    }
    function rail(a,b){rod(g,[a[0],2.32,a[1]+.025],[b[0],2.32,b[1]+.025],.013);}
    const niche=['niche','niche-plus','slider'].includes(kind);
    if(niche)movable(model,box(g,.085,2.53,d+.13,wall,R+.035,1.37,0,.01),[.25,0,0]);
    if(kind==='single'||kind==='panel'){
      const end=L+(kind==='single'?.9:1.05);fixed([L,F],[end,F]);rod(g,[L+.15,2.32,F],[L+.15,2.32,B],.01);
    }else if(kind==='niche')leaf([L,F],[R,F]);
    else if(kind==='corner'){fixed([R,B],[R,F]);leaf([L,F],[R,F]);rail([R,B],[R,F]);}
    else if(kind==='double-corner'||kind==='slider-double'){
      const a=L+w*.43,b=B+d*.43,sliding=kind==='slider-double';
      fixed([L,F],[a+(sliding?.07:0),F]);fixed([R,B],[R,b+(sliding?.07:0)]);
      leaf([a,F],[R,F],-1,sliding);leaf([R,b],[R,F],1,sliding);
      rail([L,F],[R,F]);rail([R,B],[R,F]);
    }else if(kind==='trapezoid'){
      const a=[L+w*.47,F],b=[R,B+d*.47];fixed([L,F],a);fixed([R,B],b);leaf(a,b,-1);rail([L,F],a);rail([R,B],b);
    }else{
      const sliding=kind==='slider'||kind==='slider-corner',split=L+w*(sliding?.48:.38);
      fixed([L,F],[split+(sliding?.065:0),F]);leaf([split,F],[R,F],-1,sliding);
      if(kind==='corner-plus'||kind==='slider-corner')fixed([R,B],[R,F]);
      rail([L,F],[R,F]);
    }
    model.panelCount=g.children.filter(n=>n.type==='Group').length;
    return model;
  }
  function outline(kind,scale=1) {
    const s=new THREE.Shape();
    if(kind==='round')s.absarc(0,0,.78,0,Math.PI*2,false);
    else if(kind==='arch'){s.moveTo(-.63,-.9);s.lineTo(.63,-.9);s.lineTo(.63,.25);s.absarc(0,.25,.63,0,Math.PI,false);s.lineTo(-.63,-.9);}
    else if(kind==='organic'){s.moveTo(0,.87);s.bezierCurveTo(.57,1.02,.9,.4,.68,-.06);s.bezierCurveTo(.91,-.74,.24,-1,-.20,-.85);s.bezierCurveTo(-.89,-.87,-.81,-.22,-.64,.21);s.bezierCurveTo(-.81,.72,-.4,.91,0,.87);}
    else{const x=.72,y=.90,r=.18;s.moveTo(-x+r,-y);s.lineTo(x-r,-y);s.quadraticCurveTo(x,-y,x,-y+r);s.lineTo(x,y-r);s.quadraticCurveTo(x,y,x-r,y);s.lineTo(-x+r,y);s.quadraticCurveTo(-x,y,-x,y-r);s.lineTo(-x,-y+r);s.quadraticCurveTo(-x,-y,-x+r,-y);}
    if(scale===1)return s;return new THREE.Shape(s.getPoints(128).map(p=>p.multiplyScalar(scale)));
  }
  function makeMirror(kind) {
    const model={group:new THREE.Group(),parts:[],doors:[],kind};const g=model.group;
    // A thin architectural sample wall supports the mirror; there is no furniture.
    movable(model,box(g,2.14,2.75,.09,wall,0,1.40,-.20,.035),[0,0,-.26]);
    box(g,2.20,.07,.62,stone,0,.035,-.20,.025);
    const shape=outline(kind),cy=1.58;
    const halo=mesh(g,new THREE.PlaneGeometry(2.12,2.30),glowMat,[0,cy,-.148]);model.halo=halo;
    const shell=mesh(g,new THREE.ExtrudeGeometry(shape,{depth:.045,bevelEnabled:true,bevelThickness:.008,bevelSize:.009,bevelSegments:3,curveSegments:96}),metal,[0,cy,-.10]);movable(model,shell,[0,0,-.08]);
    const outer=outline(kind,.989),inner=outline(kind,.947);
    outer.holes.push(new THREE.Path(inner.getPoints(128).reverse()));
    const diffuser=mesh(g,new THREE.ShapeGeometry(outer,96),led,[0,cy,-.045]);movable(model,diffuser,[0,0,.07]);
    const reflecting=new Reflector(new THREE.ShapeGeometry(outline(kind,.945),96),{color:0xe0e6eb,textureWidth:matchMedia('(max-width:760px)').matches?768:1536,textureHeight:matchMedia('(max-width:760px)').matches?768:1536,clipBias:.001,multisample:0});
    const drawReflection=reflecting.onBeforeRender;
    reflecting.onBeforeRender=function(renderer,scene,camera){
      const background=scene.background,fog=scene.fog,intensity=scene.backgroundIntensity,rotation=scene.backgroundRotation.y;
      const floorVisible=reflection.floor?.visible,roomVisible=reflection.room?.visible;
      if(reflection.texture){scene.background=reflection.texture;scene.backgroundIntensity=.85;scene.backgroundRotation.y=2.5;scene.fog=null;if(reflection.floor)reflection.floor.visible=false;}
      if(reflection.room)reflection.room.visible=true;
      try{drawReflection.call(this,renderer,scene,camera);}finally{scene.background=background;scene.fog=fog;scene.backgroundIntensity=intensity;scene.backgroundRotation.y=rotation;if(reflection.floor)reflection.floor.visible=floorVisible;if(reflection.room)reflection.room.visible=roomVisible;}
    };
    reflecting.position.set(0,cy,-.034);g.add(reflecting);movable(model,reflecting,[0,0,.23]);
    const touch=new THREE.Group();touch.position.set(0,cy-(kind==='round'?.59:.67),-.035);g.add(touch);
    const ring=mesh(touch,new THREE.TorusGeometry(.014,.0012,6,32),led);ring.rotation.z=Math.PI/2;
    box(touch,.0018,.011,.001,led,0,.011,.002,.0003);movable(model,touch,[0,0,.23]);
    return model;
  }
  return {
    create(category,kind){
      if(current)current.group.traverse(n=>{n.geometry?.dispose();if(n.isReflector)n.dispose();});
      current=category==='mirrors'?makeMirror(kind):makeShower(kind);return current;
    },
    setFinish(value){metal.color.set({bronze:0xb9a685,chrome:0xd4dbe4,black:0x232832}[value]);metal.roughness=value==='chrome'?.14:.23;},
    setLight(value){led.emissiveIntensity=.3+value*4;glowMat.opacity=value*.85;},
    dispose(){shared.forEach(m=>m.dispose());glowMap.dispose();current?.group.traverse(n=>{n.geometry?.dispose();if(n.isReflector)n.dispose();});}
  };
}
