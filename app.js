
(() => {
"use strict";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const uid = ()=>"p_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8);

const state = {
  projects: [],
  current: null,
  sourceImage: null,
  view: {zoom:1, panX:0, panY:0},
  history: [], future: [],
  activeTab: null,
  selection: {cell:null, cellKey:null, quarter:null, axis:null, axisEditing:false, shape:null, shapeEditing:false, guide:null, diag:null},
  pointer: {down:false, x:0,y:0,startX:0,startY:0,mode:null},
  pointers: new Map(),
  pinch: null,
  imageAids: null,
  cropSession:null,
  filterPreview:null,
  filteredCache:null,
  shapeEraser:{active:false,mode:"erase",size:18,hover:null},shapePulseUntil:0,
  panelHeight:220,
  layerDock:{height:104,open:false,editingId:null,menuId:null},
  autosaveTimer: null,
};

const defaults = () => ({
  id: uid(),
  name:"",
  createdAt:Date.now(),
  updatedAt:Date.now(),
  savePlace:"device",
  imageData:"",
  frameShape:"original",
  document:{paperSize:"A4",orientation:"portrait",unit:"mm"},
  imageAdjust:{brightness:0, shadows:0, grayscale:false, grayscaleAmount:0, opacity:100},
  imageTransform:{x:0,y:0,scale:1},
  imageGuides:[],
  crop:{x:0,y:0,w:1,h:1,enabled:false},
  imageFilter:{type:"none",bwAmount:70,grayAmount:100},
  grid:{
    visible:false, rows:4, cols:4, color:"#ff3b30", opacity:60, thickness:1.4,
    labels:true, labelColor:"#ff3b30", labelOpacity:80, labelSize:12, labelPosition:"top-right",
    offsetX:0, offsetY:0, originRight:null,originTop:null,cellSize:null,locked:false,labelWindow:null, numberingStart:null, numberingApproved:false,numberingMap:null,
    rulerVisible:false, rulerMode:"grid", rulerUnit:"cm", rulerSides:["top","right"],
    rulerColor:"#ffffff", rulerOpacity:70, rulerThickness:.35,
    guidesVisible:true, guides:[]
  },
  notebook:{
    paper:"A4", orientation:"portrait", unit:"cm", squareSize:4, customWidth:21,customHeight:29.7,manualRows:null, manualCols:null,
    marginMode:"auto"
  },
  layers:[
    {id:"general", name:"عام", type:"normal", visible:true, opacity:100, locked:false, items:{basic:{},sub:{},axes:[],shapes:[],drawing:[]}}
  ],
  activeLayerId:"general",
  snapLevel:"medium",
  drawingSettings:{tool:"brush", size:2, opacity:100, color:"#111111"},
  drawingProfiles:{
    brush:{size:2,opacity:100,color:"#111111"},
    shade:{size:12,opacity:35,color:"#4a4a4a"},
    eraser:{size:16,opacity:100,color:"#ffffff"}
  },
  filter:{normal:"none", ai:null}
});

const db = {
  name:"ArtGridDB", store:"projects", version:1, inst:null,
  async open(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(this.name,this.version);
      req.onupgradeneeded=e=>{
        const d=e.target.result;
        if(!d.objectStoreNames.contains(this.store)) d.createObjectStore(this.store,{keyPath:"id"});
      };
      req.onsuccess=e=>{this.inst=e.target.result;resolve(this.inst)};
      req.onerror=()=>reject(req.error);
    });
  },
  async all(){
    await this.open();
    return new Promise((res,rej)=>{
      const tx=this.inst.transaction(this.store,"readonly");
      const req=tx.objectStore(this.store).getAll();
      req.onsuccess=()=>res(req.result||[]);
      req.onerror=()=>rej(req.error);
    });
  },
  async put(p){
    await this.open();
    return new Promise((res,rej)=>{
      const tx=this.inst.transaction(this.store,"readwrite");
      tx.objectStore(this.store).put(p);
      tx.oncomplete=()=>res();
      tx.onerror=()=>rej(tx.error);
    });
  },
  async del(id){
    await this.open();
    return new Promise((res,rej)=>{
      const tx=this.inst.transaction(this.store,"readwrite");
      tx.objectStore(this.store).delete(id);
      tx.oncomplete=()=>res();
      tx.onerror=()=>rej(tx.error);
    });
  }
};

const canvas=$("#mainCanvas"), ctx=canvas.getContext("2d");
const workspace=$("#workspaceWrap");
let DPR=Math.max(1,window.devicePixelRatio||1);

function toast(msg){
  const t=$("#toast"); t.textContent=msg; t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"),1600);
}

function snapshot(){
  if(!state.current) return;
  const copy=JSON.parse(JSON.stringify(state.current));
  state.history.push(copy);
  if(state.history.length>50) state.history.shift();
  state.future=[];
}
function freshImageAids(){return{visible:true,ruler:false,centerV:false,centerH:false,imageCenter:false,paperCenter:false,snapPaperCenter:false,snapCenters:false,snapGuides:false,guides:[]}}
function resetSessionAids(){state.imageAids=freshImageAids();state.selection.guide=null}
function loadProjectGuides(){const a=freshImageAids();state.current.imageGuides=state.current.imageGuides||[];a.guides=state.current.imageGuides;state.imageAids=a;state.selection.guide=null}
function resetTransientEditors(){state.cropSession=null;state.filterPreview=null;state.filteredCache=null}
function undo(){
  if(!state.current||!state.history.length) return;
  state.future.push(JSON.parse(JSON.stringify(state.current)));
  state.current=state.history.pop();resetTransientEditors();
  loadProjectGuides();renderAll();renderLayersDock();if(state.activeTab)renderPanel(state.activeTab);hydrateImage().then(renderAll);scheduleSave();
}
function redo(){
  if(!state.current||!state.future.length) return;
  state.history.push(JSON.parse(JSON.stringify(state.current)));
  state.current=state.future.pop();resetTransientEditors();
  loadProjectGuides();renderAll();renderLayersDock();if(state.activeTab)renderPanel(state.activeTab);hydrateImage().then(renderAll);scheduleSave();
}

function scheduleSave(){
  if(!state.current) return;
  $("#saveIndicator").textContent="غير محفوظ";
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer=setTimeout(saveCurrent,600);
}
async function saveCurrent(){
  if(!state.current) return;
  state.current.updatedAt=Date.now();
  try{
    await db.put(state.current);
    $("#saveIndicator").textContent="محفوظ";
    $("#projectStatus").textContent=state.current.name;
    await loadLibrary();
  }catch(error){
    console.error("تعذر الحفظ المحلي",error);
    $("#saveIndicator").textContent="تعذر الحفظ";
    toast("تعذر الحفظ المحلي. قد تكون مساحة التخزين ممتلئة.");
  }
}

async function loadLibrary(){
  state.projects=(await db.all()).sort((a,b)=>b.updatedAt-a.updatedAt);
  renderLibrary();
}
function renderLibrary(){
  const q=$("#projectSearch").value.trim().toLowerCase();
  const list=state.projects.filter(p=>!q||p.name.toLowerCase().includes(q));
  $("#emptyLibrary").classList.toggle("hidden",list.length>0);
  const g=$("#projectsGrid"); g.innerHTML="";
  list.forEach(p=>{
    const card=document.createElement("article"); card.className="project-card";
    card.innerHTML=`
      <div class="project-thumb">${p.imageData?`<img src="${p.imageData}" alt="">`:"بدون صورة"}</div>
      <div class="project-body">
        <h3>${escapeHtml(p.name)}</h3>
        <p>آخر تعديل: ${new Date(p.updatedAt).toLocaleString("ar-SA")}</p>
        <div class="project-actions">
          <button data-open="${p.id}" class="primary">فتح</button>
          <button data-rename="${p.id}">إعادة تسمية</button>
          <button data-export-project="${p.id}">GRP</button>
          <button data-delete="${p.id}" class="danger">حذف</button>
        </div>
      </div>`;
    g.appendChild(card);
  });
  $$("[data-open]").forEach(b=>b.onclick=()=>openProject(b.dataset.open));
  $$("[data-rename]").forEach(b=>b.onclick=()=>renameProject(b.dataset.rename));
  $$("[data-export-project]").forEach(b=>b.onclick=()=>exportProjectFile(b.dataset.exportProject));
  $$("[data-delete]").forEach(b=>b.onclick=()=>deleteProject(b.dataset.delete));
}
function escapeHtml(s){return (s||"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}

async function openProject(id){
  const p=state.projects.find(x=>x.id===id); if(!p)return;
  state.current=JSON.parse(JSON.stringify(p));
  state.current.document=state.current.document||{paperSize:"A4",orientation:state.current.frameShape==="landscape"?"landscape":"portrait",unit:"mm"};state.current.imageAdjust=state.current.imageAdjust||{};if(state.current.imageAdjust.grayscaleAmount==null)state.current.imageAdjust.grayscaleAmount=state.current.imageAdjust.grayscale?100:0;state.current.crop=Object.assign(defaults().crop,state.current.crop||{});state.current.imageFilter=Object.assign(defaults().imageFilter,state.current.imageFilter||{});state.current.notebook=Object.assign(defaults().notebook,state.current.notebook||{});state.current.grid=Object.assign(defaults().grid,state.current.grid||{});state.current.imageGuides=state.current.imageGuides||[];if(state.current.grid.locked)state.current.imageLocked=true;
  resetSessionAids();loadProjectGuides();state.layerDock={height:104,open:false,editingId:null,menuId:null};
  resetTransientEditors();
  state.history=[]; state.future=[];
  await hydrateImage();
  if(state.current.grid.locked)applyAutomaticNumbering();
  showEditor();
  fitView();
  renderAll();
}
async function renameProject(id){
  const p=state.projects.find(x=>x.id===id); if(!p)return;
  const n=prompt("اسم المشروع الجديد:",p.name); if(!n||!n.trim())return;
  p.name=n.trim(); p.updatedAt=Date.now(); await db.put(p); await loadLibrary();
}
async function deleteProject(id){
  if(!confirm("حذف المشروع نهائيًا من هذا الجهاز؟")) return;
  await db.del(id); await loadLibrary();
}
async function exportProjectFile(id){
  const p=state.projects.find(x=>x.id===id); if(!p)return;
  const blob=new Blob([JSON.stringify(p)],{type:"application/json"});
  showSaveShare([{blob,name:sanitizeName(p.name)+".grp",type:"application/json"}]);
}

async function hydrateImage(){
  state.sourceImage=null;
  if(!state.current?.imageData)return;
  state.sourceImage=await loadImg(state.current.imageData);
}
function loadImg(src){return new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=src;})}

function showEditor(){
  $("#libraryScreen").classList.remove("active");
  $("#editorScreen").classList.add("active");
  resizeCanvas();
  renderLayersDock();
  updateStatus();
}
function showLibrary(){
  $("#editorScreen").classList.remove("active");
  $("#libraryScreen").classList.add("active");
  closePanel();
  resetSessionAids();
  loadLibrary();
}

function resizeCanvas(){
  const r=workspace.getBoundingClientRect();
  DPR=Math.max(1,window.devicePixelRatio||1);
  canvas.width=Math.max(1,Math.floor(r.width*DPR));
  canvas.height=Math.max(1,Math.floor(r.height*DPR));
  canvas.style.width=r.width+"px"; canvas.style.height=r.height+"px";
  renderAll();
}
window.addEventListener("resize",()=>{resizeCanvas();renderLayersDock();});

function imageFrame(){
  if(!state.sourceImage) return null;
  const naturalW=state.sourceImage.naturalWidth||state.sourceImage.width,naturalH=state.sourceImage.naturalHeight||state.sourceImage.height,doc=state.current.document||(state.current.document={paperSize:"A4",orientation:state.current.frameShape==="landscape"?"landscape":"portrait",unit:"mm"}),mm=paperDimensionsMm(doc.paperSize),dims=doc.orientation==="landscape"?[mm[1],mm[0]]:mm,fw=dims[0]*4,fh=dims[1]*4,base=Math.min(1,fw/naturalW,fh/naturalH),iw=naturalW*base,ih=naturalH*base;
  return {iw,ih,fw,fh,imgX:fw-iw,imgY:0,paperWidthMm:dims[0],paperHeightMm:dims[1],pxPerMm:4};
}
function paperDimensionsMm(size){return({A3:[297,420],A4:[210,297],A5:[148,210],B5:[176,250]})[size]||[210,297]}
function activeCrop(){const c=state.cropSession?.rect||state.current?.crop||{x:0,y:0,w:1,h:1,enabled:false};return c.enabled===false?{x:0,y:0,w:1,h:1,enabled:false}:{x:clamp(c.x,0,1),y:clamp(c.y,0,1),w:clamp(c.w,.01,1),h:clamp(c.h,.01,1),enabled:true}}
function effectiveFilter(){const f=state.filterPreview||state.current?.imageFilter||{type:"none",bwAmount:70,grayAmount:100};if(f.type==="threshold")f.type="bw";return f}
function imageFilterCss(f){if(f.type==="gray")return `grayscale(${clamp(f.grayAmount??100,0,100)}%) contrast(.96) brightness(1.02)`;if(f.type==="bw")return `grayscale(100%) contrast(${.8+clamp(f.bwAmount??70,0,100)/250}) brightness(1.05)`;if(f.type==="lightGray")return `grayscale(100%) contrast(.72) brightness(1.22)`;return "none"}
function changeDocumentPaper(size,orientation){snapshot();const d=state.current.document||(state.current.document={paperSize:"A4",orientation:"portrait",unit:"mm"});if(size)d.paperSize=size;if(orientation)d.orientation=orientation;state.current.notebook.paper=d.paperSize;state.current.notebook.orientation=d.orientation;fitView();renderAll();scheduleSave();renderPanel("image")}
function fitView(){
  const f=imageFrame(); if(!f)return;
  const w=canvas.clientWidth,h=canvas.clientHeight;
  const margin=28;
  const z=Math.min((w-margin*2)/f.fw,(h-margin*2)/f.fh);
  state.view.zoom=z; state.view.panX=(w-f.fw*z)/2; state.view.panY=(h-f.fh*z)/2;
  updateStatus(); renderAll();
}
function screenToWorld(x,y){
  return {x:(x-state.view.panX)/state.view.zoom,y:(y-state.view.panY)/state.view.zoom};
}
function worldToScreen(x,y){
  return {x:x*state.view.zoom+state.view.panX,y:y*state.view.zoom+state.view.panY};
}

function renderAll(){
  if(!canvas.width||!canvas.height)return;
  ctx.save(); ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
  ctx.fillStyle="#E7E3DC"; ctx.fillRect(0,0,canvas.clientWidth,canvas.clientHeight);
  if(state.current&&state.sourceImage){
    ctx.save();
    ctx.translate(state.view.panX,state.view.panY);
    ctx.scale(state.view.zoom,state.view.zoom);
    drawProject(ctx,{mode:"current",includeImage:true});
    drawImageAids(ctx);
    drawCropOverlay(ctx);drawGridResizeOverlay(ctx);
    drawSelectionOverlay(ctx);
    ctx.restore();
  }
  ctx.restore();
  updateStatus();
}

function drawProject(g,opt={}){
  const p=state.current,f=imageFrame(); if(!p||!f)return;
  g.save();g.fillStyle="#fff";g.fillRect(0,0,f.fw,f.fh);g.restore();
  const adj=p.imageAdjust;
  if(opt.includeImage!==false){
    g.save();
    g.beginPath();g.rect(0,0,f.fw,f.fh);g.clip();
    g.globalAlpha=(adj.opacity??100)/100;
    const filter=effectiveFilter();g.filter=imageFilterCss(filter);
    const tr=p.imageTransform||(p.imageTransform={x:0,y:0,scale:1});
    const crop=activeCrop(),source=state.sourceImage,sw=source.naturalWidth||source.width,sh=source.naturalHeight||source.height;g.translate(f.imgX+tr.x,f.imgY+tr.y);g.scale(tr.scale,tr.scale);g.drawImage(source,crop.x*sw,crop.y*sh,crop.w*sw,crop.h*sh,crop.x*f.iw,crop.y*f.ih,crop.w*f.iw,crop.h*f.ih);
    g.restore();
  } else if(opt.whiteBackground){
    g.save(); g.fillStyle="#fff"; g.fillRect(0,0,f.fw,f.fh); g.restore();
  }

  const grid=p.grid;
  if(opt.includeGrid!==false && grid.visible) drawGrid(g,f);

  const layersToDraw = opt.layerIds ? p.layers.filter(l=>opt.layerIds.includes(l.id)) : p.layers.filter(l=>l.visible);
  for(const layer of layersToDraw){
    g.save(); g.globalAlpha=(layer.opacity??100)/100;
    drawLayer(g,layer,f,opt);
    g.restore();
  }

  if(opt.includeLegacyGuides===true && grid.guidesVisible) drawGuides(g,f);
}

function gridGeom(){
  const p=state.current,f=imageFrame(),gr=p.grid;
  if(!f)return null;
  const fallback=Math.min(f.fw/gr.cols,f.fh/gr.rows),cell=clamp(gr.cellSize||fallback,8,600);if(!gr.cellSize)gr.cellSize=cell;
  const gw=cell*gr.cols, gh=cell*gr.rows;
  if(gr.originRight==null){const oldX=(f.fw-gw)/2+(gr.offsetX||0);gr.originRight=oldX+gw}if(gr.originTop==null)gr.originTop=(f.fh-gh)/2+(gr.offsetY||0);const x=gr.originRight-gw,y=gr.originTop;
  return {x,y,cell,gw,gh};
}
function visibleImageBounds(){const f=imageFrame();if(!f)return null;const tr=state.current.imageTransform||(state.current.imageTransform={x:0,y:0,scale:1}),c=activeCrop(),x=Math.max(0,f.imgX+tr.x+c.x*f.iw*tr.scale),y=Math.max(0,f.imgY+tr.y+c.y*f.ih*tr.scale),right=Math.min(f.fw,f.imgX+tr.x+(c.x+c.w)*f.iw*tr.scale),bottom=Math.min(f.fh,f.imgY+tr.y+(c.y+c.h)*f.ih*tr.scale);return{x,y,right,bottom,w:Math.max(0,right-x),h:Math.max(0,bottom-y)}}
function cellIsComplete(v,r){const gg=gridGeom(),b=visibleImageBounds();if(!gg||!b)return false;const eps=.01,x=gg.x+v*gg.cell,y=gg.y+r*gg.cell;return x>=b.x-eps&&y>=b.y-eps&&x+gg.cell<=b.right+eps&&y+gg.cell<=b.bottom+eps}
function cellVisibleIntersection(v,r){const gg=gridGeom(),b=visibleImageBounds();if(!gg||!b||b.w<=0||b.h<=0)return null;const cx=gg.x+v*gg.cell,cy=gg.y+r*gg.cell,x=Math.max(cx,b.x),y=Math.max(cy,b.y),right=Math.min(cx+gg.cell,b.right),bottom=Math.min(cy+gg.cell,b.bottom),w=right-x,h=bottom-y;return w>.0001&&h>.0001?{x,y,right,bottom,w,h}:null}
function cellIntersectsVisibleImage(v,r){return !!cellVisibleIntersection(v,r)}
function drawGrid(g,f){
  const gr=state.current.grid, gg=gridGeom(); if(!gg)return;
  if(state.activeTab==="grid"&&!gr.locked){
    const ext=2*gg.cell;g.save();g.beginPath();g.rect(gg.x-ext,gg.y-ext,gg.gw+ext*2,gg.gh+ext*2);g.rect(gg.x,gg.y,gg.gw,gg.gh);try{g.clip("evenodd")}catch{g.clip()};g.strokeStyle="#ffd400";g.globalAlpha=.7;g.lineWidth=Math.max(.2,gg.cell*.014);g.beginPath();for(let c=-2;c<=gr.cols+2;c++){const x=gg.x+c*gg.cell;g.moveTo(x,gg.y-ext);g.lineTo(x,gg.y+gg.gh+ext)}for(let r=-2;r<=gr.rows+2;r++){const y=gg.y+r*gg.cell;g.moveTo(gg.x-ext,y);g.lineTo(gg.x+gg.gw+ext,y)}g.stroke();g.restore();
  }
  g.save();
  if(gr.locked){const b=visibleImageBounds();if(!b||b.w<=0||b.h<=0){g.restore();return}g.beginPath();g.rect(b.x,b.y,b.w,b.h);g.clip()}
  g.strokeStyle=gr.color; g.globalAlpha=gr.opacity/100;
  g.lineWidth=Math.max(.2,gg.cell*(gr.thickness/100));
  g.beginPath();
  for(let c=0;c<=gr.cols;c++){const x=gg.x+c*gg.cell;g.moveTo(x,gg.y);g.lineTo(x,gg.y+gg.gh);}
  for(let r=0;r<=gr.rows;r++){const y=gg.y+r*gg.cell;g.moveTo(gg.x,y);g.lineTo(gg.x+gg.gw,y);}
  g.stroke();
  g.restore();

  if(gr.labels&&gr.locked&&gr.numberingApproved&&gr.numberingStart){
    g.save();
    const b=visibleImageBounds();if(b){g.beginPath();g.rect(b.x,b.y,b.w,b.h);g.clip()}
    g.fillStyle=gr.labelColor; g.globalAlpha=gr.labelOpacity/100;
    g.font=`${Math.max(8,gg.cell*(gr.labelSize/100))}px system-ui`;
    g.textAlign="right"; g.textBaseline="top";
    for(let r=0;r<gr.rows;r++)for(let v=0;v<gr.cols;v++){
      const label=gridLabelForVisual(v,r);if(!label)continue;
      const ix=cellVisibleIntersection(v,r);if(!ix)continue;
      let tx=ix.right-4,ty=ix.y+4;
      if(gr.labelPosition==="top-left"){tx=ix.x+4;g.textAlign="left"}
      else if(gr.labelPosition==="bottom-right"){ty=Math.max(ix.y+2,ix.bottom-18)}
      else if(gr.labelPosition==="bottom-left"){tx=ix.x+4;ty=Math.max(ix.y+2,ix.bottom-18);g.textAlign="left"}
      else if(gr.labelPosition==="center"){tx=ix.x+ix.w/2;ty=ix.y+ix.h/2;g.textAlign="center";g.textBaseline="middle"}
      g.fillText(label,tx,ty); g.textAlign="right"; g.textBaseline="top";
    }
    g.restore();
  }

}
function colName(i){let n=i,s="";do{s=String.fromCharCode(65+(n%26))+s;n=Math.floor(n/26)-1}while(n>=0);return s}
function gridLabelForVisual(v,r){const gr=state.current.grid;if(!gr.numberingApproved||!cellIntersectsVisibleImage(v,r))return null;return gr.numberingMap?.[`${r},${gr.cols-1-v}`]||null}
function applyAutomaticNumbering(){const gr=state.current?.grid;if(!gr)return;let minV=Infinity,maxV=-1,minR=Infinity,maxR=-1;for(let r=0;r<gr.rows;r++)for(let v=0;v<gr.cols;v++)if(cellIntersectsVisibleImage(v,r)){minV=Math.min(minV,v);maxV=Math.max(maxV,v);minR=Math.min(minR,r);maxR=Math.max(maxR,r)}if(maxV<0){gr.numberingStart=null;gr.numberingMap={};gr.labelWindow=null;gr.numberingApproved=false;return}const map={};for(let r=minR;r<=maxR;r++)for(let v=minV;v<=maxV;v++)if(cellIntersectsVisibleImage(v,r))map[`${r},${gr.cols-1-v}`]=colName(maxV-v)+(r-minR+1);gr.numberingStart={row:minR,visual:maxV};gr.numberingMap=map;gr.labelWindow={minV,maxV,minR,maxR};gr.numberingApproved=true}
function numberedGridStats(){const w=state.current?.grid?.labelWindow;if(!state.current?.grid?.numberingApproved||!w)return{cols:0,rows:0,count:0};return{cols:w.maxV-w.minV+1,rows:w.maxR-w.minR+1,count:Object.keys(state.current.grid.numberingMap||{}).length,minV:w.minV,maxV:w.maxV,minR:w.minR,maxR:w.maxR}}
function drawRuler(g,gg){
  const gr=state.current.grid;
  if(gr.rulerMode==="real"){drawRealRuler(g,gg);return}
  g.save();
  g.strokeStyle=gr.rulerColor; g.fillStyle=gr.rulerColor; g.globalAlpha=gr.rulerOpacity/100;
  g.lineWidth=Math.max(.3,gg.cell*((gr.rulerThickness??.35)/100));
  g.font=`${Math.max(9,gg.cell*.075)}px system-ui`;g.textAlign="center";g.textBaseline="middle";
  const top=gr.rulerSides.includes("top"), right=gr.rulerSides.includes("right"), bottom=gr.rulerSides.includes("bottom"), left=gr.rulerSides.includes("left");
  const ticks=4;
  if(top||bottom){
    for(let c=0;c<=state.current.grid.cols;c++)for(let t=0;t<ticks;t++){
      const x=gg.x+c*gg.cell+(t/ticks)*gg.cell;
      const len=t===0?10:5;
      const label=rulerLabel(c,t,gr);
      if(top){g.beginPath();g.moveTo(x,gg.y);g.lineTo(x,gg.y-len);g.stroke();if(label)g.fillText(label,x,gg.y-20)}
      if(bottom){g.beginPath();g.moveTo(x,gg.y+gg.gh);g.lineTo(x,gg.y+gg.gh+len);g.stroke();if(label)g.fillText(label,x,gg.y+gg.gh+20)}
    }
  }
  if(right||left){
    for(let r=0;r<=state.current.grid.rows;r++)for(let t=0;t<ticks;t++){
      const y=gg.y+r*gg.cell+(t/ticks)*gg.cell;
      const len=t===0?10:5;
      const label=rulerLabel(r,t,gr);
      if(right){g.beginPath();g.moveTo(gg.x+gg.gw,y);g.lineTo(gg.x+gg.gw+len,y);g.stroke();if(label)g.fillText(label,gg.x+gg.gw+24,y)}
      if(left){g.beginPath();g.moveTo(gg.x,y);g.lineTo(gg.x-len,y);g.stroke();if(label)g.fillText(label,gg.x-24,y)}
    }
  }
  g.restore();
}
function drawRealRuler(g,gg){
  const gr=state.current.grid,metric=gr.rulerUnit!=="in",nu=state.current.notebook.unit||"cm",raw=state.current.notebook.squareSize||4,squareCm=nu==="mm"?raw/10:nu==="in"?raw*2.54:raw,step=metric?gg.cell/(squareCm*10):gg.cell/(squareCm/2.54*8),countX=Math.floor(gg.gw/step),countY=Math.floor(gg.gh/step),sides=gr.rulerSides;
  g.save();g.strokeStyle=gr.rulerColor;g.fillStyle=gr.rulerColor;g.globalAlpha=gr.rulerOpacity/100;g.lineWidth=Math.max(.3,gg.cell*((gr.rulerThickness??.35)/100));g.font=`${Math.max(9,gg.cell*.065)}px system-ui`;g.textAlign="center";g.textBaseline="middle";
  for(let i=0;i<=countX;i++){const x=gg.x+i*step,major=metric?i%10===0:i%8===0,mid=metric?i%5===0:i%4===0,len=major?12:mid?8:4;if(sides.includes("top")){g.beginPath();g.moveTo(x,gg.y);g.lineTo(x,gg.y-len);g.stroke();if(major)g.fillText(String(metric?i/10:i/8),x,gg.y-21)}if(sides.includes("bottom")){g.beginPath();g.moveTo(x,gg.y+gg.gh);g.lineTo(x,gg.y+gg.gh+len);g.stroke();if(major)g.fillText(String(metric?i/10:i/8),x,gg.y+gg.gh+21)}}
  for(let i=0;i<=countY;i++){const y=gg.y+i*step,major=metric?i%10===0:i%8===0,mid=metric?i%5===0:i%4===0,len=major?12:mid?8:4;if(sides.includes("right")){g.beginPath();g.moveTo(gg.x+gg.gw,y);g.lineTo(gg.x+gg.gw+len,y);g.stroke();if(major)g.fillText(String(metric?i/10:i/8),gg.x+gg.gw+24,y)}if(sides.includes("left")){g.beginPath();g.moveTo(gg.x,y);g.lineTo(gg.x-len,y);g.stroke();if(major)g.fillText(String(metric?i/10:i/8),gg.x-24,y)}}g.restore();
}
function rulerLabel(index,quarter,gr){
  if(gr.rulerMode==="grid")return quarter===0?String(index):["","¼","½","¾"][quarter];
  const cm=(state.current.notebook.squareSize||4)*(index+quarter/4),factor=gr.rulerUnit==="mm"?10:gr.rulerUnit==="in"?1/2.54:1,value=cm*factor;
  return Number.isInteger(value)?String(value):value.toFixed(2).replace(/0+$/,"").replace(/\.$/,"");
}
function drawGuides(g,f){
  const gr=state.current.grid;
  gr.guides.forEach(gu=>{
    if(gu.visible===false)return;
    g.save();g.strokeStyle=gu.color||gr.rulerColor;g.globalAlpha=(gu.opacity??70)/100;g.lineWidth=Math.max(.2,(gridGeom()?.cell||100)*((gu.thickness??.35)/100));g.setLineDash(gu.style==="solid"?[]:[8/state.view.zoom,6/state.view.zoom]);
    g.beginPath();
    if(gu.type==="v"){g.moveTo(gu.pos,0);g.lineTo(gu.pos,f.fh)}
    else{g.moveTo(0,gu.pos);g.lineTo(f.fw,gu.pos)}
    g.stroke();g.restore();
  });
}
function drawImageAids(g){
  const a=state.imageAids,f=imageFrame();if(!a?.visible||!f)return;const b=visibleImageBounds(),line=(x1,y1,x2,y2,color="#7567A8",dash=[8/state.view.zoom,6/state.view.zoom],alpha=.78,width=1.4)=>{g.save();g.strokeStyle=color;g.globalAlpha=alpha;g.lineWidth=Math.max(.4,width)/state.view.zoom;g.setLineDash(dash);g.beginPath();g.moveTo(x1,y1);g.lineTo(x2,y2);g.stroke();g.restore()};
  if(a.centerV)line(f.fw/2,0,f.fw/2,f.fh);if(a.centerH)line(0,f.fh/2,f.fw,f.fh/2);
  if(a.paperCenter){g.save();g.fillStyle="#B85C62";g.beginPath();g.arc(f.fw/2,f.fh/2,6/state.view.zoom,0,Math.PI*2);g.fill();g.restore()}
  if(a.imageCenter&&b){g.save();g.fillStyle="#2F8F83";g.beginPath();g.arc((b.x+b.right)/2,(b.y+b.bottom)/2,6/state.view.zoom,0,Math.PI*2);g.fill();g.restore()}
  for(const gu of a.guides){if(gu.visible===false)continue;line(gu.type==="v"?gu.pos:0,gu.type==="h"?gu.pos:0,gu.type==="v"?gu.pos:f.fw,gu.type==="h"?gu.pos:f.fh,gu.color||"#7567A8",gu.style==="solid"?[]:undefined,(gu.opacity??70)/100,(gu.thickness??.35)*4)}
  if(a.ruler)drawMetricImageRulers(g,f);
}
function drawMetricImageRulers(g,f){const z=state.view.zoom,px=f.pxPerMm,minorVisible=px*z>=2,halfVisible=px*z>=.9,fontSize=10/z,short=4/z,mid=7/z,long=11/z;g.save();g.strokeStyle="#5F5870";g.fillStyle="#4D4756";g.globalAlpha=.92;g.lineWidth=1/z;g.font=`600 ${fontSize}px system-ui`;g.textBaseline="bottom";g.textAlign="center";g.beginPath();g.moveTo(0,0);g.lineTo(f.fw,0);g.moveTo(f.fw,0);g.lineTo(f.fw,f.fh);g.stroke();for(let mm=0;mm<=Math.round(f.paperWidthMm);mm++){const major=mm%10===0,half=!major&&mm%5===0;if(!major&&!half&&!minorVisible)continue;if(half&&!halfVisible)continue;const x=f.fw-mm*px,len=major?long:half?mid:short;g.beginPath();g.moveTo(x,0);g.lineTo(x,len);g.stroke();if(major)g.fillText(String(mm/10),x,-3/z)}g.textBaseline="middle";g.textAlign="left";for(let mm=0;mm<=Math.round(f.paperHeightMm);mm++){const major=mm%10===0,half=!major&&mm%5===0;if(!major&&!half&&!minorVisible)continue;if(half&&!halfVisible)continue;const y=mm*px,len=major?long:half?mid:short;g.beginPath();g.moveTo(f.fw,y);g.lineTo(f.fw-len,y);g.stroke();if(major&&mm!==0)g.fillText(String(mm/10),f.fw+6/z,y)}g.restore()}
function cropWorldRect(rect=activeCrop()){const f=imageFrame(),tr=state.current.imageTransform;if(!f||!tr)return null;return{x:f.imgX+tr.x+rect.x*f.iw*tr.scale,y:f.imgY+tr.y+rect.y*f.ih*tr.scale,w:rect.w*f.iw*tr.scale,h:rect.h*f.ih*tr.scale}}
function drawCropOverlay(g){if(!state.cropSession)return;const r=cropWorldRect(state.cropSession.rect);if(!r)return;const s=8/state.view.zoom;g.save();g.fillStyle="rgba(20,18,24,.42)";g.beginPath();g.rect(0,0,imageFrame().fw,imageFrame().fh);g.rect(r.x,r.y,r.w,r.h);g.fill("evenodd");g.strokeStyle="#fff";g.lineWidth=2/state.view.zoom;g.setLineDash([7/state.view.zoom,5/state.view.zoom]);g.strokeRect(r.x,r.y,r.w,r.h);g.setLineDash([]);g.fillStyle="#7567A8";for(const p of [{x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x,y:r.y+r.h},{x:r.x+r.w,y:r.y+r.h}]){g.fillRect(p.x-s,p.y-s,s*2,s*2)}g.restore()}
function gridHandlePoints(){const gg=gridGeom();return gg?[{x:gg.x,y:gg.y},{x:gg.x+gg.gw,y:gg.y},{x:gg.x,y:gg.y+gg.gh},{x:gg.x+gg.gw,y:gg.y+gg.gh}]:[]}
function drawGridResizeOverlay(g){if(state.activeTab!=="grid"||state.current.grid.locked||!state.current.grid.visible)return;const s=7/state.view.zoom;g.save();g.fillStyle="#7567A8";g.strokeStyle="#fff";g.lineWidth=2/state.view.zoom;for(const p of gridHandlePoints()){g.beginPath();g.rect(p.x-s,p.y-s,s*2,s*2);g.fill();g.stroke()}g.restore()}
function snapImageTransform(tr){const a=state.imageAids,f=imageFrame();if(!a?.visible||!f)return tr;const tol=12/state.view.zoom,cx=f.imgX+tr.x+f.iw*tr.scale/2,cy=f.imgY+tr.y+f.ih*tr.scale/2,xs=[],ys=[];if(a.snapPaperCenter){xs.push(f.fw/2);ys.push(f.fh/2)}if(a.snapCenters){xs.push(f.fw/2);ys.push(f.fh/2)}if(a.snapGuides)for(const gu of a.guides){if(gu.visible===false)continue;(gu.type==="v"?xs:ys).push(gu.pos)}for(const x of xs)if(Math.abs(cx-x)<=tol){tr.x+=x-cx;break}for(const y of ys)if(Math.abs(cy-y)<=tol){tr.y+=y-cy;break}return tr}

function drawLayer(g,layer,f,opt){
  const items=layer.items||{};
  if(opt.includeBasic!==false) drawBasicDiags(g,items.basic||{});
  if(opt.includeSub!==false) drawSubDiags(g,items.sub||{});
  if(opt.includeAxes!==false) drawAxes(g,items.axes||[]);
  if(opt.includeShapes!==false) drawShapes(g,items.shapes||[]);
  if(opt.includeDrawing!==false) drawDrawing(g,items.drawing||[],f);
}
function cellRectByKey(key){
  const gg=gridGeom(); if(!gg)return null;
  const [r,c]=key.split(",").map(Number);
  return {x:gg.x+(state.current.grid.cols-1-c)*gg.cell,y:gg.y+r*gg.cell,w:gg.cell,h:gg.cell,r,c};
}
function drawBasicDiags(g,basic){
  for(const [key,item] of Object.entries(basic)){
    const r=cellRectByKey(key); if(!r)continue;
    drawDiagSet(g,r,item);
  }
}
function drawSubDiags(g,sub){
  for(const [key,item] of Object.entries(sub)){
    const [cell,quarter]=key.split("|");
    const r=cellRectByKey(cell); if(!r)continue;
    const q=Number(quarter), hw=r.w/2,hh=r.h/2;
    const qr=[
      {x:r.x+hw,y:r.y,w:hw,h:hh},{x:r.x,y:r.y,w:hw,h:hh},
      {x:r.x+hw,y:r.y+hh,w:hw,h:hh},{x:r.x,y:r.y+hh,w:hw,h:hh}
    ][q];
    drawDiagSet(g,qr,item);
  }
}
function drawDiagSet(g,r,item){
  const plus=item.plus, x=item.x;
  if(plus?.visible!==false && plus){
    g.save();g.strokeStyle=plus.color||"#00aaff";g.globalAlpha=(plus.opacity??100)/100;g.lineWidth=Math.max(.2,r.w*((plus.thickness??.35)/100));
    const cx=r.x+r.w/2,cy=r.y+r.h/2;g.beginPath();
    if(plus.parts?.top!==false){g.moveTo(cx,cy);g.lineTo(cx,r.y)}
    if(plus.parts?.bottom!==false){g.moveTo(cx,cy);g.lineTo(cx,r.y+r.h)}
    if(plus.parts?.right!==false){g.moveTo(cx,cy);g.lineTo(r.x+r.w,cy)}
    if(plus.parts?.left!==false){g.moveTo(cx,cy);g.lineTo(r.x,cy)}
    g.stroke();g.restore();
  }
  if(x?.visible!==false && x){
    g.save();g.strokeStyle=x.color||"#ff9500";g.globalAlpha=(x.opacity??100)/100;g.lineWidth=Math.max(.2,r.w*((x.thickness??.35)/100));
    const cx=r.x+r.w/2,cy=r.y+r.h/2;g.beginPath();
    if(x.parts?.tr!==false){g.moveTo(cx,cy);g.lineTo(r.x+r.w,r.y)}
    if(x.parts?.tl!==false){g.moveTo(cx,cy);g.lineTo(r.x,r.y)}
    if(x.parts?.br!==false){g.moveTo(cx,cy);g.lineTo(r.x+r.w,r.y+r.h)}
    if(x.parts?.bl!==false){g.moveTo(cx,cy);g.lineTo(r.x,r.y+r.h)}
    g.stroke();g.restore();
  }
}
function drawAxes(g,axes){
  for(const a of axes){
    if(a.visible===false)continue;
    g.save();g.strokeStyle=a.color||"#00e5ff";g.globalAlpha=(a.opacity??100)/100;g.lineWidth=Math.max(.2,(gridGeom()?.cell||100)*((a.thickness??.35)/100));
    if(a.dash==="dashed")g.setLineDash([10,7]); else if(a.dash==="dotted")g.setLineDash([2,6]);
    g.beginPath();g.moveTo(a.x1,a.y1);g.lineTo(a.x2,a.y2);g.stroke();
    if(a.showAngle){
      g.fillStyle=a.color||"#00e5ff";g.setLineDash([]);g.font=`${Math.max(10,(gridGeom()?.cell||100)*.09)}px system-ui`;
      g.fillText(`${axisAngle(a).toFixed(1)}°`,(a.x1+a.x2)/2,(a.y1+a.y2)/2);
    }
    g.restore();
  }
}
function axisAngle(a){
  let deg=Math.atan2(-(a.y2-a.y1),a.x2-a.x1)*180/Math.PI;
  if(deg<0)deg+=360;
  return deg;
}
function drawShapes(g,shapes){
  const f=imageFrame();if(!f)return;
  for(const s of shapes){
    if(s.visible===false)continue;
    const oc=document.createElement("canvas");oc.width=Math.ceil(f.fw);oc.height=Math.ceil(f.fh);const og=oc.getContext("2d");og.strokeStyle=s.color||"#ff2d55";og.globalAlpha=(s.opacity??100)/100;og.lineWidth=Math.max(.2,(gridGeom()?.cell||100)*((s.thickness??.35)/100));og.beginPath();if(s.type==="circle")og.arc(s.cx,s.cy,Math.abs(s.rx),0,Math.PI*2);else if(s.type==="ellipse")og.ellipse(s.cx,s.cy,Math.abs(s.rx),Math.abs(s.ry),s.rotation||0,0,Math.PI*2);else if(s.type==="rect"||s.type==="square")og.rect(s.x,s.y,s.w,s.h);else if(s.type==="triangle"){og.moveTo(s.p1.x,s.p1.y);og.lineTo(s.p2.x,s.p2.y);og.lineTo(s.p3.x,s.p3.y);og.closePath()}else if(s.type==="line"){og.moveTo(s.x1,s.y1);og.lineTo(s.x2,s.y2)}og.stroke();const masks=shapeMasks(s);if(masks.length){og.globalCompositeOperation="destination-out";og.globalAlpha=1;for(const m of masks){const e=shapeMaskToWorld(s,m);og.beginPath();og.arc(e.x,e.y,e.r,0,Math.PI*2);og.fill()}}g.drawImage(oc,0,0);
  }
}
function drawDrawing(g,strokes,f){
  if(!strokes.length)return;
  const layerCanvas=document.createElement("canvas");layerCanvas.width=Math.max(1,Math.ceil(f.fw));layerCanvas.height=Math.max(1,Math.ceil(f.fh));
  const layerCtx=layerCanvas.getContext("2d");
  for(const s of strokes){
    if(!s.points?.length)continue;
    layerCtx.save();
    if(s.tool==="eraser"){layerCtx.globalCompositeOperation="destination-out";layerCtx.strokeStyle="#000";layerCtx.globalAlpha=(s.opacity??100)/100}
    else{layerCtx.strokeStyle=s.color||"#111";layerCtx.globalAlpha=(s.opacity??100)/100}
    layerCtx.lineWidth=s.size||2;layerCtx.lineCap="round";layerCtx.lineJoin="round";
    if(s.tool==="shade")layerCtx.globalAlpha=((s.opacity??100)/100)*.35;
    layerCtx.beginPath();layerCtx.moveTo(s.points[0].x,s.points[0].y);
    for(let i=1;i<s.points.length;i++)layerCtx.lineTo(s.points[i].x,s.points[i].y);
    layerCtx.stroke();layerCtx.restore();
  }
  g.drawImage(layerCanvas,0,0);
}
function selectedCellContents(){
  const key=selectedCellKey(),item=key?activeItems()?.basic?.[key]:null,parts=[];
  if(item?.plus)parts.push("+");if(item?.x)parts.push("X");return parts.length?` (${parts.join(" و ")})`:"";
}
function pointSegmentDistance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(!l2)return Math.hypot(p.x-a.x,p.y-a.y);const t=clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/l2,0,1);return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy))}
function shapeHandles(s){
  if(s.type==="circle")return [{key:"radius",x:s.cx+s.rx,y:s.cy},{key:"move",x:s.cx,y:s.cy}];
  if(s.type==="ellipse")return [{key:"rx",x:s.cx+s.rx,y:s.cy},{key:"ry",x:s.cx,y:s.cy+s.ry},{key:"move",x:s.cx,y:s.cy}];
  if(s.type==="rect"||s.type==="square")return [{key:"tl",x:s.x,y:s.y},{key:"tr",x:s.x+s.w,y:s.y},{key:"br",x:s.x+s.w,y:s.y+s.h},{key:"bl",x:s.x,y:s.y+s.h}];
  if(s.type==="triangle")return [{key:"p1",...s.p1},{key:"p2",...s.p2},{key:"p3",...s.p3}];
  return [{key:"p1",x:s.x1,y:s.y1},{key:"p2",x:s.x2,y:s.y2}];
}
function shapeCenter(s){
  if(s.cx!=null)return {x:s.cx,y:s.cy};if(s.type==="rect"||s.type==="square")return{x:s.x+s.w/2,y:s.y+s.h/2};if(s.type==="triangle")return{x:(s.p1.x+s.p2.x+s.p3.x)/3,y:(s.p1.y+s.p2.y+s.p3.y)/3};return{x:(s.x1+s.x2)/2,y:(s.y1+s.y2)/2};
}
function shapeFrame(s){const c=shapeCenter(s);let w=1,h=1,rotation=0;if(s.type==="circle")w=h=Math.max(1,Math.abs(s.rx)*2);else if(s.type==="ellipse"){w=Math.max(1,Math.abs(s.rx)*2);h=Math.max(1,Math.abs(s.ry)*2);rotation=s.rotation||0}else if(s.type==="rect"||s.type==="square"){w=Math.max(1,Math.abs(s.w));h=Math.max(1,Math.abs(s.h))}else if(s.type==="triangle"){const xs=[s.p1.x,s.p2.x,s.p3.x],ys=[s.p1.y,s.p2.y,s.p3.y];w=Math.max(1,Math.max(...xs)-Math.min(...xs));h=Math.max(1,Math.max(...ys)-Math.min(...ys))}else{w=Math.max(1,Math.hypot(s.x2-s.x1,s.y2-s.y1));h=Math.max(8,(gridGeom()?.cell||100)*.08);rotation=Math.atan2(s.y2-s.y1,s.x2-s.x1)}return{...c,w,h,rotation,scale:(w+h)/2}}
function shapeWorldToMask(s,p,r){const f=shapeFrame(s),dx=p.x-f.x,dy=p.y-f.y,cs=Math.cos(-f.rotation),sn=Math.sin(-f.rotation);return{u:(dx*cs-dy*sn)/f.w,v:(dx*sn+dy*cs)/f.h,r:r/f.scale}}
function shapeMaskToWorld(s,m){const f=shapeFrame(s),x=m.u*f.w,y=m.v*f.h,cs=Math.cos(f.rotation),sn=Math.sin(f.rotation);return{x:f.x+x*cs-y*sn,y:f.y+x*sn+y*cs,r:Math.max(.5,m.r*f.scale)}}
function shapeMasks(s){if(!s.maskErasures)s.maskErasures=(s.erasures||[]).map(e=>shapeWorldToMask(s,e,e.r));if(s.erasures)delete s.erasures;return s.maskErasures}
function applyShapeMask(s,p,r,mode){const masks=shapeMasks(s);if(mode==="restore"){for(let i=masks.length-1;i>=0;i--){const e=shapeMaskToWorld(s,masks[i]);if(Math.hypot(e.x-p.x,e.y-p.y)<=r+e.r*.5)masks.splice(i,1)}}else{const last=masks.at(-1),m=shapeWorldToMask(s,p,r);if(!last||Math.hypot(shapeMaskToWorld(s,last).x-p.x,shapeMaskToWorld(s,last).y-p.y)>r*.25)masks.push(m)}}
function hitShape(p){
  const arr=activeItems().shapes,tol=12/state.view.zoom;
  for(let i=arr.length-1;i>=0;i--){const s=arr[i];for(const h of shapeHandles(s))if(Math.hypot(p.x-h.x,p.y-h.y)<=tol)return{index:i,handle:h.key};if(pointInShape(p,s,tol))return{index:i,handle:"move"}}
  return null;
}
function pointInShape(p,s,tol){if(s.type==="circle")return Math.hypot(p.x-s.cx,p.y-s.cy)<=Math.abs(s.rx)+tol;if(s.type==="ellipse")return ((p.x-s.cx)/(Math.abs(s.rx)+tol))**2+((p.y-s.cy)/(Math.abs(s.ry)+tol))**2<=1;if(s.type==="rect"||s.type==="square"){const x1=Math.min(s.x,s.x+s.w)-tol,x2=Math.max(s.x,s.x+s.w)+tol,y1=Math.min(s.y,s.y+s.h)-tol,y2=Math.max(s.y,s.y+s.h)+tol;return p.x>=x1&&p.x<=x2&&p.y>=y1&&p.y<=y2}if(s.type==="triangle"){const sign=(a,b,c)=>(a.x-c.x)*(b.y-c.y)-(b.x-c.x)*(a.y-c.y),d1=sign(p,s.p1,s.p2),d2=sign(p,s.p2,s.p3),d3=sign(p,s.p3,s.p1);return !((d1<0||d2<0||d3<0)&&(d1>0||d2>0||d3>0))}return pointSegmentDistance(p,{x:s.x1,y:s.y1},{x:s.x2,y:s.y2})<=tol}
function hitAxis(p){const arr=activeItems().axes,tol=12/state.view.zoom;for(let i=arr.length-1;i>=0;i--){const a=arr[i];if(Math.hypot(p.x-a.x1,p.y-a.y1)<=tol)return{index:i,handle:"start"};if(Math.hypot(p.x-a.x2,p.y-a.y2)<=tol)return{index:i,handle:"end"};if(pointSegmentDistance(p,{x:a.x1,y:a.y1},{x:a.x2,y:a.y2})<=tol)return{index:i,handle:"move"}}return null}
function pointerTolerance(e){return (e?.pointerType==="touch"?14:8)/state.view.zoom}
function diagSegments(rect,item,meta){
  const cx=rect.x+rect.w/2,cy=rect.y+rect.h/2,out=[];
  const add=(kind,part,x,y)=>{const d=item?.[kind];if(d&&d.visible!==false&&d.parts?.[part]!==false)out.push({...meta,kind,part,a:{x:cx,y:cy},b:{x,y}})};
  add("plus","top",cx,rect.y);add("plus","bottom",cx,rect.y+rect.h);add("plus","right",rect.x+rect.w,cy);add("plus","left",rect.x,cy);
  add("x","tr",rect.x+rect.w,rect.y);add("x","tl",rect.x,rect.y);add("x","br",rect.x+rect.w,rect.y+rect.h);add("x","bl",rect.x,rect.y+rect.h);
  return out;
}
function hitDiagonals(p,tol){
  const hits=[];
  for(const [key,item] of Object.entries(activeItems()?.basic||{})){const r=cellRectByKey(key);if(r)for(const s of diagSegments(r,item,{sub:false,key,quarter:null})){const d=pointSegmentDistance(p,s.a,s.b);if(d<=tol)hits.push({...s,d})}}
  for(const [compound,item] of Object.entries(activeItems()?.sub||{})){const [key,qv]=compound.split("|"),r=cellRectByKey(key);if(!r)continue;const q=+qv,hw=r.w/2,hh=r.h/2,qr=[{x:r.x+hw,y:r.y,w:hw,h:hh},{x:r.x,y:r.y,w:hw,h:hh},{x:r.x+hw,y:r.y+hh,w:hw,h:hh},{x:r.x,y:r.y+hh,w:hw,h:hh}][q];for(const s of diagSegments(qr,item,{sub:true,key,quarter:q})){const d=pointSegmentDistance(p,s.a,s.b);if(d<=tol)hits.push({...s,d})}}
  hits.sort((a,b)=>a.d-b.d);return hits;
}
function drawSelectionOverlay(g){
  const size=7/state.view.zoom;g.save();g.lineWidth=2/state.view.zoom;g.strokeStyle="#fff";g.fillStyle="#7567A8";
  if(state.shapePulseUntil>Date.now()&&Math.floor((state.shapePulseUntil-Date.now())/180)%2===0){g.save();g.strokeStyle="#7567A8";g.globalAlpha=.65;g.lineWidth=7/state.view.zoom;for(const s of activeItems()?.shapes||[]){if(s.visible===false)continue;g.beginPath();if(s.type==="circle")g.arc(s.cx,s.cy,Math.abs(s.rx),0,Math.PI*2);else if(s.type==="ellipse")g.ellipse(s.cx,s.cy,Math.abs(s.rx),Math.abs(s.ry),0,0,Math.PI*2);else if(s.type==="rect"||s.type==="square")g.rect(s.x,s.y,s.w,s.h);else if(s.type==="triangle"){g.moveTo(s.p1.x,s.p1.y);g.lineTo(s.p2.x,s.p2.y);g.lineTo(s.p3.x,s.p3.y);g.closePath()}else{g.moveTo(s.x1,s.y1);g.lineTo(s.x2,s.y2)}g.stroke()}g.restore()}
  const ds=state.selection.diag;if(ds){const map=ds.sub?activeItems()?.sub?.[`${ds.key}|${ds.quarter}`]:activeItems()?.basic?.[ds.key],r0=cellRectByKey(ds.key);if(map&&r0){let r=r0;if(ds.sub){const hw=r0.w/2,hh=r0.h/2;r=[{x:r0.x+hw,y:r0.y,w:hw,h:hh},{x:r0.x,y:r0.y,w:hw,h:hh},{x:r0.x+hw,y:r0.y+hh,w:hw,h:hh},{x:r0.x,y:r0.y+hh,w:hw,h:hh}][ds.quarter]}const segs=diagSegments(r,map,{}).filter(s=>s.kind===ds.kind);if(segs.length){g.save();g.strokeStyle="#7567A8";g.globalAlpha=.3;g.lineWidth=10/state.view.zoom;g.lineCap="round";g.beginPath();for(const seg of segs){g.moveTo(seg.a.x,seg.a.y);g.lineTo(seg.b.x,seg.b.y)}g.stroke();g.restore()}}}
  const shape=state.selection.shape==null?null:activeItems()?.shapes?.[state.selection.shape];if(shape){const hs=shapeHandles(shape),xs=hs.map(h=>h.x),ys=hs.map(h=>h.y);g.save();g.setLineDash([5/state.view.zoom,4/state.view.zoom]);g.strokeStyle="#7567A8";g.strokeRect(Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));g.setLineDash([]);for(const h of hs){g.beginPath();g.rect(h.x-size,h.y-size,size*2,size*2);g.fill();g.stroke()}g.restore()}
  const axis=state.selection.axis==null?null:activeItems()?.axes?.[state.selection.axis];if(axis&&state.activeTab==="axes")for(const p of [{x:axis.x1,y:axis.y1},{x:axis.x2,y:axis.y2}]){g.beginPath();g.arc(p.x,p.y,size,0,Math.PI*2);g.fill();g.stroke()}
  const guide=state.selection.guide==null?null:state.imageAids?.guides[state.selection.guide];if(guide&&state.activeTab==="image"){const f=imageFrame(),p=guide.type==="v"?{x:guide.pos,y:f.fh/2}:{x:f.fw/2,y:guide.pos};g.beginPath();g.arc(p.x,p.y,size,0,Math.PI*2);g.fill();g.stroke()}
  if(state.activeTab==="shapes"&&state.shapeEraser.active&&state.shapeEraser.hover){g.save();g.strokeStyle="#B85C62";g.setLineDash([5/state.view.zoom,4/state.view.zoom]);g.beginPath();g.arc(state.shapeEraser.hover.x,state.shapeEraser.hover.y,state.shapeEraser.size/state.view.zoom,0,Math.PI*2);g.stroke();g.restore()}
  const cell=state.selection.cell?cellRectByKey(selectedCellKey()):null;if(cell){g.strokeStyle="#ffd34d";g.setLineDash([6/state.view.zoom,4/state.view.zoom]);g.strokeRect(cell.x,cell.y,cell.w,cell.h);g.setLineDash([]);g.fillStyle="#ffd34d";g.font=`${14/state.view.zoom}px system-ui`;g.fillText(selectedCellContents().trim(),cell.x+4/state.view.zoom,cell.y+18/state.view.zoom)}
  g.restore();
}
function snapPoint(p){
  const level=state.current.snapLevel||"medium";if(level==="free")return p;const gg=gridGeom();if(!gg)return p;
  const vc=clamp(Math.floor((p.x-gg.x)/gg.cell),0,state.current.grid.cols-1),r=clamp(Math.floor((p.y-gg.y)/gg.cell),0,state.current.grid.rows-1),x=gg.x+vc*gg.cell,y=gg.y+r*gg.cell,candidates=[];
  const fractions=level==="simple"?[0,.5,1]:level==="medium"?[0,.25,.5,.75,1]:[0,.125,.25,.375,.5,.625,.75,.875,1];for(const fx of fractions)for(const fy of fractions)candidates.push({x:x+fx*gg.cell,y:y+fy*gg.cell});
  let best=p,dist=(level==="precise"?22:level==="medium"?16:12)/state.view.zoom;for(const q of candidates){const d=Math.hypot(p.x-q.x,p.y-q.y);if(d<dist){dist=d;best=q}}return best;
}
function hitGuide(p){const guides=state.imageAids?.guides||[],tol=12/state.view.zoom;for(let i=guides.length-1;i>=0;i--){const gu=guides[i];if(gu.visible===false)continue;if(gu.type==="v"?Math.abs(p.x-gu.pos)<=tol:Math.abs(p.y-gu.pos)<=tol)return i}return null}
function rulerDragType(p){const f=imageFrame(),tol=18/state.view.zoom;if(!f||!state.imageAids?.visible||!state.imageAids?.ruler)return null;if(p.y>=-tol&&p.y<=tol&&p.x>=0&&p.x<=f.fw)return"h";if(p.x>=f.fw-tol&&p.x<=f.fw+tol&&p.y>=0&&p.y<=f.fh)return"v";return null}
function updateStatus(){
  $("#zoomStatus").textContent=`${Math.round(state.view.zoom*100)}%`;
  if(state.current){
    $("#projectStatus").textContent=state.current.name;
    const l=getActiveLayer(); $("#activeLayerStatus").textContent=(l?.name||"عام")+" ▾";
    $("#gridStatus").textContent=`الصورة: ${state.current.imageLocked?"مثبتة":"حرة"} · الشبكة: ${state.current.grid.locked?"مثبتة":"حرة"} · الترقيم: ${state.current.grid.numberingApproved?"تلقائي":"غير متاح"}`;
    $("#cellStatus").textContent=`المربع: ${state.selection.cell||"—"}${selectedCellContents()}`;
    const es=$("#elementStatus");if(es){const d=state.selection.diag;if(d)es.textContent=`المحدد: قطر ${d.sub?"فرعي":"أساسي"} ${d.kind==="plus"?"+":"X"} — ${state.selection.cell}`;else if(state.selection.shape!=null)es.textContent="المحدد: شكل";else if(state.selection.axis!=null)es.textContent=`المحدد: محور ${axisAngle(activeItems().axes[state.selection.axis]).toFixed(1)}°`;else es.textContent="لا يوجد عنصر محدد"}
  }
}

function getActiveLayer(){return state.current?.layers.find(l=>l.id===state.current.activeLayerId)}
function activeItems(){return getActiveLayer()?.items}

function renderPanel(tab){
  if(!state.current)return;
  state.activeTab=tab;
  $$("#bottomToolbar button").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
  const panel=$("#contextPanel"); panel.classList.remove("hidden");
  if(tab==="image") panel.innerHTML=imagePanel();
  else if(tab==="filters") panel.innerHTML=filtersPanel();
  else if(tab==="grid") panel.innerHTML=gridPanel();
  else if(tab==="notebook") panel.innerHTML=notebookPanel();
  else if(tab==="basicDiag") panel.innerHTML=basicDiagPanel();
  else if(tab==="subDiag") panel.innerHTML=subDiagPanel();
  else if(tab==="axes") panel.innerHTML=axesPanel();
  else if(tab==="shapes") panel.innerHTML=shapesPanel();
  else if(tab==="layers") panel.innerHTML=layersPanel();
  else if(tab==="export") panel.innerHTML=exportPanel();
  const titles={image:"تعديل الصورة",filters:"فلاتر الرسم",grid:"الشبكة الرئيسية",notebook:"تجهيز شبكة الكراسة",basicDiag:"الأقطار الأساسية",subDiag:"الأقطار الفرعية",axes:"المحاور",shapes:"الأشكال",layers:"الطبقات",export:"التصدير"},content=panel.innerHTML;panel.style.setProperty("--options-sheet-height",`${state.panelHeight}px`);panel.innerHTML=`<div id="optionsResizeHandle" class="options-resize-handle" title="اسحبي لتغيير ارتفاع لوحة الخيارات"><span></span></div><div class="context-panel-header"><span>${titles[tab]||"الخيارات"}</span></div><div class="context-panel-body">${content}</div>`;
  bindPanelEvents(tab);
  bindOptionsResize(panel);
  $("#editorScreen").classList.add("options-open");
  renderLayersDock();
}
function closePanel(){
  $("#contextPanel").classList.add("hidden");
  $("#editorScreen").classList.remove("options-open");
  state.activeTab=null;
  $$("#bottomToolbar button").forEach(b=>b.classList.remove("active"));
  renderLayersDock();
}
function bindOptionsResize(panel){const h=panel.querySelector("#optionsResizeHandle");if(!h)return;let resizing=false;const begin=(startY,kind,e)=>{if(resizing)return;resizing=true;e?.preventDefault?.();const startH=panel.getBoundingClientRect().height,min=96,reserveLayers=matchMedia("(max-width:700px)").matches?104:0,max=innerHeight-parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top")||54)-parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bottom")||66)-parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--status")||32)-reserveLayers-16,point=ev=>ev.touches?.[0]?.clientY??ev.clientY,move=ev=>{ev.preventDefault?.();state.panelHeight=clamp(startH+(startY-point(ev)),min,max);panel.style.setProperty("--options-sheet-height",`${state.panelHeight}px`);renderLayersDock()},up=()=>{document.removeEventListener(kind+"move",move);document.removeEventListener(kind+"up",up);if(kind==="touch")document.removeEventListener("touchcancel",up);document.body.classList.remove("resizing-options");resizing=false;renderLayersDock()};document.body.classList.add("resizing-options");document.addEventListener(kind+"move",move,{passive:false});document.addEventListener(kind+"up",up,{once:true});if(kind==="touch")document.addEventListener("touchcancel",up,{once:true})};h.onmousedown=e=>begin(e.clientY,"mouse",e);h.ontouchstart=e=>begin(e.touches[0].clientY,"touch",e)}

function imagePanel(){
  const a=state.current.imageAdjust, d=state.current.document||(state.current.document={paperSize:"A4",orientation:"portrait",unit:"mm"});
  const h=state.imageAids||(state.imageAids=freshImageAids()),locked=!!state.current.imageLocked;
  return `
  <div class="panel-section"><div class="panel-title">مقاس ورقة مساحة العمل</div><div class="segmented">${["A3","A4","A5","B5"].map(v=>`<button data-paper-size="${v}" class="${d.paperSize===v?"active":""}">${v}</button>`).join("")}</div><div class="segmented"><button data-paper-orientation="portrait" class="${d.orientation==="portrait"?"active":""}">طولي</button><button data-paper-orientation="landscape" class="${d.orientation==="landscape"?"active":""}">عرضي</button></div>
  </div>
  <div class="panel-section"><div class="panel-title">تعديلات الصورة</div><div class="controls">
    <label>الشفافية <input id="imageOpacityRange" type="range" min="0" max="100" value="${a.opacity}"><span>${a.opacity}%</span></label>
    <button id="toggleImageLock">${locked?"فك تثبيت الصورة":"تثبيت الصورة"}</button>
  </div><p class="small">اسحبي الصورة لتحريكها داخل مساحة العمل، واستخدمي عجلة الماوس أو إصبعين لتكبيرها.</p></div>
  <div class="panel-section"><div class="panel-title">قص الصورة — غير مدمر</div><div class="controls"><button id="startFreeCrop">قص حر</button><button id="startAspectCrop">قص مع تثبيت النسبة</button>${state.cropSession?`<button id="applyCrop" class="primary">اعتماد القص</button><button id="cancelCrop">إلغاء العملية</button>`:""}<button id="resetCrop">إعادة ضبط القص إلى الأصل</button></div><p class="small">حرّكي إطار القص أو مقابض الزوايا. تبقى الصورة الأصلية محفوظة داخل المشروع.</p></div>
  <div class="panel-section"><div class="panel-title">مساعدات ضبط الصورة</div><div class="controls"><button id="toggleAllAids">${h.visible?"إخفاء جميع المساعدات":"إظهار المساعدات"}</button><button id="toggleAidRuler">${h.ruler?"إخفاء المسطرة":"إظهار المسطرة"}</button><label><input type="checkbox" data-image-aid="centerV" ${h.centerV?"checked":""}> خط المنتصف الرأسي</label><label><input type="checkbox" data-image-aid="centerH" ${h.centerH?"checked":""}> خط المنتصف الأفقي</label><label><input type="checkbox" data-image-aid="imageCenter" ${h.imageCenter?"checked":""}> مركز الصورة</label><label><input type="checkbox" data-image-aid="paperCenter" ${h.paperCenter?"checked":""}> مركز الورقة</label><button id="clearGuides">حذف الخطوط الإرشادية غير المقفلة</button><label><input type="checkbox" data-image-snap="snapPaperCenter" ${h.snapPaperCenter?"checked":""}> التقاط إلى مركز الورقة</label><label><input type="checkbox" data-image-snap="snapCenters" ${h.snapCenters?"checked":""}> التقاط إلى خطوط المنتصف</label><label><input type="checkbox" data-image-snap="snapGuides" ${h.snapGuides?"checked":""}> التقاط إلى الإرشادات</label></div><p class="small">اسحبي من المسطرة العلوية لإنشاء خط أفقي، أو من المسطرة الجانبية لإنشاء خط عمودي. أعيدي الخط خارج الورقة لحذفه.</p>${guideStyleEditor()}</div>`;
}
function filtersPanel(){
  const f=state.filterPreview||state.current.imageFilter||{type:"none",bwAmount:70,grayAmount:100};return `<div class="panel-section"><div class="panel-title">فلاتر عادية غير مدمرة</div><div class="controls"><button data-normal-filter="bw" class="${f.type==="bw"||f.type==="threshold"?"active":""}">أبيض وأسود تفصيلي</button><label>قوة التباين <input id="bwStrength" type="range" min="0" max="100" step="1" value="${f.bwAmount??70}"><span>${f.bwAmount??70}%</span></label><button data-normal-filter="gray" class="${f.type==="gray"?"active":""}">رمادي ناعم</button><label>قوة الرمادي <input id="grayStrength" type="range" min="0" max="100" step="1" value="${f.grayAmount??100}"><span>${f.grayAmount??100}%</span></label><button data-normal-filter="lightGray" class="${f.type==="lightGray"?"active":""}">رمادي فاتح للرسم</button><button id="applyNormalFilter" class="primary">تطبيق</button><button id="cancelNormalFilter">إلغاء المعاينة</button><button id="resetNormalFilter">إعادة للأصل</button></div><p class="small">تحافظ الخيارات على التفاصيل والدرجات المتوسطة ولا تحول الصورة إلى فصل ثنائي حاد.</p></div><div class="panel-section"><div class="panel-title">فلاتر AI</div><div class="controls"><button id="aiFiltersBtn">Clean Ink Portrait</button></div><p class="small">واجهة مستقلة جاهزة للإضافة المستقبلية، وتحتاج Backend وAPI للتشغيل.</p></div>`;
}
function gridPanel(){
  const g=state.current.grid,gg=gridGeom(),disabled=g.locked?"disabled":"",ns=numberedGridStats();
  return `
  <div class="panel-section"><div class="panel-title">إعداد الشبكة</div><div class="controls">
    <label>عدد الأعمدة: <b id="gridColsValue">${g.cols}</b><button id="gridColsMinus" ${disabled}>−</button><input id="gridCols" type="range" min="1" max="50" step="1" value="${g.cols}" ${disabled}><button id="gridColsPlus" ${disabled}>+</button></label>
    <label>عدد الصفوف: <b id="gridRowsValue">${g.rows}</b><button id="gridRowsMinus" ${disabled}>−</button><input id="gridRows" type="range" min="1" max="50" step="1" value="${g.rows}" ${disabled}><button id="gridRowsPlus" ${disabled}>+</button></label>
    <span id="gridGeometryInfo">${g.cols} أعمدة × ${g.rows} صفوف</span>
    <button id="toggleGrid">${g.visible?"إخفاء الشبكة":"إظهار الشبكة"}</button>
    <button id="moveGridBtn">${g.locked?"فك تثبيت الشبكة":"تحريك الشبكة"}</button>
    <button id="lockGridBtn">${g.locked?"الشبكة مثبتة":"تثبيت الشبكة على الصورة"}</button>
  </div></div>
  <div class="panel-section"><div class="panel-title">مظهر الشبكة</div><div class="controls">
    <label>اللون <input id="gridColor" class="color-input" type="color" value="${g.color}"></label>
    <label>الشفافية <input id="gridOpacity" type="range" min="0" max="100" value="${g.opacity}"><span>${g.opacity}%</span></label>
    <label>السماكة <input id="gridThickness" type="range" min="0.1" max="5" step="0.1" value="${g.thickness}"><span>${g.thickness}%</span></label>
  </div></div>
  <div class="panel-section"><div class="panel-title">الترقيم التلقائي</div><div class="controls">
    <span>${g.locked&&g.numberingApproved?`تم ترقيم ${ns.count} خلية متقاطعة · ${ns.cols} أعمدة × ${ns.rows} صفوف`:g.locked?"لا توجد خلايا متقاطعة مع الصورة":"يُنشأ الترقيم تلقائيًا عند تثبيت الشبكة"}</span>
    <button id="toggleLabels">${g.labels?"إخفاء الترقيم":"إظهار الترقيم"}</button>
    <select id="labelPosition">
      ${[["top-right","أعلى يمين"],["top-left","أعلى يسار"],["bottom-right","أسفل يمين"],["bottom-left","أسفل يسار"],["center","الوسط"]].map(([v,t])=>`<option value="${v}" ${g.labelPosition===v?"selected":""}>${t}</option>`).join("")}
    </select>
    <label>الحجم <input id="labelSize" type="range" min="5" max="30" value="${g.labelSize}"><span>${g.labelSize}%</span></label>
  </div></div>`;
}
function guideStyleEditor(){
  const count=state.imageAids?.guides?.length||0,guide=state.selection.guide==null?null:state.imageAids?.guides[state.selection.guide];if(!guide)return `<p class="small" id="savedGuidesCount">عدد الخطوط الإرشادية المحفوظة: ${count}. لا تظهر في التصدير إلا عند اختيار تصدير الأدلة.</p>`;
  return `<div class="result-card"><b>الخط الإرشادي المحدد</b><span id="savedGuidesCount"> · المحفوظة: ${count}</span><div class="controls element-style"><label>اللون <input id="guideColor" class="color-input" type="color" value="${guide.color||"#7567A8"}"></label><label>الشفافية <input id="guideOpacity" type="range" min="0" max="100" value="${guide.opacity??70}"></label><label>السماكة <input id="guideThickness" type="range" min="0.1" max="5" step="0.1" value="${guide.thickness??.35}"></label><label>النمط <select id="guideStyle"><option value="solid">متصل</option><option value="dashed">متقطع</option></select></label><button id="guideVisible">${guide.visible===false?"إظهار":"إخفاء"}</button><button id="guideLock">${guide.locked?"فك القفل":"قفل"}</button><button id="deleteGuide" class="danger">حذف الخط</button></div></div>`;
}
function notebookPanel(){
  const n=state.current.notebook;
  const ready=state.current.grid.locked&&state.current.grid.numberingApproved,ns=numberedGridStats();
  return `
  <div class="panel-section"><div class="panel-title">تجهيز شبكة الكراسة</div><div class="controls">
    <label>مقاس الورقة <select id="paperSize">${["A3","A4","A5","B5"].map(v=>`<option value="${v}" ${n.paper===v?"selected":""}>${v}</option>`).join("")}</select></label>
    <select id="paperOrientation"><option value="portrait" ${n.orientation==="portrait"?"selected":""}>طولي</option><option value="landscape" ${n.orientation==="landscape"?"selected":""}>عرضي</option></select>
    <button id="calcNotebook" class="primary" ${ready?"":"disabled"}>تجهيز الشبكة على الورقة</button>
  </div>
  ${ready?`<p class="small">الأعمدة: <b>${ns.cols}</b> · الصفوف: <b>${ns.rows}</b> — محسوبة تلقائيًا من الخلايا المتقاطعة، بما فيها الجزئية.</p>`:`<div class="result-card">ثبتي الشبكة على الصورة أولًا قبل تجهيز شبكة الكراسة</div>`}
  <div id="notebookResult"></div></div>`;
}
function basicDiagPanel(){
  const sel=state.selection.cell,key=selectedCellKey(),item=key?activeItems()?.basic?.[key]:null;
  return `
  <div class="panel-section"><div class="panel-title">الأقطار الأساسية</div>
    <p class="small">اضغطي على مربع من الشبكة لاختياره. المربع الحالي: <b>${sel||"لا يوجد"}</b></p>
    <div class="controls"><button id="addPlus" class="secondary">إضافة +</button><button id="addX" class="secondary">إضافة X</button><button id="deleteBasic" class="danger">مسح المربع</button></div>
    <div class="controls"><button id="copyBasic">نسخ</button><button id="pasteBasic" ${diagClipboards.basic?"":"disabled"}>لصق</button></div>
    <div id="basicCopyMenu" class="copy-menu hidden">${copyMenuOptions("data-diag-copy")}</div>
  </div>
  ${diagEditor("plus",item?.plus,false)}${diagEditor("x",item?.x,false)}`;
}
function subDiagPanel(){
  const key=selectedSubKey(),item=key?activeItems()?.sub?.[key]:null;
  return `
  <div class="panel-section"><div class="panel-title">الأقطار الفرعية</div>
    <p class="small">اضغطي على مربع، ثم على أحد أرباعه. الربع الحالي: <b>${state.selection.quarter??"لا يوجد"}</b></p>
    <div class="controls"><button id="addSubPlus" class="secondary">إضافة +</button><button id="addSubX" class="secondary">إضافة X</button><button id="deleteSub" class="danger">مسح المربع</button></div>
    <div class="controls"><button id="copySub">نسخ</button><button id="pasteSub" ${diagClipboards.sub?"":"disabled"}>لصق</button></div>
    <div id="subCopyMenu" class="copy-menu hidden">${copyMenuOptions("data-sub-copy")}</div>
  </div>${diagEditor("plus",item?.plus,true)}${diagEditor("x",item?.x,true)}`;
}
function copyMenuOptions(attr){return `<button ${attr}="plus">+ فقط</button><button ${attr}="x">X فقط</button><button ${attr}="full">+ و X كاملًا</button><button ${attr}="appearance">المظهر فقط</button><button ${attr}="visibility">الإظهار والإخفاء فقط</button>`}
function diagEditor(kind,value,sub){
  const title=kind==="plus"?"خصائص + المستقلة":"خصائص X المستقلة";
  if(!value)return `<div class="panel-section"><div class="panel-title">${title}</div><p class="small">أضيفي ${kind==="plus"?"+":"X"} أولًا لإظهار خصائصه.</p></div>`;
  const parts=kind==="plus"?[["top","أعلى"],["bottom","أسفل"],["right","يمين"],["left","يسار"]]:[["tr","أعلى يمين"],["tl","أعلى يسار"],["br","أسفل يمين"],["bl","أسفل يسار"]];
  return `<div class="panel-section"><div class="panel-title">${title}</div><div class="controls diag-style-controls">
    <label>اللون <input class="color-input" type="color" data-diag-prop="color" data-diag-kind="${kind}" data-diag-sub="${sub}" value="${value.color}"></label>
    <label>الشفافية <input type="range" min="0" max="100" data-diag-prop="opacity" data-diag-kind="${kind}" data-diag-sub="${sub}" value="${value.opacity}"><span>${value.opacity}%</span></label>
    <label>السماكة <input type="range" min="0.1" max="5" step="0.1" data-diag-prop="thickness" data-diag-kind="${kind}" data-diag-sub="${sub}" value="${value.thickness}"><span>${value.thickness}%</span></label>
  </div><div class="controls diag-visibility-controls"><button data-diag-visible="${kind}" data-diag-sub="${sub}">${value.visible===false?"إظهار":"إخفاء"} ${kind==="plus"?"+":"X"}</button>
    ${parts.map(([part,label])=>`<button class="${value.parts?.[part]!==false?"primary":""}" data-diag-part="${part}" data-diag-kind="${kind}" data-diag-sub="${sub}">${label}</button>`).join("")}
  </div></div>`;
}
function axesPanel(){
  const active=state.selection.axis;
  const axis=active==null?null:activeItems().axes[active];
  return `
  <div class="panel-section"><div class="panel-title">إضافة محور</div><div class="controls">
    <button data-axis-angle="free">حر</button>
    ${[0,30,45,60,90].map(a=>`<button data-axis-angle="${a}">${a}°</button>`).join("")}
    <button id="toggleAllAxes">إظهار/إخفاء جميع المحاور</button>
    <label>الالتقاط <select id="snapLevel"><option value="free">حر</option><option value="simple">بسيط</option><option value="medium">متوسط</option><option value="precise">دقيق</option></select></label>
  </div></div>
  <div class="panel-section"><div class="panel-title">المحور المحدد</div><div class="controls">
    ${axis?`<button id="editSelectedAxis" class="primary">تعديل</button>`:""}
    <button id="toggleAxisAngle">إظهار الزاوية</button>
    <button id="unlockAxis">تحرير الزاوية</button>
    <button id="deleteAxis">حذف</button>${elementStyleEditor("axis",axis)}
  </div>${axis?axisCoordinateEditor(axis):""}<p class="small">انقري المحور لتحديده، واسحبي الطرفين أو الخط كاملًا. الزاوية الحالية: <b>${axis?axisAngle(axis).toFixed(1)+"°":"—"}</b></p></div>`;
}
function axisCoordinateEditor(axis){return `<div class="controls"><label>X1 <input type="number" data-axis-coordinate="x1" value="${axis.x1.toFixed(1)}"></label><label>Y1 <input type="number" data-axis-coordinate="y1" value="${axis.y1.toFixed(1)}"></label><label>X2 <input type="number" data-axis-coordinate="x2" value="${axis.x2.toFixed(1)}"></label><label>Y2 <input type="number" data-axis-coordinate="y2" value="${axis.y2.toFixed(1)}"></label></div>`}
function shapesPanel(){
  const shape=state.selection.shape==null?null:activeItems().shapes[state.selection.shape];
  return `
  <div class="panel-section"><div class="panel-title">إضافة شكل</div><div class="controls">
    <button data-shape="circle">دائرة</button>
    <button data-shape="square">مربع</button>
    <button data-shape="ellipse">بيضاوي</button>
    <button data-shape="triangle">مثلث</button>
    <button data-shape="rect">مستطيل</button><button data-shape="line">خط</button>
    <button id="shapeEraserBtn" class="${state.shapeEraser.active&&state.shapeEraser.mode==="erase"?"primary":""}">ممحاة الأشكال</button><button id="shapeRestoreBtn" class="${state.shapeEraser.active&&state.shapeEraser.mode==="restore"?"primary":""}">استعادة أجزاء الشكل</button><label>حجم الفرشاة <input id="shapeEraserSize" type="range" min="4" max="80" value="${state.shapeEraser.size}"><span>${state.shapeEraser.size}</span></label>
    <button id="toggleAllShapes">إظهار/إخفاء جميع الأشكال</button>
  </div><p class="small">بعد اختيار الشكل، اسحبي على لوحة العمل لإنشائه. انقري شكلًا موجودًا لتحديده.</p>${shape?`<div class="controls"><button id="editSelectedShape" class="primary">تعديل</button><button id="deleteSelectedShape" class="danger">حذف</button></div>`:""}${elementStyleEditor("shape",shape)}${shape?shapeMeasurements(shape):""}</div>`;
}
function shapeMeasurements(s){
  let text="";const unit=state.current.notebook.unit||"cm",pxmm=imageFrame()?.pxPerMm||4,factor=unit==="mm"?1/pxmm:unit==="in"?1/(pxmm*25.4):1/(pxmm*10),u=unit==="cm"?"سم":unit==="mm"?"مم":"إنش",len=v=>`${fmt(Math.abs(v)*factor)} ${u}`,area=v=>`${fmt(Math.abs(v)*factor*factor)} ${u}²`;
  if(s.type==="circle")text=`القطر: ${len(s.rx*2)} · المساحة: ${area(Math.PI*s.rx*s.rx)}`;
  else if(s.type==="ellipse")text=`العرض: ${len(s.rx*2)} · الارتفاع: ${len(s.ry*2)} · المساحة التقريبية: ${area(Math.PI*s.rx*s.ry)}`;
  else if(s.type==="rect"||s.type==="square")text=`العرض: ${len(s.w)} · الارتفاع: ${len(s.h)} · المساحة: ${area(s.w*s.h)}`;
  else if(s.type==="triangle"){
    const d=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),a=d(s.p1,s.p2),b=d(s.p2,s.p3),c=d(s.p3,s.p1),ar=Math.abs((s.p1.x*(s.p2.y-s.p3.y)+s.p2.x*(s.p3.y-s.p1.y)+s.p3.x*(s.p1.y-s.p2.y))/2);text=`الأضلاع: ${len(a)}، ${len(b)}، ${len(c)} · المساحة التقريبية: ${area(ar)}`;
  }else if(s.type==="line")text=`الطول: ${len(Math.hypot(s.x2-s.x1,s.y2-s.y1))} · الزاوية: ${axisAngle(s).toFixed(1)}°`;
  return `<div class="result-card"><b>قياسات الشكل</b><br>${text}</div>`;
}
function elementStyleEditor(type,item){
  if(!item)return `<p class="small">أنشئي عنصرًا لتعديل خصائصه المستقلة.</p>`;
  return `<div class="controls element-style"><label>اللون <input class="color-input" type="color" data-element-style="color" data-element-type="${type}" value="${item.color}"></label><label>الشفافية <input type="range" min="0" max="100" data-element-style="opacity" data-element-type="${type}" value="${item.opacity??100}"></label><label>السماكة <input type="range" min="0.1" max="5" step="0.1" data-element-style="thickness" data-element-type="${type}" value="${item.thickness??.35}"></label><button data-element-visible="${type}">${item.visible===false?"إظهار":"إخفاء"}</button></div>`;
}
function layersPanel(){
  const p=state.current;
  return `
  <div class="panel-section"><div class="panel-title">الطبقات</div><div class="controls">
    <button id="newNormalLayer">+ طبقة عادية</button>
    <button id="newDrawingLayer">+ طبقة رسم</button>
    <button id="showAllLayers">إظهار الكل</button>
    <button id="hideAllLayers">إخفاء الكل</button>
  </div></div>
  <div class="panel-section"><p class="small">استخدمي لوحة الطبقات السفلية؛ اسحبي مقبضها لتغيير الارتفاع دون التأثير على Canvas.</p></div>
  ${getActiveLayer()?.type==="drawing"?drawingControls():""}`;
}
function exportPanel(){return `<div class="panel-section"><div class="panel-title">خيارات التصدير</div><div class="export-grid"><button data-sheet-export="imageGrid">الصورة + الشبكة الرئيسية فقط</button><button data-sheet-export="imageAll">الصورة + الشبكة + جميع الطبقات</button><button data-sheet-export="imageLayer">الصورة + الشبكة + طبقة محددة</button><button data-sheet-export="whiteDiags">خلفية بيضاء + الشبكة + الأقطار</button><button data-sheet-export="gridDrawing">الشبكة + الأقطار + الرسم</button><button data-sheet-export="drawingOnly">طبقة الرسم فقط</button><button data-sheet-export="current">تصدير كما يظهر الآن</button><button data-sheet-export="all">حفظ كل الخيارات السابقة دفعة واحدة</button></div></div>`}
function layerRow(l){
  return `<div class="layer-row ${l.id===state.current.activeLayerId?"active":""}" data-layer-row="${l.id}">
    <span class="drag-handle" title="ترتيب الطبقة">⠿</span>
    <button data-layer-vis="${l.id}" title="إظهار أو إخفاء الطبقة" aria-label="إظهار أو إخفاء الطبقة">${l.visible?"◉":"○"}</button>
    <button data-layer-active="${l.id}" class="layer-name-btn">${escapeHtml(l.name)} <span aria-hidden="true">⌄</span></button>
    <label title="شفافية"><input data-layer-opacity="${l.id}" type="range" min="0" max="100" value="${l.opacity}"></label>
    <button data-layer-up="${l.id}" title="رفع الطبقة">↑</button><button data-layer-down="${l.id}" title="خفض الطبقة">↓</button>
    <button data-layer-lock="${l.id}" title="قفل أو فتح الطبقة">${l.locked?"🔒":"🔓"}</button>
    <button data-layer-edit="${l.id}" title="تعديل الطبقة" aria-label="تعديل الطبقة">✎</button>
    <button data-layer-more="${l.id}" title="خيارات إضافية">⋯</button>
  </div>`;
}
function layerEditor(l){return `<form id="layerEditForm" class="layer-edit-form"><b>تعديل الطبقة</b>${l.locked?`<p class="small">هذه الطبقة مقفلة، ويمكن إلغاء قفلها من هنا.</p>`:""}<label>اسم الطبقة<input id="layerEditName" type="text" value="${escapeHtml(l.name)}" required></label><label>الشفافية <input id="layerEditOpacity" type="range" min="0" max="100" value="${l.opacity}"><span id="layerEditOpacityValue">${l.opacity}%</span></label><label><input id="layerEditVisible" type="checkbox" ${l.visible?"checked":""}> إظهار الطبقة</label><label><input id="layerEditLocked" type="checkbox" ${l.locked?"checked":""}> قفل الطبقة</label><div class="controls"><button type="submit" class="primary">حفظ</button><button type="button" id="cancelLayerEdit">إلغاء</button></div></form>`}
function layerActionMenu(l){return `<div class="layer-action-menu"><b>${escapeHtml(l.name)}</b><button data-inline-layer-action="edit" data-id="${l.id}">تعديل الطبقة</button><button data-inline-layer-action="duplicate" data-id="${l.id}">تكرار الطبقة</button><button data-inline-layer-action="solo" data-id="${l.id}">عرض هذه الطبقة فقط</button>${l.id!=="general"?`<button class="danger" data-inline-layer-action="delete" data-id="${l.id}">حذف الطبقة</button>`:""}<button data-inline-layer-action="close" data-id="${l.id}">إغلاق</button></div>`}
function renderLayersDock(){const dock=$("#layersDock");if(!dock||!state.current)return;const mobile=matchMedia("(max-width:700px)").matches,d=state.layerDock,active=getActiveLayer()||state.current.layers[0],expanded=!mobile||d.open||d.height>120,rows=expanded?[...state.current.layers].reverse():[active],editing=d.editingId?findLayer(d.editingId):null,menu=d.menuId?findLayer(d.menuId):null;dock.style.setProperty("--layers-dock-height",`${d.height}px`);dock.style.setProperty("--options-sheet-height",`${state.activeTab?state.panelHeight:0}px`);dock.classList.toggle("is-expanded",expanded);dock.innerHTML=`<div id="layersResizeHandle" class="layers-resize-handle" title="اسحبي لتغيير ارتفاع لوحة الطبقات"><span></span></div><div class="layers-dock-header"><button id="layersIconToggle" class="layers-icon-button" title="فتح لوحة الطبقات" aria-label="لوحة الطبقات"><svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/></svg></button><div><button id="dockNewNormal" title="طبقة عادية">＋</button><button id="dockNewDrawing" title="طبقة رسم">✎＋</button></div></div><div class="layers-scroll"><div class="layer-list">${rows.map(layerRow).join("")}</div>${editing?layerEditor(editing):menu?layerActionMenu(menu):""}</div>`;bindLayerControls(dock);bindLayersResize(dock)}
function layerDockMaxHeight(){if(!matchMedia("(max-width:700px)").matches)return innerHeight;const css=getComputedStyle(document.documentElement),reserved=(state.activeTab?state.panelHeight:0)+parseFloat(css.getPropertyValue("--bottom")||66)+parseFloat(css.getPropertyValue("--status")||32)+parseFloat(css.getPropertyValue("--top")||54)+8;return Math.max(104,innerHeight-reserved)}
function bindLayersResize(dock){const h=dock.querySelector("#layersResizeHandle");if(!h)return;let resizing=false;const begin=(startY,kind,e)=>{if(resizing||!matchMedia("(max-width:700px)").matches)return;resizing=true;e?.preventDefault?.();const startH=dock.getBoundingClientRect().height,topLimit=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top")||54)+8,bottomReserved=(state.activeTab?state.panelHeight:0)+parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bottom")||66)+parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--status")||32),max=Math.max(104,innerHeight-topLimit-bottomReserved),point=ev=>ev.touches?.[0]?.clientY??ev.clientY,move=ev=>{ev.preventDefault?.();state.layerDock.height=clamp(startH+(startY-point(ev)),104,max);state.layerDock.open=state.layerDock.height>120;dock.style.setProperty("--layers-dock-height",`${state.layerDock.height}px`)},up=()=>{document.removeEventListener(kind+"move",move);document.removeEventListener(kind+"up",up);if(kind==="touch")document.removeEventListener("touchcancel",up);document.body.classList.remove("resizing-layers");resizing=false;if(state.layerDock.height<120){state.layerDock.height=104;state.layerDock.open=false}renderLayersDock()};document.body.classList.add("resizing-layers");document.addEventListener(kind+"move",move,{passive:false});document.addEventListener(kind+"up",up,{once:true});if(kind==="touch")document.addEventListener("touchcancel",up,{once:true})};h.onmousedown=e=>begin(e.clientY,"mouse",e);h.ontouchstart=e=>begin(e.touches[0].clientY,"touch",e)}
function bindLayerControls(root){const icon=root.querySelector("#layersIconToggle");if(icon)icon.onclick=()=>{state.layerDock.open=!state.layerDock.open;state.layerDock.height=state.layerDock.open?Math.min(Math.max(260,Math.min(innerHeight*.5,420)),layerDockMaxHeight()):104;renderLayersDock()};root.querySelectorAll("[data-layer-vis]").forEach(b=>b.onclick=()=>{snapshot();const l=findLayer(b.dataset.layerVis);l.visible=!l.visible;renderAll();scheduleSave();renderLayersDock();if(state.activeTab==="layers")renderPanel("layers")});root.querySelectorAll("[data-layer-active]").forEach(b=>b.onclick=()=>{state.current.activeLayerId=b.dataset.layerActive;if(matchMedia("(max-width:700px)").matches){state.layerDock.open=!state.layerDock.open;state.layerDock.height=state.layerDock.open?Math.min(Math.max(280,innerHeight*.5),layerDockMaxHeight()):104}renderAll();scheduleSave();renderLayersDock();if(state.activeTab==="layers")renderPanel("layers")});root.querySelectorAll("[data-layer-lock]").forEach(b=>b.onclick=()=>{snapshot();const l=findLayer(b.dataset.layerLock);l.locked=!l.locked;scheduleSave();renderLayersDock()});root.querySelectorAll("[data-layer-opacity]").forEach(i=>{i.onpointerdown=()=>snapshot();i.oninput=()=>{findLayer(i.dataset.layerOpacity).opacity=+i.value;renderAll()};i.onchange=()=>scheduleSave()});root.querySelectorAll("[data-layer-edit]").forEach(b=>b.onclick=()=>{state.layerDock.editingId=b.dataset.layerEdit;state.layerDock.menuId=null;state.layerDock.open=true;state.layerDock.height=Math.min(Math.max(state.layerDock.height,360),layerDockMaxHeight());renderLayersDock();setTimeout(()=>$("#layerEditName")?.focus(),0)});root.querySelectorAll("[data-layer-more]").forEach(b=>b.onclick=()=>layerMore(b.dataset.layerMore));root.querySelectorAll("[data-layer-up]").forEach(b=>b.onclick=()=>moveLayer(b.dataset.layerUp,1));root.querySelectorAll("[data-layer-down]").forEach(b=>b.onclick=()=>moveLayer(b.dataset.layerDown,-1));root.querySelectorAll("[data-inline-layer-action]").forEach(b=>b.onclick=()=>runLayerAction(b.dataset.id,b.dataset.inlineLayerAction));const normal=root.querySelector("#dockNewNormal"),drawing=root.querySelector("#dockNewDrawing");if(normal)normal.onclick=()=>newLayer("normal");if(drawing)drawing.onclick=()=>newLayer("drawing");const form=root.querySelector("#layerEditForm");if(form){const opacity=root.querySelector("#layerEditOpacity");opacity.oninput=()=>root.querySelector("#layerEditOpacityValue").textContent=opacity.value+"%";form.onsubmit=e=>{e.preventDefault();const l=findLayer(state.layerDock.editingId),name=root.querySelector("#layerEditName").value.trim();if(!l||!name)return;snapshot();l.name=name;l.opacity=+opacity.value;l.visible=root.querySelector("#layerEditVisible").checked;l.locked=root.querySelector("#layerEditLocked").checked;state.layerDock.editingId=null;renderAll();renderLayersDock();scheduleSave();if(state.activeTab==="layers")renderPanel("layers")};root.querySelector("#cancelLayerEdit").onclick=()=>{state.layerDock.editingId=null;renderLayersDock()}}}
function moveLayer(id,delta){const a=state.current.layers,i=a.findIndex(l=>l.id===id),j=clamp(i+delta,0,a.length-1);if(i<0||i===j)return;snapshot();[a[i],a[j]]=[a[j],a[i]];renderAll();scheduleSave();renderLayersDock();if(state.activeTab==="layers")renderPanel("layers")}
function drawingControls(){
  const settings=state.current.drawingSettings,tool=settings.tool,profiles=state.current.drawingProfiles||(state.current.drawingProfiles={brush:{size:settings.size||2,opacity:settings.opacity??100,color:settings.color||"#111111"},shade:{size:12,opacity:35,color:"#4a4a4a"},eraser:{size:16,opacity:100,color:"#ffffff"}}),d=profiles[tool];
  return `<div class="panel-section"><div class="panel-title">أدوات الرسم</div><div class="controls">
    <button data-draw-tool="brush" class="${tool==="brush"?"primary":""}">رسم</button>
    <button data-draw-tool="shade" class="${tool==="shade"?"primary":""}">تظليل</button>
    <button data-draw-tool="eraser" class="${tool==="eraser"?"primary":""}">ممحاة</button>
    <label>السماكة <input id="drawSize" type="range" min="1" max="40" value="${d.size}"><span>${d.size}</span></label>
    <label>الشفافية <input id="drawOpacity" type="range" min="1" max="100" value="${d.opacity}"></label>
    <label>اللون <input id="drawColor" type="color" value="${d.color}"></label>
  </div></div>`;
}

const diagClipboards={basic:null,sub:null};
let pendingAxisAngle=null, pendingShape=null, currentStroke=null;

function bindPanelEvents(tab){
  if(tab==="image"){
    $$("[data-paper-size]").forEach(b=>b.onclick=()=>changeDocumentPaper(b.dataset.paperSize,null));
    $$("[data-paper-orientation]").forEach(b=>b.onclick=()=>changeDocumentPaper(null,b.dataset.paperOrientation));
    $("#imageOpacityRange").oninput=e=>{state.current.imageAdjust.opacity=+e.target.value;e.target.nextElementSibling.textContent=e.target.value+"%";renderAll()};
    $("#imageOpacityRange").onchange=()=>scheduleSave();
    $("#toggleImageLock").onclick=()=>{snapshot();state.current.imageLocked=!state.current.imageLocked;scheduleSave();renderAll();renderPanel("image")};
    $("#startFreeCrop").onclick=()=>startCrop(false);$("#startAspectCrop").onclick=()=>startCrop(true);$("#resetCrop").onclick=()=>{snapshot();state.current.crop={x:0,y:0,w:1,h:1,enabled:false};state.cropSession=null;if(state.current.grid.locked)applyAutomaticNumbering();renderAll();scheduleSave();renderPanel("image")};if($("#applyCrop"))$("#applyCrop").onclick=()=>{snapshot();state.current.crop=JSON.parse(JSON.stringify(state.cropSession.rect));state.current.crop.enabled=true;state.cropSession=null;if(state.current.grid.locked)applyAutomaticNumbering();renderAll();scheduleSave();renderPanel("image");toast("تم اعتماد القص")};if($("#cancelCrop"))$("#cancelCrop").onclick=()=>{state.cropSession=null;renderAll();renderPanel("image")};
    $("#toggleAllAids").onclick=()=>{state.imageAids.visible=!state.imageAids.visible;renderAll();renderPanel("image")};$("#toggleAidRuler").onclick=()=>{state.imageAids.ruler=!state.imageAids.ruler;state.imageAids.visible=true;renderAll();renderPanel("image")};
    $$('[data-image-aid]').forEach(cb=>cb.onchange=()=>{state.imageAids[cb.dataset.imageAid]=cb.checked;state.imageAids.visible=true;renderAll()});$$('[data-image-snap]').forEach(cb=>cb.onchange=()=>{state.imageAids[cb.dataset.imageSnap]=cb.checked});
    $("#clearGuides").onclick=()=>{snapshot();const kept=state.imageAids.guides.filter(g=>g.locked);state.current.imageGuides=kept;state.imageAids.guides=kept;state.selection.guide=null;renderAll();scheduleSave();renderPanel("image")};
    const guide=state.selection.guide==null?null:state.imageAids.guides[state.selection.guide];if(guide){for(const [id,prop] of [["guideColor","color"],["guideOpacity","opacity"],["guideThickness","thickness"]]){const input=$("#"+id);input.onpointerdown=()=>snapshot();input.oninput=e=>{guide[prop]=prop==="color"?e.target.value:+e.target.value;renderAll()};input.onchange=()=>scheduleSave()}$("#guideStyle").value=guide.style||"dashed";$("#guideStyle").onchange=e=>{snapshot();guide.style=e.target.value;renderAll();scheduleSave()};$("#guideVisible").onclick=()=>{snapshot();guide.visible=guide.visible===false;renderAll();scheduleSave();renderPanel("image")};$("#guideLock").onclick=()=>{snapshot();guide.locked=!guide.locked;scheduleSave();renderPanel("image")};$("#deleteGuide").onclick=()=>{snapshot();state.imageAids.guides.splice(state.selection.guide,1);state.selection.guide=null;renderAll();scheduleSave();renderPanel("image")}}
  }
  if(tab==="filters"){
    if(!state.filterPreview)state.filterPreview=JSON.parse(JSON.stringify(state.current.imageFilter||defaults().imageFilter));$$('[data-normal-filter]').forEach(b=>b.onclick=()=>{state.filterPreview.type=b.dataset.normalFilter;renderAll();renderPanel("filters")});$("#bwStrength").oninput=e=>{state.filterPreview.type="bw";state.filterPreview.bwAmount=+e.target.value;e.target.nextElementSibling.textContent=e.target.value+"%";renderAll()};$("#grayStrength").oninput=e=>{state.filterPreview.type="gray";state.filterPreview.grayAmount=+e.target.value;e.target.nextElementSibling.textContent=e.target.value+"%";renderAll()};$("#applyNormalFilter").onclick=()=>{snapshot();state.current.imageFilter=JSON.parse(JSON.stringify(state.filterPreview));state.filterPreview=null;renderAll();scheduleSave();renderPanel("filters");toast("تم تطبيق الفلتر")};$("#cancelNormalFilter").onclick=()=>{state.filterPreview=null;renderAll();renderPanel("filters")};$("#resetNormalFilter").onclick=()=>{snapshot();state.current.imageFilter={type:"none",bwAmount:70,grayAmount:100};state.filterPreview=null;renderAll();scheduleSave();renderPanel("filters")};
    $("#aiFiltersBtn").onclick=()=>toast("فلاتر AI تحتاج API خارجي وتُضاف لاحقًا.");
  }
  if(tab==="grid"){
    for(const prop of ["cols","rows"]){const id=prop==="cols"?"gridCols":"gridRows",input=$("#"+id);input.onpointerdown=()=>snapshot();input.oninput=e=>{state.current.grid[prop]=clamp(Math.round(+e.target.value),1,50);renderAll();refreshGridControlLabels()};input.onchange=()=>scheduleSave();$("#"+id+"Minus").onclick=()=>{snapshot();state.current.grid[prop]=clamp(state.current.grid[prop]-1,1,50);renderAll();scheduleSave();renderPanel("grid")};$("#"+id+"Plus").onclick=()=>{snapshot();state.current.grid[prop]=clamp(state.current.grid[prop]+1,1,50);renderAll();scheduleSave();renderPanel("grid")}}
    $("#toggleGrid").onclick=()=>{snapshot();state.current.grid.visible=!state.current.grid.visible;renderAll();scheduleSave();renderPanel("grid")};
    $("#moveGridBtn").onclick=()=>{snapshot();state.current.grid.locked=false;state.current.grid.numberingApproved=false;state.current.grid.numberingMap={};state.current.grid.numberingStart=null;state.current.grid.labelWindow=null;toast("اسحبي الشبكة بحرية ثم ثبتيها على الصورة");scheduleSave();renderAll();renderPanel("grid")};
    $("#lockGridBtn").onclick=()=>{if(state.current.grid.locked)return;snapshot();state.current.grid.locked=true;state.current.imageLocked=true;applyAutomaticNumbering();state.selection.cell=null;state.selection.cellKey=null;const ns=numberedGridStats();toast(ns.count?`تم تثبيت الشبكة وترقيم ${ns.count} خلية تلقائيًا`:"تم تثبيت الشبكة، ولا توجد خلايا متقاطعة مع الصورة");scheduleSave();renderAll();renderPanel("grid")};
    $("#gridColor").oninput=e=>{state.current.grid.color=e.target.value;renderAll()};
    $("#gridColor").onchange=()=>scheduleSave();
    $("#gridOpacity").oninput=e=>{state.current.grid.opacity=+e.target.value;renderAll()};
    $("#gridOpacity").onchange=()=>scheduleSave();
    $("#gridThickness").oninput=e=>{state.current.grid.thickness=+e.target.value;renderAll()};
    $("#gridThickness").onchange=()=>scheduleSave();
    $("#toggleLabels").onclick=()=>{state.current.grid.labels=!state.current.grid.labels;renderAll();scheduleSave();renderPanel("grid")};
    $("#labelPosition").onchange=e=>{state.current.grid.labelPosition=e.target.value;renderAll();scheduleSave()};
    $("#labelSize").oninput=e=>{state.current.grid.labelSize=+e.target.value;renderAll()};
    $("#labelSize").onchange=()=>scheduleSave();
  }
  if(tab==="notebook"){
    $("#calcNotebook").onclick=calcNotebook;
    $("#paperSize").onchange=e=>{snapshot();state.current.notebook.paper=e.target.value;if(state.notebookCalc)calcNotebook();scheduleSave()};$("#paperOrientation").onchange=e=>{snapshot();state.current.notebook.orientation=e.target.value;if(state.notebookCalc)calcNotebook();scheduleSave()};
  }
  if(tab==="basicDiag"){
    $("#addPlus").onclick=()=>ensureBasic("plus");
    $("#addX").onclick=()=>ensureBasic("x");
    $("#deleteBasic").onclick=()=>{const k=selectedCellKey();if(!k)return; snapshot(); delete activeItems().basic[k];renderAll();scheduleSave();renderPanel("basicDiag")};
    $("#copyBasic").onclick=()=>$("#basicCopyMenu").classList.toggle("hidden");
    $("#pasteBasic").onclick=()=>pasteDiagSelection(false);
    bindDiagEditor(false);
    $$("[data-diag-copy]").forEach(b=>b.onclick=()=>copyDiagSelection(false,b.dataset.diagCopy));
  }
  if(tab==="subDiag"){
    $("#addSubPlus").onclick=()=>ensureSub("plus");
    $("#addSubX").onclick=()=>ensureSub("x");
    $("#deleteSub").onclick=()=>{const k=selectedSubKey();if(!k)return;snapshot();delete activeItems().sub[k];renderAll();scheduleSave();renderPanel("subDiag")};
    $("#copySub").onclick=()=>$("#subCopyMenu").classList.toggle("hidden");
    $("#pasteSub").onclick=()=>pasteDiagSelection(true);
    bindDiagEditor(true);
    $$("[data-sub-copy]").forEach(b=>b.onclick=()=>copyDiagSelection(true,b.dataset.subCopy));
  }
  if(tab==="axes"){
    $("#snapLevel").value=state.current.snapLevel||"medium";
    $("#snapLevel").onchange=e=>{snapshot();state.current.snapLevel=e.target.value;scheduleSave()};
    $$("[data-axis-angle]").forEach(b=>b.onclick=()=>{pendingAxisAngle=b.dataset.axisAngle==="free"?"free":+b.dataset.axisAngle;state.pointer.mode="axis-create";toast("اختاري نقطة البداية ثم النهاية")});
    $("#toggleAllAxes").onclick=()=>{const axes=activeItems().axes;snapshot();const any=axes.some(a=>a.visible!==false);axes.forEach(a=>a.visible=!any);renderAll();scheduleSave()};
    $("#toggleAxisAngle").onclick=()=>{const a=activeItems().axes[state.selection.axis];if(!a)return;snapshot();a.showAngle=!a.showAngle;renderAll();scheduleSave()};
    $("#unlockAxis").onclick=()=>{const a=activeItems().axes[state.selection.axis];if(!a)return;snapshot();a.lockedAngle=false;scheduleSave();toast(`الزاوية الحالية ${axisAngle(a).toFixed(1)}°`)};
    $("#deleteAxis").onclick=()=>{if(state.selection.axis==null)return;snapshot();activeItems().axes.splice(state.selection.axis,1);state.selection.axis=null;renderAll();scheduleSave()};
    if($("#editSelectedAxis"))$("#editSelectedAxis").onclick=()=>{state.selection.axisEditing=true;renderAll();renderPanel("axes")};
    $$("[data-axis-coordinate]").forEach(input=>input.onchange=()=>{const a=activeItems().axes[state.selection.axis];if(!a)return;snapshot();a[input.dataset.axisCoordinate]=+input.value;renderAll();scheduleSave();renderPanel("axes")});
    bindElementStyle("axis");
  }
  if(tab==="shapes"){
    $$("[data-shape]").forEach(b=>b.onclick=()=>{state.shapeEraser.active=false;pendingShape=b.dataset.shape;state.pointer.mode="shape-create";toast("اسحبي على لوحة العمل لإنشاء الشكل")});
    $("#shapeEraserBtn").onclick=()=>{state.shapeEraser.active=!(state.shapeEraser.active&&state.shapeEraser.mode==="erase");state.shapeEraser.mode="erase";state.pointer.mode=null;renderPanel("shapes");toast(state.shapeEraser.active?"مرري الممحاة فوق جزء الشكل":"تم إيقاف ممحاة الأشكال")};$("#shapeRestoreBtn").onclick=()=>{state.shapeEraser.active=!(state.shapeEraser.active&&state.shapeEraser.mode==="restore");state.shapeEraser.mode="restore";state.pointer.mode=null;renderPanel("shapes");toast(state.shapeEraser.active?"مرري الفرشاة لاستعادة أجزاء الشكل":"تم إيقاف أداة الاستعادة")};$("#shapeEraserSize").oninput=e=>{state.shapeEraser.size=+e.target.value;e.target.nextElementSibling.textContent=e.target.value};
    $("#toggleAllShapes").onclick=()=>{const arr=activeItems().shapes;snapshot();const any=arr.some(s=>s.visible!==false);arr.forEach(s=>s.visible=!any);renderAll();scheduleSave()};
    bindElementStyle("shape");
    if($("#editSelectedShape"))$("#editSelectedShape").onclick=()=>{state.selection.shapeEditing=true;renderAll();renderPanel("shapes")};
    if($("#deleteSelectedShape"))$("#deleteSelectedShape").onclick=()=>{if(state.selection.shape==null)return;snapshot();activeItems().shapes.splice(state.selection.shape,1);state.selection.shape=null;state.selection.shapeEditing=false;renderAll();scheduleSave();renderPanel("shapes")};
  }
  if(tab==="layers"){
    $("#newNormalLayer").onclick=()=>newLayer("normal");
    $("#newDrawingLayer").onclick=()=>newLayer("drawing");
    $("#showAllLayers").onclick=()=>{snapshot();state.current.layers.forEach(l=>l.visible=true);renderAll();scheduleSave();renderPanel("layers")};
    $("#hideAllLayers").onclick=()=>{snapshot();state.current.layers.forEach(l=>l.visible=false);renderAll();scheduleSave();renderPanel("layers")};
    bindLayerControls($("#contextPanel"));
    $$("[data-draw-tool]").forEach(b=>b.onclick=()=>{state.current.drawingSettings.tool=b.dataset.drawTool;renderPanel("layers")});
    const profile=state.current.drawingProfiles?.[state.current.drawingSettings.tool];
    if($("#drawSize"))$("#drawSize").oninput=e=>{snapshot();profile.size=+e.target.value;if(e.target.nextElementSibling)e.target.nextElementSibling.textContent=e.target.value;scheduleSave()};
    if($("#drawOpacity"))$("#drawOpacity").oninput=e=>{snapshot();profile.opacity=+e.target.value;scheduleSave()};
    if($("#drawColor"))$("#drawColor").oninput=e=>{snapshot();profile.color=e.target.value;scheduleSave()};
  }
  if(tab==="export")$$('[data-sheet-export]').forEach(b=>b.onclick=()=>exportPreset(b.dataset.sheetExport));
}
function addGuide(type,pos=null,refresh=true){
  const f=imageFrame();if(!f)return;
  snapshot();const guide={type,pos:pos??(type==="v"?f.fw/2:f.fh/2),color:"#7567A8",opacity:70,thickness:.35,visible:true,locked:false,style:"dashed"};state.imageAids.visible=true;state.imageAids.guides.push(guide);state.current.imageGuides=state.imageAids.guides;state.selection.guide=state.imageAids.guides.length-1;renderAll();if(refresh)renderPanel("image");
}
function startCrop(aspectLocked){const base=state.current.crop?.enabled?state.current.crop:{x:.1,y:.1,w:.8,h:.8,enabled:true};state.cropSession={rect:JSON.parse(JSON.stringify(base)),aspectLocked,aspect:base.w/base.h};renderAll();renderPanel("image");toast(aspectLocked?"اسحبي المقابض مع الحفاظ على النسبة":"اسحبي الإطار أو مقابض الزوايا")}
function hitCropControl(p){if(!state.cropSession)return null;const r=cropWorldRect(state.cropSession.rect),tol=14/state.view.zoom,handles=[{id:"tl",x:r.x,y:r.y},{id:"tr",x:r.x+r.w,y:r.y},{id:"bl",x:r.x,y:r.y+r.h},{id:"br",x:r.x+r.w,y:r.y+r.h}];for(const h of handles)if(Math.hypot(p.x-h.x,p.y-h.y)<=tol)return h.id;return p.x>=r.x&&p.x<=r.x+r.w&&p.y>=r.y&&p.y<=r.y+r.h?"move":null}
function updateCropEdit(world){const s=state.pointer.cropStart,base=s.rect,f=imageFrame(),tr=state.current.imageTransform,dx=(world.x-s.world.x)/(f.iw*tr.scale),dy=(world.y-s.world.y)/(f.ih*tr.scale);if(s.handle==="move"){state.cropSession.rect={...base,x:clamp(base.x+dx,0,1-base.w),y:clamp(base.y+dy,0,1-base.h),enabled:true};return}let x1=base.x,y1=base.y,x2=base.x+base.w,y2=base.y+base.h;if(s.handle.includes("l"))x1=clamp(base.x+dx,0,x2-.01);else x2=clamp(base.x+base.w+dx,x1+.01,1);if(s.handle.includes("t"))y1=clamp(base.y+dy,0,y2-.01);else y2=clamp(base.y+base.h+dy,y1+.01,1);if(state.cropSession.aspectLocked){const ratio=state.cropSession.aspect||base.w/base.h,w=x2-x1,h=w/ratio;if(s.handle.includes("t"))y1=clamp(y2-h,0,y2-.01);else y2=clamp(y1+h,y1+.01,1);const actualH=y2-y1,actualW=actualH*ratio;if(s.handle.includes("l"))x1=clamp(x2-actualW,0,x2-.01);else x2=clamp(x1+actualW,x1+.01,1)}state.cropSession.rect={x:x1,y:y1,w:x2-x1,h:y2-y1,enabled:true}}
function refreshGridControlLabels(){const gg=gridGeom(),g=state.current.grid;if($("#gridColsValue"))$("#gridColsValue").textContent=g.cols;if($("#gridRowsValue"))$("#gridRowsValue").textContent=g.rows;if($("#gridCellValue"))$("#gridCellValue").textContent=(gg.cell/4).toFixed(1)+" ملم";if($("#gridGeometryInfo"))$("#gridGeometryInfo").textContent=`${g.cols}×${g.rows} · ${(gg.gw/4).toFixed(1)}×${(gg.gh/4).toFixed(1)} ملم`}
function bindElementStyle(type){
  const collection=type==="axis"?activeItems().axes:activeItems().shapes;
  const index=type==="axis"?state.selection.axis:state.selection.shape,item=index==null?null:collection[index];if(!item)return;
  $$(`[data-element-style][data-element-type="${type}"]`).forEach(input=>input.oninput=()=>{snapshot();item[input.dataset.elementStyle]=input.dataset.elementStyle==="color"?input.value:+input.value;renderAll();scheduleSave()});
  const button=$(`[data-element-visible="${type}"]`);if(button)button.onclick=()=>{snapshot();item.visible=item.visible===false;renderAll();scheduleSave();renderPanel(type==="axis"?"axes":"shapes")};
}
function changeGridSize(prop,val){
  val=clamp(Math.round(val||1),1,50);
  const hasItems=state.current.layers.some(l=>Object.keys(l.items.basic||{}).length||Object.keys(l.items.sub||{}).length||l.items.axes?.length||l.items.shapes?.length);
  if(hasItems&&!confirm("تغيير الشبكة قد يؤثر على العناصر المرتبطة بالمربعات الحالية. متابعة؟")){renderPanel("grid");return}
  snapshot();state.current.grid[prop]=val;renderAll();scheduleSave();
}
function selectedCellKey(){
  if(state.selection.cellKey)return state.selection.cellKey;
  const s=state.selection.cell;if(!s)return null;
  const [col,row]=s.match(/^([A-Z]+)(\d+)$/).slice(1);
  let c=0;for(let i=0;i<col.length;i++)c=c*26+(col.charCodeAt(i)-64);c-=1;
  return `${+row-1},${c}`;
}
function selectedSubKey(){const k=selectedCellKey();return k!=null&&state.selection.quarter!=null?`${k}|${state.selection.quarter}`:null}
function ensureBasic(kind){
  const l=getActiveLayer();if(l.locked)return toast("الطبقة مقفلة");
  const k=selectedCellKey();if(!k)return toast("اختاري مربعًا أولًا");
  snapshot();
  const it=activeItems().basic[k]||(activeItems().basic[k]={});
  if(kind==="plus")it.plus=it.plus||{visible:true,color:"#00aaff",opacity:100,thickness:1.6,parts:{top:true,bottom:true,right:true,left:true}};
  else it.x=it.x||{visible:true,color:"#ff9500",opacity:100,thickness:1.6,parts:{tr:true,tl:true,br:true,bl:true}};
  renderAll();scheduleSave();renderPanel("basicDiag");
}
function ensureSub(kind){
  const l=getActiveLayer();if(l.locked)return toast("الطبقة مقفلة");
  const k=selectedSubKey();if(!k)return toast("اختاري مربعًا وربعًا");
  snapshot();
  const it=activeItems().sub[k]||(activeItems().sub[k]={});
  if(kind==="plus")it.plus=it.plus||{visible:true,color:"#00aaff",opacity:100,thickness:1.6,parts:{top:true,bottom:true,right:true,left:true}};
  else it.x=it.x||{visible:true,color:"#ff9500",opacity:100,thickness:1.6,parts:{tr:true,tl:true,br:true,bl:true}};
  renderAll();scheduleSave();renderPanel("subDiag");
}
function toggleDiagPart(kind,part,sub){
  const k=sub?selectedSubKey():selectedCellKey();if(!k)return;
  const map=sub?activeItems().sub:activeItems().basic, it=map[k]; if(!it?.[kind])return;
  snapshot();it[kind].parts[part]=!it[kind].parts[part];renderAll();scheduleSave();
}
function selectedDiagItem(sub){
  const key=sub?selectedSubKey():selectedCellKey();
  return key?(sub?activeItems().sub[key]:activeItems().basic[key]):null;
}
function bindDiagEditor(sub){
  $$("[data-diag-prop]").forEach(input=>input.oninput=()=>{
    const item=selectedDiagItem(sub),target=item?.[input.dataset.diagKind];if(!target)return;
    snapshot();target[input.dataset.diagProp]=input.dataset.diagProp==="color"?input.value:+input.value;
    const valueLabel=input.nextElementSibling;if(valueLabel)valueLabel.textContent=`${input.value}%`;
    renderAll();scheduleSave();
  });
  $$("[data-diag-visible]").forEach(button=>button.onclick=()=>{
    const item=selectedDiagItem(sub),target=item?.[button.dataset.diagVisible];if(!target)return;
    snapshot();target.visible=target.visible===false;renderAll();scheduleSave();renderPanel(sub?"subDiag":"basicDiag");
  });
  $$("[data-diag-part]").forEach(button=>button.onclick=()=>{
    toggleDiagPart(button.dataset.diagKind,button.dataset.diagPart,sub);renderPanel(sub?"subDiag":"basicDiag");
  });
}
function copyDiagSelection(sub,mode){
  const item=selectedDiagItem(sub);if(!item)return toast("اختاري عنصرًا يحتوي على قطر أولًا");
  const clip={mode,data:{}};
  if(mode==="full")clip.data=JSON.parse(JSON.stringify(item));
  else if(mode==="plus"||mode==="x")clip.data[mode]=JSON.parse(JSON.stringify(item[mode]||null));
  else for(const kind of ["plus","x"]){
    if(!item[kind])continue;
    clip.data[kind]=mode==="appearance"?{color:item[kind].color,opacity:item[kind].opacity,thickness:item[kind].thickness}:{visible:item[kind].visible,parts:JSON.parse(JSON.stringify(item[kind].parts))};
  }
  diagClipboards[sub?"sub":"basic"]=clip;
  const labels={plus:"تم نسخ + فقط.",x:"تم نسخ X فقط.",full:"تم نسخ + و X.",appearance:"تم نسخ المظهر.",visibility:"تم نسخ الإظهار والإخفاء."};
  toast(labels[mode]);renderPanel(sub?"subDiag":"basicDiag");
}
function pasteDiagSelection(sub){
  const key=sub?selectedSubKey():selectedCellKey();if(!key)return;
  const map=sub?activeItems().sub:activeItems().basic;
  const clip=diagClipboards[sub?"sub":"basic"];
  if(!clip)return toast("لا يوجد نمط منسوخ");
  snapshot();
  if(clip.mode==="full")map[key]=JSON.parse(JSON.stringify(clip.data));
  else {const item=map[key]||(map[key]={});for(const kind of ["plus","x"]){const source=clip.data[kind];if(!source)continue;if(clip.mode==="plus"||clip.mode==="x")item[kind]=JSON.parse(JSON.stringify(source));else if(item[kind])Object.assign(item[kind],JSON.parse(JSON.stringify(source)))}}
  renderAll();scheduleSave();renderPanel(sub?"subDiag":"basicDiag");
}
function calcNotebook(){
  const n=state.current.notebook;
  if(!state.current.grid.locked||!state.current.grid.numberingApproved){$("#notebookResult").innerHTML=`<div class="result-card">ثبتي الشبكة على الصورة أولًا قبل تجهيز شبكة الكراسة</div>`;return}
  const ns=numberedGridStats();if(!ns.count){$("#notebookResult").innerHTML=`<div class="result-card">لا توجد خلايا من الشبكة تتقاطع مع الصورة.</div>`;return}
  n.paper=$("#paperSize").value;n.orientation=$("#paperOrientation").value;n.unit="cm";
  const dimsMm=paperDimensionsMm(n.paper).slice();if(n.orientation==="landscape")dimsMm.reverse();const pwMm=dimsMm[0],phMm=dimsMm[1],cols=ns.cols,rows=ns.rows,maximumSquareSideMm=Math.min(pwMm/cols,phMm/rows),sMm=largestEvenSquareSideMm(maximumSquareSideMm);
  if(sMm<20){$("#notebookResult").innerHTML=`<div class="result-card"><b>لا يمكن تجهيز شبكة عملية على هذه الورقة.</b><br>عدد الصفوف أو الأعمدة كبير بالنسبة إلى مقاس الورقة، والحد النظري لضلع المربع ${fmt(maximumSquareSideMm/10)} سم وهو أقل من 2 سم.</div>`;state.notebookCalc=null;return}
  const gwMm=cols*sMm,ghMm=rows*sMm,remW=pwMm-gwMm,remH=phMm-ghMm;
  const [rightMm,leftMm]=distributeNotebookMargin(remW),[topMm,bottomMm]=distributeNotebookMargin(remH),fromMm=v=>v/10,pw=fromMm(pwMm),ph=fromMm(phMm),gw=fromMm(gwMm),gh=fromMm(ghMm),right=fromMm(rightMm),left=fromMm(leftMm),top=fromMm(topMm),bottom=fromMm(bottomMm),s=fromMm(sMm);
  const html=`<div class="result-card">
    <b>الاعتماد على الشبكة المثبتة · ${n.paper} ${n.orientation==="portrait"?"طولي":"عرضي"}</b><br>
    الأعمدة: ${cols} · الصفوف: ${rows}<br>
    الحد النظري لضلع المربع: ${fmt(maximumSquareSideMm/10)} سم · أكبر ضلع زوجي مناسب: <b>${fmt(s)} سم</b><br>
    عرض الشبكة: ${fmt(gw)} سم · ارتفاع الشبكة: ${fmt(gh)} سم<hr>
    ابدئي من: <b>${fmt(right)} سم من يمين الورقة</b> و <b>${fmt(top)} سم من أعلى الورقة</b><br>
    يمين: ${fmt(right)} · يسار: ${fmt(left)} · أعلى: ${fmt(top)} · أسفل: ${fmt(bottom)}
    <div class="paper-preview" id="paperPreview"><div class="paper-grid-preview" style="right:${right/pw*100}%;top:${top/ph*100}%;width:${gw/pw*100}%;height:${gh/ph*100}%"></div></div><div class="controls"><button id="recalcNotebook">إعادة الحساب</button><button id="saveNotebookPng">حفظ PNG</button><button id="saveNotebookPdf">حفظ PDF</button></div><img id="notebookGuidePreview" class="notebook-guide-preview hidden" alt="معاينة صورة إرشادات الكراسة">
  </div>`;
  $("#notebookResult").innerHTML=html;
  state.notebookCalc={pw,ph,gw,gh,right,left,top,bottom,rows,cols,s,orientation:n.orientation,paper:n.paper,unit:"cm",minV:ns.minV,maxV:ns.maxV,minR:ns.minR,maxR:ns.maxR,maximumSquareSideMm,sMm,pwMm,phMm,gwMm,ghMm,rightMm,leftMm,topMm,bottomMm};
  $("#recalcNotebook").onclick=calcNotebook;$("#saveNotebookPng").onclick=()=>saveNotebookGuide("png");$("#saveNotebookPdf").onclick=()=>saveNotebookGuide("pdf");
  const preview=$("#notebookGuidePreview");preview.src=renderNotebookGuide(state.notebookCalc).toDataURL("image/png");preview.classList.remove("hidden");
  scheduleSave();
}
function unitLabel(unit){return unit==="mm"?"مم":unit==="in"?"إنش":"سم"}
function dimensionLine(g,x1,y1,x2,y2,label,vertical=false){g.save();g.strokeStyle="#5f5870";g.fillStyle="#26232B";g.lineWidth=2.2;g.beginPath();g.moveTo(x1,y1);g.lineTo(x2,y2);g.stroke();const a=9;for(const [x,y,dir] of [[x1,y1,1],[x2,y2,-1]]){g.beginPath();if(vertical){g.moveTo(x-a,y+dir*a);g.lineTo(x,y);g.lineTo(x+a,y+dir*a)}else{g.moveTo(x+dir*a,y-a);g.lineTo(x,y);g.lineTo(x+dir*a,y+a)}g.stroke()}g.font="600 25px Tahoma,Arial";g.textAlign="center";g.textBaseline="middle";const tw=g.measureText(label).width+18,mx=(x1+x2)/2,my=(y1+y2)/2;let box;if(vertical){g.translate(mx,my);g.rotate(-Math.PI/2);g.fillStyle="#FCFBF8";g.fillRect(-tw/2,-16,tw,32);g.fillStyle="#26232B";g.fillText(label,0,0);box={x:mx-16,y:my-tw/2,w:32,h:tw}}else{g.fillStyle="#FCFBF8";g.fillRect(mx-tw/2,my-16,tw,32);g.fillStyle="#26232B";g.fillText(label,mx,my);box={x:mx-tw/2,y:my-16,w:tw,h:32}}g.restore();return box}
function boxesOverlap(a,b,pad=10){return a.x-pad<b.x+b.w&&a.x+a.w+pad>b.x&&a.y-pad<b.y+b.h&&a.y+a.h+pad>b.y}
function renderNotebookGuide(d){
  const c=document.createElement("canvas"),portrait=d.ph>=d.pw;c.width=portrait?1400:1800;c.height=portrait?1800:1400;const g=c.getContext("2d"),u=unitLabel(d.unit),pad=190,titleH=100,availW=c.width-pad*2,availH=c.height-pad*2-titleH,scale=Math.min(availW/d.pw,availH/d.ph),paperW=d.pw*scale,paperH=d.ph*scale,px=(c.width-paperW)/2,py=titleH+(c.height-titleH-paperH)/2,gxR=px+paperW-d.right*scale,gxL=gxR-d.gw*scale,gyT=py+d.top*scale,gyB=gyT+d.gh*scale,cell=d.s*scale;
  g.fillStyle="#F3F0F7";g.fillRect(0,0,c.width,c.height);g.fillStyle="#26232B";g.direction="rtl";g.textAlign="center";g.font="bold 38px Tahoma,Arial";g.fillText(`إرشادات شبكة الكراسة — ${d.paper}`,c.width/2,55);g.shadowColor="rgba(0,0,0,.12)";g.shadowBlur=18;g.fillStyle="#fff";g.fillRect(px,py,paperW,paperH);g.shadowBlur=0;
  const f=imageFrame(),ag=gridGeom(),sourceCell=ag.cell,rangeX=ag.x+d.minV*sourceCell,rangeY=ag.y+d.minR*sourceCell,rangeW=d.cols*sourceCell,rangeH=d.rows*sourceCell,composition=document.createElement("canvas");composition.width=Math.max(1,Math.ceil(rangeW));composition.height=Math.max(1,Math.ceil(rangeH));const cg=composition.getContext("2d");cg.save();cg.translate(-rangeX,-rangeY);drawProject(cg,{includeLegacyGuides:false,layerIds:[],includeGrid:false});cg.restore();cg.strokeStyle=state.current.grid.color||"#7567A8";cg.globalAlpha=(state.current.grid.opacity??60)/100;cg.lineWidth=Math.max(.5,sourceCell*((state.current.grid.thickness??.35)/100));cg.beginPath();for(let col=0;col<=d.cols;col++){const x=col*sourceCell;cg.moveTo(x,0);cg.lineTo(x,rangeH)}for(let row=0;row<=d.rows;row++){const y=row*sourceCell;cg.moveTo(0,y);cg.lineTo(rangeW,y)}cg.stroke();if(state.current.grid.labels){cg.fillStyle=state.current.grid.labelColor||state.current.grid.color;cg.globalAlpha=(state.current.grid.labelOpacity??80)/100;cg.font=`${Math.max(8,sourceCell*((state.current.grid.labelSize??12)/100))}px system-ui`;cg.textAlign="right";cg.textBaseline="top";for(let row=0;row<d.rows;row++)for(let col=0;col<d.cols;col++)cg.fillText(colName(d.cols-1-col)+(row+1),(col+1)*sourceCell-4,row*sourceCell+4)}g.drawImage(composition,gxL,gyT,d.gw,d.gh);g.strokeStyle="#26232B";g.lineWidth=3;g.strokeRect(px,py,paperW,paperH);
  const label=v=>`${fmt(v)} ${u}`,inside=42;
  const occupied=[];occupied.push(dimensionLine(g,gxR,gyT-inside,px+paperW,gyT-inside,label(d.right)),dimensionLine(g,px,gyB+inside,gxL,gyB+inside,label(d.left)),dimensionLine(g,gxR+inside,py,gxR+inside,gyT,label(d.top),true),dimensionLine(g,gxL-inside,gyB,gxL-inside,py+paperH,label(d.bottom),true));
  g.save();g.fillStyle="rgba(255,255,255,.86)";g.fillRect(gxR-cell+5,gyT+5,cell-10,Math.min(42,cell-10));g.fillStyle="#26232B";g.font=`600 ${Math.max(14,Math.min(24,cell*.14))}px Tahoma,Arial`;g.textAlign="center";g.textBaseline="middle";g.fillText(`ضلع المربع ${label(d.s)}`,gxR-cell/2,gyT+Math.min(24,cell/2));g.restore();
  if(d.top*scale>75)occupied.push(dimensionLine(g,gxL,gyT-72,gxR,gyT-72,label(d.gw)));
  if(d.left*scale>75)occupied.push(dimensionLine(g,gxL-72,gyT,gxL-72,gyB,label(d.gh),true));
  const startX=gxR,startY=gyT;g.font="600 24px Tahoma,Arial";const startW=g.measureText("نقطة البداية A1").width+18,candidates=[{x:startX-105,y:startY-45},{x:startX-120,y:startY+45},{x:startX+95,y:startY+48}],chosen=candidates.find(p=>!occupied.some(b=>boxesOverlap(b,{x:p.x-startW/2,y:p.y-30,w:startW,h:32})))||candidates[1],lx=clamp(chosen.x,px+startW/2+8,px+paperW-startW/2-8),ly=clamp(chosen.y,py+30,py+paperH-30);g.fillStyle="#B85C62";g.beginPath();g.arc(startX,startY,9,0,Math.PI*2);g.fill();g.strokeStyle="#B85C62";g.lineWidth=2;g.beginPath();g.moveTo(startX-7,startY-7);g.lineTo(lx,ly);g.stroke();g.fillStyle="#B85C62";g.textAlign="center";g.fillText("نقطة البداية A1",lx,ly-12);
  return c;
}
async function notebookGuideFile(format="png"){const d=state.notebookCalc;if(!d)return null;const canvas=renderNotebookGuide(d),base=`${sanitizeName(state.current.name)}_notebook-guide`;if(format==="pdf")return{blob:canvasToPdfBlob(canvas),name:base+".pdf",type:"application/pdf"};const blob=await new Promise(r=>canvas.toBlob(r,"image/png"));return{blob,name:base+".png",type:"image/png",preview:canvas.toDataURL("image/png")}}
async function saveNotebookGuide(format){const file=await notebookGuideFile(format);if(file)showSaveShare([file])}
function splitMargin(rem){
  if(Math.abs(rem-Math.round(rem))<1e-9){
    if(rem%2===0)return [rem/2,rem/2];
    return [(rem+1)/2,(rem-1)/2];
  }
  const frac=Math.round((rem-Math.floor(rem))*10)/10;
  if(Math.abs(frac-.5)<.001){
    return [Math.ceil(rem/2*2)/2,Math.floor(rem/2*2)/2];
  }
  const low=Math.floor(rem/2);
  return [+(rem-low).toFixed(2),low];
}
function toMm(v,unit){return unit==="mm"?v:unit==="in"?v*25.4:v*10}
function largestEvenSquareSideMm(maximumMm){return Math.floor((Math.max(0,maximumMm)/10+1e-9)/2)*20}
function distributeNotebookMargin(totalMarginMm){const total=Math.max(0,Math.round(totalMarginMm*1000000)/1000000),cm=total/10;if(Math.abs(cm-Math.round(cm))<1e-9)return[total/2,total/2];const primary=Math.round(cm/2)*10;return[primary,total-primary]}
function concatBytes(parts){const size=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(size);let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length}return out}
function canvasToPdfBlob(canvas){const enc=new TextEncoder(),jpegUrl=canvas.toDataURL("image/jpeg",.98),raw=atob(jpegUrl.split(",")[1]),jpeg=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)jpeg[i]=raw.charCodeAt(i);const w=canvas.width,h=canvas.height,content=enc.encode(`q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`),objects=[enc.encode("<< /Type /Catalog /Pages 2 0 R >>"),enc.encode("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),enc.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),concatBytes([enc.encode(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,enc.encode("\nendstream")]),concatBytes([enc.encode(`<< /Length ${content.length} >>\nstream\n`),content,enc.encode("endstream")])],parts=[enc.encode("%PDF-1.4\n")],offsets=[0];let cursor=parts[0].length;for(let i=0;i<objects.length;i++){offsets.push(cursor);const part=concatBytes([enc.encode(`${i+1} 0 obj\n`),objects[i],enc.encode("\nendobj\n")]);parts.push(part);cursor+=part.length}const xref=cursor,rows=offsets.slice(1).map(v=>String(v).padStart(10,"0")+" 00000 n \n").join("");parts.push(enc.encode(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));return new Blob(parts,{type:"application/pdf"})}
function fmt(n){return Number.isInteger(n)?String(n):(+n.toFixed(2)).toString()}
function findLayer(id){return state.current.layers.find(l=>l.id===id)}
function newLayer(type){
  const count=state.current.layers.filter(layer=>layer.type===type).length+1;
  const name=type==="drawing"?`طبقة رسم ${count}`:`طبقة ${count}`;
  snapshot();
  const l={id:uid(),name,type,visible:true,opacity:100,locked:false,items:{basic:{},sub:{},axes:[],shapes:[],drawing:[]}};
  state.current.layers.push(l);state.current.activeLayerId=l.id;if(state.activeTab==="layers")renderPanel("layers");renderLayersDock();renderAll();scheduleSave();
}
function layerMore(id){
  if(!findLayer(id))return;state.layerDock.menuId=id;state.layerDock.editingId=null;state.layerDock.open=true;state.layerDock.height=Math.min(Math.max(state.layerDock.height,300),layerDockMaxHeight());renderLayersDock();
}
function runLayerAction(id,action){const l=findLayer(id);if(!l)return;if(action==="close"){state.layerDock.menuId=null;renderLayersDock();return}if(action==="edit"){state.layerDock.menuId=null;state.layerDock.editingId=id;state.layerDock.height=Math.min(Math.max(state.layerDock.height,360),layerDockMaxHeight());renderLayersDock();return}if(action==="duplicate"){snapshot();const copy=JSON.parse(JSON.stringify(l));copy.id=uid();copy.name=l.name+" - نسخة";state.current.layers.push(copy)}else if(action==="solo"){snapshot();state.current.layers.forEach(x=>x.visible=x.id===id)}else if(action==="delete"){if(l.id==="general")return toast("لا يمكن حذف المستوى العام");if(!confirm("حذف الطبقة ومحتواها؟"))return;snapshot();state.current.layers=state.current.layers.filter(x=>x.id!==id);if(state.current.activeLayerId===id)state.current.activeLayerId="general"}state.layerDock.menuId=null;renderAll();scheduleSave();renderLayersDock();if(state.activeTab==="layers")renderPanel("layers")}

function pointerPos(e){
  const r=canvas.getBoundingClientRect();
  const p=e.touches?e.touches[0]:e;
  return {x:p.clientX-r.left,y:p.clientY-r.top};
}
function pinchMetrics(){
  const pts=[...state.pointers.values()];
  if(pts.length<2)return null;
  const a=pts[0],b=pts[1];
  return {distance:Math.hypot(b.x-a.x,b.y-a.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2};
}
canvas.addEventListener("pointerdown",onPointerDown);
canvas.addEventListener("pointermove",onPointerMove);
canvas.addEventListener("pointerup",onPointerUp);
canvas.addEventListener("pointercancel",onPointerUp);
canvas.addEventListener("wheel",e=>{e.preventDefault();const pos=pointerPos(e);if(state.activeTab==="image"&&!state.current.imageLocked)zoomImageAt(pos.x,pos.y,e.deltaY<0?1.12:.89);else zoomAt(pos.x,pos.y,e.deltaY<0?1.12:.89)},{passive:false});

function onPointerDown(e){
  if(!state.current)return;
  canvas.setPointerCapture?.(e.pointerId);
  const p=pointerPos(e);state.pointers.set(e.pointerId,p);
  if(state.pointers.size===2){
    const m=pinchMetrics(),anchor=screenToWorld(m.x,m.y);
    if(state.activeTab==="image"&&!state.current.imageLocked){const f=imageFrame(),tr=state.current.imageTransform||(state.current.imageTransform={x:0,y:0,scale:1});snapshot();state.pinch={target:"image",distance:m.distance,scale:tr.scale,local:{x:(anchor.x-f.imgX-tr.x)/tr.scale,y:(anchor.y-f.imgY-tr.y)/tr.scale}}}
    else state.pinch={target:"view",distance:m.distance,zoom:state.view.zoom,anchor};
    state.pointer.down=false;state.pointer.mode=null;return;
  }
  state.pointer.down=true;Object.assign(state.pointer,{x:p.x,y:p.y,startX:p.x,startY:p.y});
  const w=screenToWorld(p.x,p.y);

  if(state.activeTab==="grid"){
    if(!state.current.grid.locked){const hit=gridHandlePoints().some(q=>Math.hypot(w.x-q.x,w.y-q.y)<=14/state.view.zoom);snapshot();if(hit){const gg=gridGeom();state.pointer.mode="resize-grid";state.pointer.gridStart={cell:gg.cell,anchorX:gg.x+gg.gw,anchorY:gg.y};return}state.pointer.mode="move-grid";state.pointer.gridStart={right:state.current.grid.originRight,top:state.current.grid.originTop};return}
  }
  if(state.activeTab==="image"){if(state.cropSession){const hit=hitCropControl(w);if(hit){state.pointer.mode="crop-edit";state.pointer.cropStart={handle:hit,world:w,rect:JSON.parse(JSON.stringify(state.cropSession.rect))};return}}const guideIndex=hitGuide(w);if(guideIndex!=null){state.selection.guide=guideIndex;const guide=state.imageAids.guides[guideIndex];if(!guide.locked)snapshot();state.pointer.mode=guide.locked?"guide-select":"guide-move";renderPanel("image");renderAll();return}const rulerType=rulerDragType(w);if(rulerType){state.pointer.mode="guide-create-pending";state.pointer.guideType=rulerType;return}if(state.current.imageLocked){state.pointer.mode="pan";return}const tr=state.current.imageTransform||(state.current.imageTransform={x:0,y:0,scale:1});snapshot();state.pointer.mode="image-move";state.pointer.imageStart={x:tr.x,y:tr.y};return}
  if(state.pointer.mode==="axis-create"){
    if(!state.pointer.axisStart){state.pointer.axisStart=snapPoint(w);toast("اختاري نقطة النهاية")}
    else{
      const start=state.pointer.axisStart; let end=snapPoint(w);
      if(pendingAxisAngle!=="free"&&pendingAxisAngle!=null){
        const len=Math.hypot(end.x-start.x,end.y-start.y);
        const rad=-pendingAxisAngle*Math.PI/180;end={x:start.x+len*Math.cos(rad),y:start.y+len*Math.sin(rad)};
      }
      snapshot();activeItems().axes.push({x1:start.x,y1:start.y,x2:end.x,y2:end.y,color:"#00e5ff",opacity:100,thickness:.35,visible:true,lockedAngle:pendingAxisAngle!=="free",presetAngle:pendingAxisAngle,showAngle:false});
      state.selection.axis=activeItems().axes.length-1;state.pointer.axisStart=null;state.pointer.mode=null;renderAll();scheduleSave();renderPanel("axes");toast(`زاوية المحور ${axisAngle(activeItems().axes.at(-1)).toFixed(1)}°`);
    }
    return;
  }
  if(state.pointer.mode==="shape-create"){state.pointer.shapeStart=w;return}
  if(getActiveLayer()?.type==="drawing"&&state.activeTab==="layers"){
    const l=getActiveLayer();if(l.locked)return toast("الطبقة مقفلة");
    snapshot();
    const tool=state.current.drawingSettings.tool,profile=state.current.drawingProfiles?.[tool]||state.current.drawingSettings;
    currentStroke={tool,size:profile.size/state.view.zoom,color:profile.color,opacity:profile.opacity,points:[w]};
    l.items.drawing.push(currentStroke);state.pointer.mode="draw";return;
  }

  if(state.activeTab==="axes"){
    const hit=hitAxis(w);if(hit){state.selection.axis=hit.index;state.selection.shape=null;state.selection.diag=null;if(!state.selection.axisEditing){state.pointer.mode="axis-select";renderPanel("axes");renderAll();updateStatus();return}state.pointer.mode="axis-edit";state.pointer.editHandle=hit.handle;state.pointer.editOrigin=w;state.pointer.editSnapshot=JSON.parse(JSON.stringify(activeItems().axes[hit.index]));snapshot();renderPanel("axes");renderAll();return}
  }
  if(state.activeTab==="shapes"){
    if(state.shapeEraser.active){const arr=activeItems().shapes,r=state.shapeEraser.size/state.view.zoom;let index=null;for(let i=arr.length-1;i>=0;i--)if(pointInShape(w,arr[i],r)){index=i;break}if(index!=null){snapshot();state.selection.shape=index;applyShapeMask(arr[index],w,r,state.shapeEraser.mode);state.pointer.mode="shape-mask";renderAll();return}state.pointer.mode="shape-mask-empty";return}
    const hit=hitShape(w);if(hit){state.selection.shape=hit.index;if(!state.selection.shapeEditing){state.pointer.mode="shape-select";renderPanel("shapes");renderAll();return}state.pointer.mode="shape-edit";state.pointer.editHandle=hit.handle;state.pointer.editOrigin=w;state.pointer.editSnapshot=JSON.parse(JSON.stringify(activeItems().shapes[hit.index]));snapshot();renderPanel("shapes");renderAll();return}
  }
  if(state.activeTab==="basicDiag"||state.activeTab==="subDiag"){
    state.pointer.mode="cell-select";state.pointer.selectWorld=w;
  } else {
    state.pointer.mode="pan";
  }
}
function onPointerMove(e){
  if(!state.current)return;
  const p=pointerPos(e);if(state.pointers.has(e.pointerId))state.pointers.set(e.pointerId,p);
  if(state.activeTab==="shapes"&&state.shapeEraser.active){state.shapeEraser.hover=screenToWorld(p.x,p.y);if(!state.pointer.down){renderAll();return}}
  if(state.pinch&&state.pointers.size>=2){
    const m=pinchMetrics();if(state.pinch.target==="image"){const f=imageFrame(),w=screenToWorld(m.x,m.y),tr=state.current.imageTransform;tr.scale=clamp(state.pinch.scale*(m.distance/state.pinch.distance),.1,10);tr.x=w.x-f.imgX-state.pinch.local.x*tr.scale;tr.y=w.y-f.imgY-state.pinch.local.y*tr.scale}else{state.view.zoom=clamp(state.pinch.zoom*(m.distance/state.pinch.distance),.05,20);state.view.panX=m.x-state.pinch.anchor.x*state.view.zoom;state.view.panY=m.y-state.pinch.anchor.y*state.view.zoom}renderAll();return;
  }
  if(!state.pointer.down)return;
  const dx=p.x-state.pointer.startX,dy=p.y-state.pointer.startY;
  if(state.pointer.mode==="pan"){
    state.view.panX+=p.x-state.pointer.x;state.view.panY+=p.y-state.pointer.y;renderAll();
  } else if(state.pointer.mode==="move-grid"){
    state.current.grid.originRight=state.pointer.gridStart.right+dx/state.view.zoom;state.current.grid.originTop=state.pointer.gridStart.top+dy/state.view.zoom;renderAll();
  } else if(state.pointer.mode==="resize-grid"){
    const w=screenToWorld(p.x,p.y),s=state.pointer.gridStart,gr=state.current.grid,width=Math.max(8,Math.abs(s.anchorX-w.x)),height=Math.max(8,Math.abs(w.y-s.anchorY));gr.cellSize=clamp(Math.max(width/gr.cols,height/gr.rows),8,400);renderAll();refreshGridControlLabels();
  } else if(state.pointer.mode==="crop-edit"){
    updateCropEdit(screenToWorld(p.x,p.y));renderAll();
  } else if(state.pointer.mode==="draw"&&currentStroke){
    currentStroke.points.push(screenToWorld(p.x,p.y));renderAll();
  } else if(state.pointer.mode==="cell-select"&&Math.hypot(dx,dy)>6){
    state.pointer.mode="pan";state.view.panX+=p.x-state.pointer.x;state.view.panY+=p.y-state.pointer.y;renderAll();
  } else if(state.pointer.mode==="axis-edit"){
    editAxisAt(snapPoint(screenToWorld(p.x,p.y)));renderAll();
  } else if(state.pointer.mode==="shape-edit"){
    editShapeAt(snapPoint(screenToWorld(p.x,p.y)));renderAll();
  } else if(state.pointer.mode==="shape-mask"){
    const s=activeItems().shapes[state.selection.shape],q=screenToWorld(p.x,p.y),r=state.shapeEraser.size/state.view.zoom;if(s){applyShapeMask(s,q,r,state.shapeEraser.mode);renderAll()}
  } else if(state.pointer.mode==="guide-move"){
    const guide=state.imageAids.guides[state.selection.guide];guide.pos=guide.type==="v"?screenToWorld(p.x,p.y).x:screenToWorld(p.x,p.y).y;renderAll();
  } else if(state.pointer.mode==="guide-create-pending"&&Math.hypot(dx,dy)>6){
    const w=screenToWorld(p.x,p.y);addGuide(state.pointer.guideType,state.pointer.guideType==="v"?w.x:w.y,false);state.pointer.mode="guide-create";
  } else if(state.pointer.mode==="guide-create"){
    const guide=state.imageAids.guides[state.selection.guide],w=screenToWorld(p.x,p.y);guide.pos=guide.type==="v"?w.x:w.y;renderAll();
  } else if(state.pointer.mode==="image-move"){
    const tr=state.current.imageTransform;tr.x=state.pointer.imageStart.x+dx/state.view.zoom;tr.y=state.pointer.imageStart.y+dy/state.view.zoom;snapImageTransform(tr);renderAll();
  }
  state.pointer.x=p.x;state.pointer.y=p.y;
}
function onPointerUp(e){
  state.pointers.delete(e.pointerId);
  if(state.pinch){
    if(state.pointers.size<2){if(state.pinch.target==="image")scheduleSave();state.pinch=null}
    state.pointer.down=false;state.pointer.mode=null;return;
  }
  if(!state.pointer.down)return;
  const p=pointerPos(e),w=screenToWorld(p.x,p.y);
  if(state.pointer.mode==="move-grid")scheduleSave();
  if(state.pointer.mode==="resize-grid")scheduleSave();
  if(state.pointer.mode==="draw"){currentStroke=null;scheduleSave()}
  if(state.pointer.mode==="cell-select"){
    selectCellAt(w.x,w.y,state.activeTab==="subDiag");
    const raw=hitDiagonals(w,pointerTolerance(e)),groups=new Map();for(const h of raw){const id=`${h.sub}|${h.key}|${h.quarter}|${h.kind}`,old=groups.get(id);if(!old||h.d<old.d)groups.set(id,h)}const preferred=state.activeTab==="subDiag",hits=[...groups.values()].sort((a,b)=>(a.sub===preferred?0:1)-(b.sub===preferred?0:1)||a.d-b.d);
    if(hits.length){const h=hits[0];state.selection.diag={sub:h.sub,key:h.key,quarter:h.quarter,kind:h.kind};state.selection.cellKey=h.key;const r=cellRectByKey(h.key);if(r){const visual=state.current.grid.cols-1-r.c,label=gridLabelForVisual(visual,r.r);state.selection.cell=label?label+(cellIsComplete(visual,r.r)?"":" — جزئي"):"خارج الصورة — غير مرقم"}if(h.sub)state.selection.quarter=h.quarter;updateStatus();renderAll();renderPanel(state.activeTab)}else{state.selection.diag=null;updateStatus();renderAll()}
  }
  if(state.pointer.mode==="axis-edit"){scheduleSave();renderPanel("axes")}
  if(state.pointer.mode==="shape-edit"){scheduleSave();renderPanel("shapes")}
  if(state.pointer.mode==="shape-mask"){scheduleSave();renderPanel("shapes")}
  if(state.pointer.mode==="guide-move"||state.pointer.mode==="guide-create"){const guide=state.imageAids.guides[state.selection.guide],f=imageFrame(),outside=guide&&(guide.type==="v"?(guide.pos<0||guide.pos>f.fw):(guide.pos<0||guide.pos>f.fh));if(outside&&!guide.locked){state.imageAids.guides.splice(state.selection.guide,1);state.selection.guide=null}state.current.imageGuides=state.imageAids.guides;renderAll();scheduleSave();renderPanel("image")}
  if(state.pointer.mode==="image-move")scheduleSave();
  if(state.pointer.mode==="shape-create"&&state.pointer.shapeStart){
    const s=state.pointer.shapeStart; const end=w; const l=getActiveLayer(); if(l.locked){toast("الطبقة مقفلة")}
    else{
      snapshot();
      const x=Math.min(s.x,end.x),y=Math.min(s.y,end.y),w0=Math.abs(end.x-s.x),h0=Math.abs(end.y-s.y);
      let sh;
      if(pendingShape==="circle")sh={type:"circle",cx:(s.x+end.x)/2,cy:(s.y+end.y)/2,rx:Math.max(w0,h0)/2};
      else if(pendingShape==="ellipse")sh={type:"ellipse",cx:(s.x+end.x)/2,cy:(s.y+end.y)/2,rx:w0/2,ry:h0/2,rotation:0};
      else if(pendingShape==="rect")sh={type:"rect",x,y,w:w0,h:h0};
      else if(pendingShape==="square"){const side=Math.max(w0,h0);sh={type:"square",x:s.x<=end.x?s.x:s.x-side,y:s.y<=end.y?s.y:s.y-side,w:side,h:side}}
      else if(pendingShape==="line")sh={type:"line",x1:s.x,y1:s.y,x2:end.x,y2:end.y};
      else sh={type:"triangle",p1:{x:(s.x+end.x)/2,y},p2:{x:end.x,y:end.y},p3:{x:s.x,y:end.y}};
      Object.assign(sh,{color:"#ff2d55",opacity:100,thickness:.35,visible:true});
      l.items.shapes.push(sh);state.selection.shape=l.items.shapes.length-1;state.selection.shapeEditing=false;renderAll();scheduleSave();renderPanel("shapes");
    }
    state.pointer.shapeStart=null;state.pointer.mode=null;pendingShape=null;
  }
  state.pointer.down=false;
  if(state.pointer.mode==="pan")state.pointer.mode=null;
}
function editAxisAt(p){
  const a=activeItems().axes[state.selection.axis],old=state.pointer.editSnapshot;if(!a||!old)return;
  if(state.pointer.editHandle==="move"){const dx=p.x-state.pointer.editOrigin.x,dy=p.y-state.pointer.editOrigin.y;a.x1=old.x1+dx;a.y1=old.y1+dy;a.x2=old.x2+dx;a.y2=old.y2+dy;return}
  const angle=(a.presetAngle??axisAngle(old))*Math.PI/180;
  if(state.pointer.editHandle==="start"){
    if(a.lockedAngle){const len=Math.hypot(a.x2-p.x,a.y2-p.y);a.x1=a.x2-len*Math.cos(angle);a.y1=a.y2+len*Math.sin(angle)}else{a.x1=p.x;a.y1=p.y}
  }else{
    if(a.lockedAngle){const len=Math.hypot(p.x-a.x1,p.y-a.y1);a.x2=a.x1+len*Math.cos(angle);a.y2=a.y1-len*Math.sin(angle)}else{a.x2=p.x;a.y2=p.y}
  }
}
function editShapeAt(p){
  const s=activeItems().shapes[state.selection.shape],old=state.pointer.editSnapshot,h=state.pointer.editHandle;if(!s||!old)return;
  if(h==="move"){const dx=p.x-state.pointer.editOrigin.x,dy=p.y-state.pointer.editOrigin.y;if(s.cx!=null){s.cx=old.cx+dx;s.cy=old.cy+dy}else if(s.type==="rect"||s.type==="square"){s.x=old.x+dx;s.y=old.y+dy}else if(s.type==="triangle"){for(const key of ["p1","p2","p3"]){s[key].x=old[key].x+dx;s[key].y=old[key].y+dy}}else{s.x1=old.x1+dx;s.y1=old.y1+dy;s.x2=old.x2+dx;s.y2=old.y2+dy}return}
  if(s.type==="circle")s.rx=Math.max(1,Math.hypot(p.x-s.cx,p.y-s.cy));
  else if(s.type==="ellipse"){if(h==="rx")s.rx=Math.max(1,Math.abs(p.x-s.cx));else s.ry=Math.max(1,Math.abs(p.y-s.cy))}
  else if(s.type==="rect"||s.type==="square"){
    if(h.includes("l")){s.w=old.x+old.w-p.x;s.x=p.x}else s.w=p.x-old.x;
    if(h.includes("t")){s.h=old.y+old.h-p.y;s.y=p.y}else s.h=p.y-old.y;
    if(s.type==="square"){const side=Math.max(Math.abs(s.w),Math.abs(s.h)),sx=Math.sign(s.w)||1,sy=Math.sign(s.h)||1;s.w=side*sx;s.h=side*sy}
  }else if(s.type==="triangle")s[h]={x:p.x,y:p.y};
  else if(h==="p1"){s.x1=p.x;s.y1=p.y}else{s.x2=p.x;s.y2=p.y}
}
function selectCellAt(x,y,subMode){
  const gg=gridGeom();if(!gg)return;
  if(x<gg.x||x>=gg.x+gg.gw||y<gg.y||y>=gg.y+gg.gh)return;
  const visualCol=clamp(Math.floor((x-gg.x)/gg.cell),0,state.current.grid.cols-1), row=clamp(Math.floor((y-gg.y)/gg.cell),0,state.current.grid.rows-1);
  if(!cellIntersectsVisibleImage(visualCol,row)){state.selection.cell="خارج الصورة — غير مرقم";state.selection.cellKey=null;toast("هذه الخلية لا تتقاطع مع الصورة");updateStatus();return}
  const c=state.current.grid.cols-1-visualCol,label=gridLabelForVisual(visualCol,row);if(!label){toast("ثبتي الشبكة لإنشاء الترقيم التلقائي");return}
  state.selection.cellKey=`${row},${c}`;state.selection.cell=label+(cellIsComplete(visualCol,row)?"":" — جزئي");
  if(subMode){
    const localX=(x-(gg.x+visualCol*gg.cell))/gg.cell, localY=(y-(gg.y+row*gg.cell))/gg.cell;
    const right=localX>=.5,bottom=localY>=.5;
    state.selection.quarter=right?(bottom?2:0):(bottom?3:1);
  }
  $("#selectionBadge").classList.remove("hidden");
  $("#selectionBadge").textContent=subMode?`${state.selection.cell} · ربع ${state.selection.quarter+1}`:state.selection.cell;
  updateStatus();
  renderPanel(state.activeTab); renderAll();
}
function zoomAt(x,y,factor){
  const before=screenToWorld(x,y);state.view.zoom=clamp(state.view.zoom*factor,.05,20);
  state.view.panX=x-before.x*state.view.zoom;state.view.panY=y-before.y*state.view.zoom;renderAll();
}
function zoomImageAt(x,y,factor){
  const f=imageFrame(),tr=state.current.imageTransform||(state.current.imageTransform={x:0,y:0,scale:1}),w=screenToWorld(x,y),localX=(w.x-f.imgX-tr.x)/tr.scale,localY=(w.y-f.imgY-tr.y)/tr.scale,next=clamp(tr.scale*factor,.1,10);snapshot();tr.scale=next;tr.x=w.x-f.imgX-localX*next;tr.y=w.y-f.imgY-localY*next;renderAll();scheduleSave();
}

async function exportPreset(mode){
  if(!state.current||!state.sourceImage)return;
  if(mode==="all"){
    const specs=[["imageGrid","01-image-grid.png"],["imageAll","02-image-grid-all-layers.png"],["imageLayer","03-image-grid-selected-layer.png"],["whiteDiags","04-grid-diagonals.png"],["gridDrawing","05-grid-diagonals-drawing.png"],["drawingOnly","06-drawing-only.png"]],files=[];$("#exportModal").classList.add("hidden");showExportProgress("جاري تجهيز الملفات 0 / 6");for(let i=0;i<specs.length;i++){const [m,name]=specs[i];$("#saveShareStatus").textContent=`جاري تجهيز الملفات ${i+1} / 6`;try{const f=await createExportFile(m);f.name=name;files.push(f)}catch{toast(`تعذر إنشاء ${name}`);$("#saveShareModal").classList.add("hidden");return}}$("#saveShareStatus").textContent="جاري إنشاء ملف ZIP";const zip=await makeZip(files),zipName=`Art-grid-by-Nora-${sanitizeName(state.current.name)}.zip`;showSaveShare([{blob:zip,name:zipName,type:"application/zip",count:files.length}],{zip:true});$("#saveShareStatus").textContent="جاهز للحفظ";toast("تم إنشاء حزمة التصدير");
    return;
  }
  const file=await createExportFile(mode);showSaveShare([file]);
  $("#exportModal").classList.add("hidden");toast("تم تجهيز الملف للحفظ أو المشاركة");
}
function showExportProgress(message){preparedExports=[];$("#saveSharePreview").innerHTML=`<div class="file-summary"><b>تجهيز حزمة التصدير</b></div>`;$("#saveShareActions").innerHTML="";$("#saveShareStatus").textContent=message;$("#saveShareModal").classList.remove("hidden")}
async function createExportFile(mode){
  let opt={includeImage:true};
  if(mode==="imageGrid")opt={includeImage:true,includeBasic:false,includeSub:false,includeAxes:false,includeShapes:false,includeDrawing:false,includeGuides:false};
  else if(mode==="imageAll")opt={includeImage:true};
  else if(mode==="whiteDiags")opt={includeImage:false,whiteBackground:true,includeAxes:false,includeShapes:false,includeDrawing:false,includeGuides:false};
  else if(mode==="gridDrawing")opt={includeImage:false,whiteBackground:true,includeAxes:false,includeShapes:false,includeGuides:false};
  else if(mode==="drawingOnly")opt={includeImage:false,whiteBackground:true,includeGrid:false,includeBasic:false,includeSub:false,includeAxes:false,includeShapes:false,includeGuides:false,layerIds:state.current.layers.filter(l=>l.type==="drawing").map(l=>l.id)};
  else if(mode==="imageLayer")opt={includeImage:true,layerIds:[state.current.activeLayerId]};
  const f=imageFrame(), max=3000, scale=Math.min(1,max/Math.max(f.fw,f.fh));
  const out=document.createElement("canvas");out.width=Math.round(f.fw*scale);out.height=Math.round(f.fh*scale);
  const g=out.getContext("2d");g.scale(scale,scale);drawProject(g,opt);
  const blob=await new Promise(r=>out.toBlob(r,"image/png"));
  if(!blob)throw new Error("تعذر إنشاء صورة التصدير");
  const suffix={imageGrid:"image-grid",imageAll:"all-layers",imageLayer:"selected-layer",whiteDiags:"grid-diagonals",gridDrawing:"grid-drawing",drawingOnly:"drawing-only",current:"current-view"}[mode]||mode;
  return{blob,name:`${sanitizeName(state.current.name)}_${suffix}.png`,type:"image/png",preview:out.toDataURL("image/png")};
}
function sanitizeName(s){return (s||"project").trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g,"-").replace(/[. ]+$/g,"")||"project"}
function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{a.remove();URL.revokeObjectURL(url)},1500);
}
let preparedExports=[];
function showSaveShare(files,meta={}){preparedExports=files;const modal=$("#saveShareModal"),preview=$("#saveSharePreview"),actions=$("#saveShareActions"),status=$("#saveShareStatus"),total=files.reduce((n,f)=>n+f.blob.size,0);preview.innerHTML="";actions.innerHTML="";status.textContent=meta.zip?"تم إنشاء حزمة التصدير":"تم تجهيز الملف للحفظ أو المشاركة";if(files.length===1&&files[0].preview){const img=document.createElement("img");img.src=files[0].preview;img.alt="معاينة ملف التصدير";preview.appendChild(img)}else preview.innerHTML=`<div class="file-summary"><b>${files[0]?.name||"ملفات التصدير"}</b>${meta.zip?`${files[0].count} ملفات · `:""}${formatBytes(total)}</div>`;
  const nativeFiles=files.map(f=>new File([f.blob],f.name,{type:f.type}));if(navigator.share&&navigator.canShare?.({files:nativeFiles})){const b=document.createElement("button");b.className="primary";b.textContent="حفظ أو مشاركة";b.onclick=async()=>{try{await navigator.share({files:nativeFiles,title:state.current?.name||"Art grid by Nora"})}catch(e){if(e.name!=="AbortError")toast("تعذرت المشاركة")}};actions.appendChild(b)}
  if(files.length===1&&window.showSaveFilePicker){const b=document.createElement("button");b.textContent="حفظ باسم";b.onclick=async()=>{try{const h=await showSaveFilePicker({suggestedName:files[0].name,types:[{description:"ملف التصدير",accept:{[files[0].type]:["."+files[0].name.split(".").pop()]}}]}),w=await h.createWritable();await w.write(files[0].blob);await w.close();toast("تم حفظ الملف")}catch(e){if(e.name!=="AbortError")toast("تعذر حفظ الملف")}};actions.appendChild(b)}
  if(files.length===1&&"download" in HTMLAnchorElement.prototype&&typeof URL?.createObjectURL==="function"){const b=document.createElement("button");b.textContent="تنزيل الملف";b.onclick=()=>{downloadBlob(files[0].blob,files[0].name);toast("تم حفظ الملف")};actions.appendChild(b)}modal.classList.remove("hidden")}
function formatBytes(n){return n<1024?`${n} بايت`:n<1048576?`${(n/1024).toFixed(1)} كيلوبايت`:`${(n/1048576).toFixed(1)} ميجابايت`}
function crc32(bytes){let c=-1;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xEDB88320:0)}return(c^-1)>>>0}
function le32(v){return new Uint8Array([v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255])}function le16(v){return new Uint8Array([v&255,(v>>>8)&255])}
async function makeZip(files){const enc=new TextEncoder(),locals=[],centrals=[];let offset=0;for(const f of files){const name=enc.encode(f.name),data=new Uint8Array(await f.blob.arrayBuffer()),crc=crc32(data),local=new Blob([le32(0x04034b50),le16(20),le16(0x800),le16(0),le16(0),le16(0),le32(crc),le32(data.length),le32(data.length),le16(name.length),le16(0),name,data]);locals.push(local);centrals.push(new Blob([le32(0x02014b50),le16(20),le16(20),le16(0x800),le16(0),le16(0),le16(0),le32(crc),le32(data.length),le32(data.length),le16(name.length),le16(0),le16(0),le16(0),le16(0),le32(0),le32(offset),name]));offset+=local.size}const centralSize=centrals.reduce((n,b)=>n+b.size,0),end=new Blob([le32(0x06054b50),le16(0),le16(0),le16(files.length),le16(files.length),le32(centralSize),le32(offset),le16(0)]);return new Blob([...locals,...centrals,end],{type:"application/zip"})}

$("#newProjectBtn").onclick=()=>$("#newProjectModal").classList.remove("hidden");
$("#cancelNewProjectBtn").onclick=()=>$("#newProjectModal").classList.add("hidden");
$("#pickPhotoBtn").onclick=()=>$("#imageInput").click();
$("#pickCameraBtn").onclick=()=>$("#cameraInput").click();
$("#useSampleBtn").onclick=async()=>{
  try{
    const response=await fetch("test-art-grid.svg");if(!response.ok)throw new Error("sample");
    pickedImageData=await fileToDataURL(new File([await response.blob()],"صورة-تجريبية.svg",{type:"image/svg+xml"}));
    await loadImg(pickedImageData);$("#pickedImageName").textContent="صورة-تجريبية.svg";$("#newProjectError").classList.add("hidden");
  }catch(error){console.error("تعذر تحميل الصورة التجريبية",error);showProjectError("تعذر تحميل الصورة التجريبية.")}
};
let pickedImageData="";
for(const id of ["imageInput","cameraInput"]){
  $("#"+id).onchange=async e=>{
    const file=e.target.files[0];if(!file)return;
    try{
      if(!file.type.startsWith("image/"))throw new Error("not-image");
      pickedImageData=await fileToDataURL(file);
      await loadImg(pickedImageData);
      $("#pickedImageName").textContent=file.name||"تم اختيار الصورة";
      $("#newProjectError").classList.add("hidden");
    }catch(error){
      console.error("تعذر قراءة الصورة",error);pickedImageData="";e.target.value="";
      showProjectError("تعذر قراءة الصورة. اختاري ملف صورة صالحًا.");
    }
  };
}
function showProjectError(message){const el=$("#newProjectError");el.textContent=message;el.classList.remove("hidden")}
function fileToDataURL(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file)})}
$("#frameShapeSelector").onclick=e=>{
  const b=e.target.closest("button");if(!b)return;
  $$("#frameShapeSelector button").forEach(x=>x.classList.remove("active"));b.classList.add("active");
};
$("#paperOrientationSelector").onclick=e=>{const b=e.target.closest("button");if(!b)return;$$("#paperOrientationSelector button").forEach(x=>x.classList.remove("active"));b.classList.add("active")};
$("#createProjectBtn").onclick=async()=>{
  const name=$("#projectNameInput").value.trim();if(!pickedImageData)return showProjectError("اختاري صورة أولًا.");if(!name){showProjectError("اسم المشروع إلزامي.");$("#projectNameInput").focus();return}
  const place=document.querySelector('input[name="savePlace"]:checked').value;
  if(place!=="device")toast("سيُحفظ محليًا الآن؛ السحابة تحتاج Backend لاحقًا");
  const p=defaults();p.name=name;p.imageData=pickedImageData;p.document={paperSize:$("#frameShapeSelector button.active").dataset.value,orientation:$("#paperOrientationSelector button.active").dataset.value,unit:"mm"};p.notebook.paper=p.document.paperSize;p.notebook.orientation=p.document.orientation;p.savePlace=place;
  try{
    state.current=p;resetSessionAids();await db.put(p);$("#newProjectModal").classList.add("hidden");await hydrateImage();showEditor();fitView();renderAll();scheduleSave();
    pickedImageData="";$("#projectNameInput").value="";$("#imageInput").value="";$("#cameraInput").value="";$("#pickedImageName").textContent="لم يتم اختيار صورة";$("#newProjectError").classList.add("hidden");
  }catch(error){console.error("تعذر إنشاء المشروع",error);showProjectError("تعذر إنشاء المشروع أو حفظ الصورة محليًا.")}
};
$("#importProjectBtn").onclick=()=>$("#importProjectInput").click();
$("#importProjectInput").onchange=async e=>{
  const file=e.target.files[0];if(!file)return;
  try{const obj=JSON.parse(await file.text());if(!obj.id||!obj.name)throw 0;obj.id=uid();obj.updatedAt=Date.now();await db.put(obj);await loadLibrary();toast("تم استيراد المشروع")}catch{alert("ملف المشروع غير صالح")}
};
$("#loginBtn").onclick=()=>toast("تسجيل الدخول والسحابة يحتاجان Backend، وتم تجهيز الواجهة فقط.");
$("#projectSearch").oninput=renderLibrary;
$("#backToLibraryBtn").onclick=async()=>{await saveCurrent();showLibrary()};
$("#undoBtn").onclick=undo;$("#redoBtn").onclick=redo;
$("#zoomInBtn").onclick=()=>zoomAt(canvas.clientWidth/2,canvas.clientHeight/2,1.2);
$("#zoomOutBtn").onclick=()=>zoomAt(canvas.clientWidth/2,canvas.clientHeight/2,.833);
$("#fitBtn").onclick=fitView;
$("#exportBtn").onclick=()=>state.activeTab==="export"?closePanel():renderPanel("export");
$("#closeExportBtn").onclick=()=>$("#exportModal").classList.add("hidden");
$("#closeSaveShareBtn").onclick=()=>$("#saveShareModal").classList.add("hidden");
$$("[data-export]").forEach(b=>b.onclick=()=>exportPreset(b.dataset.export));
$("#activeLayerStatus").onclick=()=>renderPanel("layers");
$$("#bottomToolbar button").forEach(b=>b.onclick=()=>{
  const tab=b.dataset.tab;
  if(state.activeTab===tab)closePanel();else{if(tab==="shapes"){state.shapePulseUntil=Date.now()+900;const pulse=setInterval(()=>{renderAll();if(Date.now()>state.shapePulseUntil)clearInterval(pulse)},90)}renderPanel(tab)}
});

loadLibrary();
})();
