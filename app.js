(function(){
  // ---------- study area = CityCAT flood-model extent (see data/flood.js) ----------
  const _FB=(typeof FLOOD_BOUNDS!=="undefined")?FLOOD_BOUNDS:[[39.106,-76.905],[39.510,-76.274]];
  const latBot=_FB[0][0], lngL=_FB[0][1], latTop=_FB[1][0], lngR=_FB[1][1];
  const LA=y=>latTop-(latTop-latBot)*y, LO=x=>lngL+(lngR-lngL)*x;
  const XN=lng=>Math.max(0,Math.min(1,(lng-lngL)/(lngR-lngL)));
  const YN=lat=>Math.max(0,Math.min(1,(latTop-lat)/(latTop-latBot)));
  const inBox=(lat,lng)=>lng>=lngL&&lng<=lngR&&lat>=latBot&&lat<=latTop;

  // ---------- storm model (REAL CityCAT max-depth rasters) ----------
  const S={rp:10,dur:1,cond:"base"};
  const RAIN={10:{1:2.1,24:4.9},100:{1:3.3,24:8.3}}; // NOAA Atlas 14, inches
  function gimul(){return S.cond==="gi"?0.70:1;} // green-infrastructure depth reduction

  // ---------- FORECAST mode (pluvial / rain-on-grid) ----------
  // Two modes share the SAME CityCAT depth grids and every downstream feature:
  //   "design"   -> pick one of the 4 pre-run design storms (rp x dur)   [original behavior]
  //   "forecast" -> enter a forecast RAINFALL (inches) + duration; we snap to the nearest
  //                 pre-computed CityCAT run for that duration and scale depth by the ratio
  //                 of entered rain to that run's rain (clamped). This mirrors the funded
  //                 "pre-computed rainfall library" plan; a true per-value run is a later option.
  const MODE={cur:"design"};
  // forecast inputs: rainfall (in), duration (h), focus point (lat/lng or null=whole Beltway),
  // focus radius (mi; 0 = whole Beltway), and animation time (0..1 of the modeled maximum)
  const FC={rain:3.3,dur:1,lat:null,lng:null,rad:1,animT:1};
  // nearest design run (rp) for a forecast rainfall at a given duration
  function fcNearest(){
    const dur=FC.dur, r10=RAIN[10][dur], r100=RAIN[100][dur];
    return (Math.abs(FC.rain-r10)<=Math.abs(FC.rain-r100))
      ? {rp:10, base:r10} : {rp:100, base:r100};
  }
  // depth scale applied on top of the chosen grid (1 in design mode). In forecast mode we
  // scale by rainfall ratio AND by the animation time (water building up to the maximum).
  function depthScale(){
    if(MODE.cur!=="forecast")return 1;
    const n=fcNearest(); let s=n.base>0?FC.rain/n.base:1;
    if(s<0)s=0; if(s>2.5)s=2.5;   // clamp: DEMO approximation, not a new CityCAT run
    const t=(FC.animT==null)?1:Math.max(0,Math.min(1,FC.animT));
    return s*t;
  }
  // is a lat/lng inside the current forecast focus? (true everywhere when no focus / Beltway)
  function inFocus(lat,lng){
    if(MODE.cur!=="forecast"||FC.lat==null||!(FC.rad>0))return true;
    const dx=(lng-FC.lng)*Math.cos(FC.lat*Math.PI/180), dy=lat-FC.lat;
    return Math.sqrt(dx*dx+dy*dy)*69<=FC.rad;   // ~69 miles per degree
  }
  // true when a forecast focus circle is active (location + finite radius)
  function focusActive(){return MODE.cur==="forecast"&&FC.lat!=null&&FC.rad>0;}
  // gate for point markers (reports / 311 / live conditions): when a forecast focus is
  // active, only keep points inside the selected area; otherwise keep everything
  function fcPass(lat,lng){return !focusActive()||inFocus(lat,lng);}
  // does a polygon geometry overlap the focus circle? (any vertex inside the circle, OR the
  // focus center inside the polygon) — used to clip ZIP-polygon layers like insurance claims
  function geomIntersectsFocus(geom){
    if(!focusActive()||!geom)return true;
    const polys=geom.type==="MultiPolygon"?geom.coordinates:[geom.coordinates];
    for(const poly of polys)for(const ring of poly)
      for(const pt of ring){if(inFocus(pt[1],pt[0]))return true;}
    // focus center inside the polygon?
    try{if(pipGeom(geom,FC.lat,FC.lng))return true;}catch(e){}
    return false;
  }
  // bounding box (Leaflet LatLngBounds) of the focus circle, for clamping server rasters
  function focusBoundsLL(){
    if(!focusActive())return null;
    const dLat=FC.rad/69, dLng=FC.rad/(69*Math.cos(FC.lat*Math.PI/180));
    if(typeof L==="undefined")return null;
    return L.latLngBounds(L.latLng(FC.lat-dLat,FC.lng-dLng),L.latLng(FC.lat+dLat,FC.lng+dLng));
  }
  function scenKey(){
    if(MODE.cur==="forecast")return fcNearest().rp+"_"+FC.dur;
    return S.rp+"_"+S.dur;
  }
  // rainfall (inches) for the CURRENT scenario, whichever mode
  function curRainIn(){return MODE.cur==="forecast"?FC.rain:RAIN[S.rp][S.dur];}
  function curDurH(){return MODE.cur==="forecast"?FC.dur:S.dur;}
  // short human label for the active scenario (used across popups/briefing)
  function scenLabel(){
    if(MODE.cur==="forecast"){
      const n=fcNearest();
      return FC.rain.toFixed(1)+" in / "+FC.dur+"-hr forecast";
    }
    return S.rp+"-year, "+S.dur+"-hour storm";
  }
  const GW=(typeof FLOOD_GW!=="undefined")?FLOOD_GW:1, GH=(typeof FLOOD_GH!=="undefined")?FLOOD_GH:1;
  // normalized (x,y) in [0,1] -> modeled water depth in metres; y=0 is north (top row)
  function depthAt(x,y){
    if(typeof FLOOD_DEPTH==="undefined")return 0;
    const g=FLOOD_DEPTH[scenKey()]; if(!g)return 0;
    let cx=Math.round(x*(GW-1)), cy=Math.round(y*(GH-1));
    if(cx<0)cx=0; if(cx>=GW)cx=GW-1; if(cy<0)cy=0; if(cy>=GH)cy=GH-1;
    return (g[cy*GW+cx]||0)/100*gimul()*depthScale();
  }
  const seeds=(typeof FLOOD_SEEDS!=="undefined"&&FLOOD_SEEDS.length)?FLOOD_SEEDS:[[.5,.5,1]];
  const BLOCK=0.30, ISO=0.40, ROADWET=0.50; // roads drawn red only where water is deep (>=0.5 m)
  const _MERC=(typeof FLOOD_MERC!=="undefined")?FLOOD_MERC:null;
  function _projY(lat){return 6378137*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));}
  // depth (m) at lat/lng, sampled from the CityCAT grid in its native EPSG:3857 frame
  // so it lines up exactly with the basemap, overlay and building footprints
  function depthLL(lat,lng){
    if(typeof FLOOD_DEPTH==="undefined")return 0;
    const g=FLOOD_DEPTH[scenKey()]; if(!g)return 0;
    let nx,ny;
    if(_MERC){const mx=6378137*lng*Math.PI/180, my=_projY(lat);
      nx=(mx-_MERC[0])/(_MERC[2]-_MERC[0]); ny=(_MERC[3]-my)/(_MERC[3]-_MERC[1]);}
    else {nx=XN(lng); ny=YN(lat);}
    if(nx<0||nx>1||ny<0||ny>1)return 0;
    let cx=Math.round(nx*(GW-1)), cy=Math.round(ny*(GH-1));
    if(cx<0)cx=0; if(cx>=GW)cx=GW-1; if(cy<0)cy=0; if(cy>=GH)cy=GH-1;
    return (g[cy*GW+cx]||0)/100*gimul()*depthScale();
  }
  // deepest modeled depth within +/- rad grid cells of a point (fills the gap for
  // buildings whose centroid falls just outside a wet cell on the coarse grid)
  function depthMaxLL(lat,lng,rad){
    if(typeof FLOOD_DEPTH==="undefined")return 0;
    const g=FLOOD_DEPTH[scenKey()]; if(!g)return 0;
    let nx,ny;
    if(_MERC){const mx=6378137*lng*Math.PI/180, my=_projY(lat);
      nx=(mx-_MERC[0])/(_MERC[2]-_MERC[0]); ny=(_MERC[3]-my)/(_MERC[3]-_MERC[1]);}
    else {nx=XN(lng); ny=YN(lat);}
    if(nx<-0.02||nx>1.02||ny<-0.02||ny>1.02)return 0;
    const cx=Math.round(nx*(GW-1)), cy=Math.round(ny*(GH-1));
    let mx2=0; rad=rad||1;
    for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++){
      const x=cx+dx,y=cy+dy; if(x<0||x>=GW||y<0||y>=GH)continue;
      const v=g[y*GW+x]||0; if(v>mx2)mx2=v;
    }
    return mx2/100*gimul()*depthScale();
  }
  let roadWetCount=0;                 // impassable road stretches drawn (real count)
  function busImpactedCount(){        // MTA bus stops in >=0.10 m of modeled water
    if(!busData)return null;
    let n=0; busData.features.forEach(f=>{const c=f.geometry&&f.geometry.coordinates; if(!c)return;
      if(inBeltway(c[1],c[0])&&inFocus(c[1],c[0])&&depthLL(c[1],c[0])>=0.10)n++;});
    return n;
  }

  // ---------- analysis grid (hidden; used only for cut-off statistics) ----------
  const COLS=10, ROWS=7;
  const nodes=[];
  const nbNames=[["Druid Hill","Hampden","Charles Village","Govans","Hamilton"],
                 ["Sandtown","Bolton Hill","Waverly","Belair-Edison","Lauraville"],
                 ["Pigtown","Downtown","Oliver","Clifton","Frankford"]];
  const nbPop=[[8100,7400,9100,8800,7600],[9200,5200,7000,11200,6900],[7300,12000,8600,7800,9400]];
  function nbOf(c,r){const ci=Math.min(2,Math.floor(r/Math.ceil(ROWS/3)));const cj=Math.min(4,Math.floor(c/Math.ceil(COLS/5)));return ci*5+cj;}
  for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++){const x=c/(COLS-1),y=r/(ROWS-1);nodes.push({id:nodes.length,x,y,c,r,nb:nbOf(c,r)});}
  const idx=(c,r)=>r*COLS+c;
  const edges=[];
  for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++){if(c<COLS-1)edges.push([idx(c,r),idx(c+1,r)]);if(r<ROWS-1)edges.push([idx(c,r),idx(c,r+1)]);}
  const nbName=k=>nbNames[Math.floor(k/5)][k%5];
  const nbPopOf=k=>nbPop[Math.floor(k/5)][k%5];
  function nbAtLL(lat,lng){const c=Math.round(XN(lng)*(COLS-1)),r=Math.round(YN(lat)*(ROWS-1));return nodes[idx(c,r)].nb;}
  const CELLS={};
  const hx=1/(COLS-1)/2, hy=1/(ROWS-1)/2;
  nodes.forEach(n=>{const e=CELLS[n.nb]||(CELLS[n.nb]={x0:1,x1:0,y0:1,y1:0});
    e.x0=Math.min(e.x0,n.x);e.x1=Math.max(e.x1,n.x);e.y0=Math.min(e.y0,n.y);e.y1=Math.max(e.y1,n.y);});
  function cellRect(k){const e=CELLS[k];
    return [[LA(Math.min(1,e.y1+hy)),LO(Math.max(0,e.x0-hx))],[LA(Math.max(0,e.y0-hy)),LO(Math.min(1,e.x1+hx))]];}

  // fallback sample socio-economic values (used only if live data fails)
  const DEMO={
    income:{vals:[52000,61000,48000,55000,47000,34000,58000,42000,39000,45000,38000,72000,33000,40000,44000]},
    walk:{vals:[6,9,12,5,4,8,14,10,6,5,9,18,11,7,6]},
    bus:{vals:[28,18,22,25,20,38,24,30,27,22,33,26,36,31,25]},
    car:{vals:[58,65,58,62,68,46,54,52,59,65,50,48,45,54,61]},
    kids:{vals:[22,15,18,21,24,28,12,23,26,22,25,9,27,24,23]},
    old:{vals:[13,12,10,16,15,11,14,12,13,17,12,8,13,12,14]},
    pov:{vals:[18,12,15,14,16,32,11,24,21,17,26,14,29,22,19]}
  };
  const CHORO_COLS=["#edf8e9","#bae4b3","#74c476","#31a354","#006d2c"];
  const fmtPct=v=>(+v).toFixed(1)+"%";
  const fmtUsd=v=>"$"+Math.round(v).toLocaleString();
  const METRICS={
    income:{src:"csa",lab:"Median household income",fmt:fmtUsd,val:p=>p.mhhi17},
    kids:{src:"csa",lab:"% children (under 18)",fmt:fmtPct,val:p=>(p.age5_17||0)+(p.age18_17||0)},
    old:{src:"csa",lab:"% seniors (65+)",fmt:fmtPct,val:p=>p.age65_17},
    pov:{src:"csa",lab:"% households below poverty",fmt:fmtPct,val:p=>p.hhpov17},
    walk:{src:"tract",lab:"% who walk to work",fmt:fmtPct,val:p=>p.WL_P},
    bus:{src:"tract",lab:"% public transit to work",fmt:fmtPct,val:p=>p.PT_P},
    car:{src:"tract",lab:"% who drive to work",fmt:fmtPct,val:p=>p.CT_P}
  };
  const MDESC={
    income:"Median annual household income — half of households in this community earn less than this (BNIA Vital Signs, American Community Survey).",
    kids:"Share of residents younger than 18 (BNIA Vital Signs, ACS).",
    old:"Share of residents aged 65 and older (BNIA Vital Signs, ACS).",
    pov:"Share of households with income below the federal poverty line (BNIA Vital Signs, ACS).",
    walk:"Share of workers 16 and older who walk to work (ACS, via US DOT).",
    bus:"Share of workers 16 and older who take public transit to work (ACS, via US DOT).",
    car:"Share of workers 16 and older who drive to work (ACS, via US DOT)."};

  // ---------- infrastructure config ----------
  const ICON={
    fire:{L:"F",bg:"#ffe0d6",name:"Fire station"},
    police:{L:"P",bg:"#e9def7",name:"Police station"},
    hosp:{L:"H",bg:"#ffd6e2",name:"Hospital"},
    cool:{L:"C",bg:"#d8f3ef",name:"Cooling center"},
    nurse:{L:"N",bg:"#ffedd5",name:"Nursing home"},
    shel:{L:"Sh",bg:"#fef9c3",name:"Homeless shelter"},
    schPub:{L:"S",bg:"#dbeafe",name:"Public school"},
    schCh:{L:"S",bg:"#fde68a",name:"Charter school"},
    schInd:{L:"S",bg:"#fce7f3",name:"Independent school"},
    rail:{L:"M",bg:"#e0e7ff",name:"Metro / light rail station"}
  };
  const FALLBACK_INFRA={
    fire:[{name:"Engine 13 (sample)",lat:LA(1/6),lng:LO(2/9)},{name:"Engine 41 (sample)",lat:LA(1/6),lng:LO(8/9)}],
    police:[{name:"Central District (sample)",lat:LA(4/6),lng:LO(3/9)}],
    hosp:[{name:"Hospital (sample)",lat:LA(2/6),lng:LO(6/9)}],
    cool:[{name:"Cooling center (sample)",lat:LA(.52),lng:LO(.18)}]
  };

  const FT=0.3048;
  function bCat(d){if(d<0.1)return null;if(d<1*FT)return "minor";if(d<3*FT)return "mod";return "sev";}
  const BCOL={minor:"#f5c531",mod:"#f28c26",sev:"#d8392b"};
  const BLAB={minor:"Minor · under 1 ft",mod:"Moderate · 1–3 ft",sev:"Severe · over 3 ft"};

  function edgeBlocked(e){const a=nodes[e[0]],b=nodes[e[1]];return depthAt((a.x+b.x)/2,(a.y+b.y)/2)>BLOCK;}
  function analyze(condOverride){
    const sv=S.cond; if(condOverride)S.cond=condOverride;
    const blk=edges.map(edgeBlocked); let blocked=0; for(const x of blk) if(x) blocked++;
    const bound={},boundBlk={};
    edges.forEach((e,i)=>{const na=nodes[e[0]].nb,nb=nodes[e[1]].nb;
      if(na!==nb){bound[na]=(bound[na]||0)+1;bound[nb]=(bound[nb]||0)+1;
        if(blk[i]){boundBlk[na]=(boundBlk[na]||0)+1;boundBlk[nb]=(boundBlk[nb]||0)+1;}}});
    const nbFrac={},isoSet=new Set(),isoNbs=[]; let people=0;
    for(let k=0;k<15;k++){const b=bound[k]||0,bb=boundBlk[k]||0,f=b?bb/b:0;nbFrac[k]=f;
      if(f>=ISO){isoSet.add(k);const pop=nbPopOf(k);isoNbs.push({k,name:nbName(k),pop,f});people+=pop;}}
    S.cond=sv;
    return{blk,blocked,total:edges.length,isoSet,isoNbs,people,nbFrac};
  }

  // ---------- water raster ----------
  function lerp3(a,b,t){return [Math.round(a[0]+(b[0]-a[0])*t),Math.round(a[1]+(b[1]-a[1])*t),Math.round(a[2]+(b[2]-a[2])*t)];}
  // Water raster. Render it at the EXACT depth-grid resolution (one canvas pixel per
  // grid cell) and read FLOOD_DEPTH cell-by-cell, so the blue water lines up pixel-for-
  // pixel with how buildings / roads / facilities are classified (no blur/offset).
  // signature of everything that changes the water picture; used to cache the raster
  // so we only re-render the (expensive) grid-resolution canvas when it actually changes
  function waterSig(){
    const clip=(MODE.cur==="forecast"&&FC.lat!=null&&FC.rad>0);
    return scenKey()+"|"+(gimul()*depthScale()).toFixed(3)+"|"+
      (clip?("c"+FC.lat.toFixed(4)+","+FC.lng.toFixed(4)+","+FC.rad):"all");
  }
  let _waterCache={sig:null,url:null};
  function waterURL(){
    const sig=waterSig();
    if(_waterCache.sig===sig&&_waterCache.url)return _waterCache.url;   // reuse
    const g=(typeof FLOOD_DEPTH!=="undefined")?FLOOD_DEPTH[scenKey()]:null;
    const Wc=(g&&GW>1)?GW:460, Hc=(g&&GH>1)?GH:430;
    const cvs=document.createElement("canvas");cvs.width=Wc;cvs.height=Hc;
    const cx=cvs.getContext("2d");const img=cx.createImageData(Wc,Hc);const dt=img.data;
    const shallow=[198,219,239],mid=[66,146,198],deep=[8,48,107];
    const sc=gimul()*depthScale();   // green-infra + forecast rainfall/animation scaling
    // in forecast mode with a focus, only paint water INSIDE the focus circle so the
    // result is restricted to the selected area (not the whole Beltway)
    const clip=(MODE.cur==="forecast"&&FC.lat!=null&&FC.rad>0);
    for(let py=0;py<Hc;py++)for(let px=0;px<Wc;px++){
      const i=(py*Wc+px)*4;
      // depth for this exact cell (grid) or normalized sample (fallback)
      let d;
      if(g&&GW>1){d=(g[py*Wc+px]||0)/100*sc;}
      else{d=depthAt(px/(Wc-1),py/(Hc-1));}
      if(d<0.1){dt[i+3]=0;continue;}
      if(clip){const lat=LA(py/(Hc-1)), lng=LO(px/(Wc-1)); if(!inFocus(lat,lng)){dt[i+3]=0;continue;}}
      const t=Math.min(1,(d-0.1)/1.9);const tp=Math.pow(t,0.85);
      const c=tp<0.5?lerp3(shallow,mid,tp/0.5):lerp3(mid,deep,(tp-0.5)/0.5);
      // stronger minimum opacity so shallow (just-flooded) cells are clearly visible,
      // matching what buildings/facilities are classified on
      dt[i]=c[0];dt[i+1]=c[1];dt[i+2]=c[2];dt[i+3]=Math.round(255*(0.62+0.33*t));
    }
    cx.putImageData(img,0,0);
    const url=cvs.toDataURL();
    _waterCache={sig,url};
    return url;
  }

  // ---------- map + panes ----------
  const map=L.map("map",{preferCanvas:true}).setView([(latTop+latBot)/2,(lngL+lngR)/2],11);
  // FEMA sits above the modeled floodwater so it stays visible
  ["landcover","soil","flood","fema","streamgrid","streams","road","bldg","choro","bnd"].forEach((p,i)=>{map.createPane(p).style.zIndex=318+i*7;});
  // mask pane hides everything OUTSIDE the Beltway polygon (clips rasters + vectors to the study area)
  map.createPane("mask").style.zIndex=585;
  map.getPane("mask").style.pointerEvents="none";
  // interactive boundary pane sits above the mask so neighborhoods/subwatersheds stay hoverable
  map.createPane("bndtop").style.zIndex=590;
  map.createPane("labels").style.zIndex=616;
  map.getPane("labels").style.pointerEvents="none";


  // Streets basemap (Esri, no API key): muted Light Gray up to z16 (its deepest native
  // level); from z17+ swap to Esri World Street Map, which has CRISP native tiles to z19
  // so street names stay sharp instead of upscaling a blurry gray tile.
  const baseStreets=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",{maxZoom:16,maxNativeZoom:16,attribution:"Esri, HERE, Garmin, © OpenStreetMap contributors"});
  const labelsLo=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",{maxZoom:16,maxNativeZoom:16,pane:"labels"});
  const streetsDetail=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",{minZoom:17,maxZoom:19,maxNativeZoom:19,attribution:"Esri, HERE, Garmin, © OpenStreetMap contributors"});
  const baseSat=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,attribution:"Esri, Maxar, Earthstar Geographics"});
  const satLabels=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,pane:"labels"});
  function addStreets(){baseStreets.addTo(map);labelsLo.addTo(map);streetsDetail.addTo(map);}
  addStreets();
  map.zoomControl.setPosition("bottomleft");
  function setBasemap(k){
    [baseStreets,labelsLo,streetsDetail,baseSat,satLabels].forEach(l=>{if(map.hasLayer(l))map.removeLayer(l);});
    if(k==="sat"){baseSat.addTo(map);satLabels.addTo(map);}
    else addStreets();
  }
  // show the loading spinner while basemap tiles are fetching
  [baseStreets,streetsDetail,labelsLo,baseSat].forEach(l=>{
    l.on("loading",()=>busy(true)); l.on("load",()=>busy(false));
  });

  // transient toast (bottom-center) — used to tell the user when a layer has nothing
  // inside the selected forecast area
  let _toastT=null;
  function toast(msg){
    let el=document.getElementById("fcToast");
    if(!el){el=document.createElement("div");el.id="fcToast";
      el.style.cssText="position:absolute;left:50%;bottom:24px;transform:translateX(-50%);"+
        "z-index:800;background:rgba(15,61,92,.95);color:#fff;padding:8px 14px;border-radius:8px;"+
        "font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:80%;text-align:center;pointer-events:none";
      (document.querySelector(".mapcol")||document.body).appendChild(el);}
    el.textContent=msg; el.style.display="block";
    if(_toastT)clearTimeout(_toastT);
    _toastT=setTimeout(()=>{el.style.display="none";},3200);
  }

  const bounds=[[latBot,lngL],[latTop,lngR]];
  // Design mode uses the crisp pre-rendered PNG for the scenario. Forecast mode draws the
  // water from the depth grid on the fly so it reflects the rainfall scaling AND the
  // build-up animation (the static PNG can't show a partial / scaled water level).
  const floodImgUrl=()=>(MODE.cur!=="forecast"&&typeof FLOOD_IMG!=="undefined"&&FLOOD_IMG[scenKey()])?FLOOD_IMG[scenKey()]:waterURL();
  let floodOverlay=L.imageOverlay(floodImgUrl(),bounds,{opacity:1,interactive:false,pane:"flood"});
  const rBldg=L.canvas({pane:"bldg"});
  const rRoad=L.canvas({pane:"road"});
  const roadLayer=L.layerGroup().addTo(map), areaLayer=L.layerGroup().addTo(map),
        stnLayer=L.layerGroup(), busLayer=L.layerGroup(), bldgLayer=L.layerGroup().addTo(map),
        nbLayer=L.layerGroup().addTo(map), wsLayer=L.layerGroup().addTo(map),
        choroLayer=L.layerGroup().addTo(map),
        fl311Layer=L.layerGroup(), wb311Layer=L.layerGroup();
  // faint study-area boundary (Baltimore Beltway main watershed)
  L.geoJSON(BELTWAY,{pane:"bnd",interactive:false,style:{color:"#5d6b78",weight:1.6,opacity:.5,fill:false}}).addTo(map);
  const beltwayBounds=L.geoJSON(BELTWAY).getBounds().pad(0.02);

  // ---- FORECAST FOCUS spotlight: a dimming overlay with a hole over the chosen circle,
  // plus a dashed focus ring, so the forecast result visually focuses on the picked area ----
  const focusLayer=L.layerGroup();      // ring + label
  let focusMask=null;                   // dim ring-with-hole polygon
  function clearFocusView(){
    focusLayer.clearLayers();
    if(focusMask){map.removeLayer(focusMask);focusMask=null;}
  }
  function drawFocusView(){
    clearFocusView();
    if(MODE.cur!=="forecast"||FC.lat==null||!(FC.rad>0))return;   // whole-Beltway = no spotlight
    const radM=FC.rad*1609.34;
    // dim everything, punch a circular hole over the focus (world rectangle + circle hole)
    const world=[[-85,-200],[-85,200],[85,200],[85,-200]];
    const hole=[]; const N=72;
    for(let i=0;i<=N;i++){const a=2*Math.PI*i/N;
      const dLat=(radM/111320)*Math.cos(a);
      const dLng=(radM/(111320*Math.cos(FC.lat*Math.PI/180)))*Math.sin(a);
      hole.push([FC.lat+dLat,FC.lng+dLng]);}
    focusMask=L.polygon([world,hole],{pane:"mask",stroke:false,fillColor:"#0b1f2e",
      fillOpacity:0.45,interactive:false,fillRule:"evenodd"}).addTo(map);
    L.circle([FC.lat,FC.lng],{radius:radM,pane:"bndtop",color:"#1c6ea4",weight:2,
      dashArray:"6 5",fill:false,interactive:false}).addTo(focusLayer);
    if(!map.hasLayer(focusLayer))focusLayer.addTo(map);
  }
  // true polygon clip: keep every point dataset inside the Beltway boundary shapefile
  const BELTWAY_GEOM=BELTWAY.features[0].geometry;
  function inBeltway(lat,lng){return pipGeom(BELTWAY_GEOM,lat,lng);}
  // ---- MASK: cover everything OUTSIDE the Beltway polygon so rasters (buildings,
  // roads, flood, FEMA) that the server draws to a rectangle are visually clipped
  // to the actual boundary. Outer ring = whole world, inner ring = Beltway (a hole).
  const WORLD_RING=[[-179,-85],[179,-85],[179,85],[-179,85],[-179,-85]];
  function beltwayOuterRing(){ // largest ring of the Beltway polygon in [lng,lat]
    const g=BELTWAY_GEOM;
    const polys=g.type==="MultiPolygon"?g.coordinates:[g.coordinates];
    let best=null,bestA=0;
    polys.forEach(p=>{const a=Math.abs(ringArea(p[0]));if(a>bestA){bestA=a;best=p[0];}});
    return best;}
  let maskLayer=null;
  function buildMask(){
    if(maskLayer)return;
    const belt=beltwayOuterRing();if(!belt)return;
    // GeoJSON polygon: [worldRing (outer), beltRing (hole)]
    const maskGeo={type:"Feature",properties:{},geometry:{type:"Polygon",
      coordinates:[WORLD_RING, belt.map(pt=>[pt[0],pt[1]])]}};
    maskLayer=L.geoJSON(maskGeo,{pane:"mask",interactive:false,
      style:{stroke:false,fillColor:"#eef2f6",fillOpacity:1,fillRule:"evenodd"}}).addTo(map);
  }

  // ---- TRUE POLYGON CLIP -------------------------------------------------
  // Server-drawn rasters (buildings, roads, FEMA, flood) and the canvas vector
  // layers are rendered to a rectangular bbox. To make the tool respect the
  // irregular Beltway boundary we apply an SVG clipPath (in Leaflet layer-point
  // space) to each data pane. Pane content is positioned in layer-point coords,
  // so a clipPath built from map.latLngToLayerPoint(...) lines up exactly and
  // only needs recomputing when the pixel origin moves (zoom / pan).
  const CLIP_PANES=["landcover","soil","flood","fema","streamgrid","streams","road","bldg","choro"];
  let clipPathEl=null;
  function buildClip(){
    const NS="http://www.w3.org/2000/svg";
    const svg=document.createElementNS(NS,"svg");
    svg.setAttribute("width","0");svg.setAttribute("height","0");
    svg.style.position="absolute";svg.style.pointerEvents="none";
    const defs=document.createElementNS(NS,"defs");
    const cp=document.createElementNS(NS,"clipPath");
    cp.setAttribute("id","beltwayClip");
    cp.setAttribute("clipPathUnits","userSpaceOnUse");
    clipPathEl=document.createElementNS(NS,"path");
    cp.appendChild(clipPathEl);defs.appendChild(cp);svg.appendChild(defs);
    document.body.appendChild(svg);
    CLIP_PANES.forEach(p=>{const el=map.getPane(p);
      if(el){el.style.clipPath="url(#beltwayClip)";el.style.webkitClipPath="url(#beltwayClip)";}});
    updateClip();
    map.on("zoomend viewreset moveend zoom move",updateClip);
  }
  function ringToPath(ring){
    let d="";
    for(let i=0;i<ring.length;i++){
      const p=map.latLngToLayerPoint([ring[i][1],ring[i][0]]);
      d+=(i?"L":"M")+Math.round(p.x)+" "+Math.round(p.y);
    }
    return d+"Z";
  }
  function updateClip(){
    if(!clipPathEl)return;
    const g=BELTWAY_GEOM;
    const polys=g.type==="MultiPolygon"?g.coordinates:[g.coordinates];
    let d="";
    polys.forEach(poly=>{if(poly[0]&&poly[0].length>2)d+=ringToPath(poly[0]);});
    clipPathEl.setAttribute("d",d);
  }


  const show={flood:true,reports:false,social:false,mycoast:false,cameras:false,weather:false,usgs:false,noaa:false,claims:false,hist:false,news:false,closures:false,fema:false,roads:false,areas:false,bldg:true,nb:false,ws:false,streams:false,streamGrid:false,landcover:false,soil:false,infra:false,fl311:false,wb311:false};
  const inf={fire:false,police:false,hosp:false,cool:false,nurse:false,shel:false,schPub:false,schCh:false,schInd:false,rail:false,bus:false};
  let choroMetric="none";
  let facShowAll=false;  // Emergency facility panel: show all vs flooded-only
  let lastA=null;
  // small loading spinner shown while an async layer is fetching
  function busy(on){const el=document.getElementById("spin");if(!el)return;
    el._n=Math.max(0,(el._n||0)+(on?1:-1));el.style.display=el._n>0?"flex":"none";}

  // ---------- live data URLs ----------
  const LIVE={nb:null,ws:null,csa:null,tract:null,fema:null,infra:null,fl311:null,wb311:null};
  const ENV=[lngL,latBot,lngR,latTop].join(",");
  const WENV="-76.95,39.05,-76.30,39.50"; // wider extent: whole watersheds around the city
  const NB_URL="https://egisdata.baltimorecity.gov/egis/rest/services/CityView/Neighborhoods/FeatureServer/0/query?where=1%3D1&outFields=Name,Population&outSR=4326&f=geojson";
  // County Census Designated Places + incorporated places (all counties in the study
  // area) so the Boundaries layer covers the whole Beltway, not just Baltimore City.
  const PLACES_ENV="-76.85,39.13,-76.25,39.54";
  const PLACES_URLS=[
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/5/query?where=STATE%3D%2724%27&geometry="+PLACES_ENV+"&geometryType=esriGeometryEnvelope&inSR=4326&outFields=NAME&outSR=4326&geometryPrecision=5&f=geojson",
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query?where=STATE%3D%2724%27&geometry="+PLACES_ENV+"&geometryType=esriGeometryEnvelope&inSR=4326&outFields=NAME&outSR=4326&geometryPrecision=5&f=geojson"
  ];
  const CSA_URL="https://services1.arcgis.com/UWYHeuuJISiGmgXx/arcgis/rest/services/CSA_Census_Demographics_BNIA_2017/FeatureServer/0/query?where=1%3D1&outFields=CSA2010,tpop10,mhhi17,age5_17,age18_17,age65_17,hhpov17&geometryPrecision=5&outSR=4326&f=geojson";
  // whole study area: Baltimore City (510) + Baltimore County (005) + Anne Arundel (003) + Howard (027) + Carroll (013)
  const TRACT_URL="https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Means_of_Transportation_to_Work/FeatureServer/0/query?where=STATEFP%3D%2724%27+AND+COUNTYFP+IN+(%27510%27%2C%27005%27%2C%27003%27%2C%27027%27%2C%27013%27)&outFields=GEOID,CT_P,PT_P,WL_P&geometryPrecision=5&outSR=4326&resultRecordCount=4000&f=geojson";
  const PS="https://egisdata.baltimorecity.gov/egis/rest/services/CityView/";
  const ST=p=>"https://mdgeodata.md.gov/imap/rest/services/"+p+"/query?where=1%3D1&geometry="+WENV+
    "&geometryType=esriGeometryEnvelope&inSR=4326&outFields=*&outSR=4326&f=geojson"; // statewide MD iMAP, beltway envelope
  const INFRA_URLS={
    police:[PS+"Public_Safety/MapServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
            ST("PublicSafety/MD_Police/MapServer/0"),ST("PublicSafety/MD_Police/MapServer/1"),ST("PublicSafety/MD_Police/MapServer/2")],
    fire:[PS+"Public_Safety/MapServer/1/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
          ST("PublicSafety/MD_Fire/MapServer/0"),ST("PublicSafety/MD_Fire/MapServer/1"),ST("PublicSafety/MD_Fire/MapServer/2")],
    cool:[PS+"Public_Safety/MapServer/3/query?where=1%3D1&outFields=*&outSR=4326&f=geojson"],
    hosp:[PS+"Hospital/MapServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
          ST("Health/MD_Hospitals/MapServer/0")],
    nurse:[PS+"Nursing_Homes/MapServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
           ST("Health/MD_LongTermCareAssistedLiving/MapServer/0"),ST("Health/MD_LongTermCareAssistedLiving/MapServer/1")],
    schPub:[PS+"Public_Schools/MapServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
            ST("Education/MD_EducationFacilities/MapServer/0")],
    schInd:[PS+"Private_Schools/MapServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
            ST("Education/MD_EducationFacilities/MapServer/1")],
    shel:["https://services1.arcgis.com/UWYHeuuJISiGmgXx/arcgis/rest/services/Homeless_Shelters/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=1000&f=geojson"],
    rail:["https://mdgeodata.md.gov/imap/rest/services/Transportation/MD_Transit/MapServer/4/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
          "https://mdgeodata.md.gov/imap/rest/services/Transportation/MD_Transit/MapServer/2/query?where=1%3D1&outFields=*&outSR=4326&f=geojson"]
  };
  const B311Y="https://services1.arcgis.com/UWYHeuuJISiGmgXx/arcgis/rest/services/311_Customer_Service_Requests_Yearly/FeatureServer/";
  const B311X="https://services1.arcgis.com/UWYHeuuJISiGmgXx/arcgis/rest/services/";
  const SRC311=[];
  for(let lay=0;lay<=12;lay++)SRC311.push({base:B311Y+lay+"/query?",yr:2022-lay}); // 2010-2022
  [["311_Customer_Service_Requests_2023",2023],["311_Customer_Service_Requests_2024",2024],
   ["311_Customer_Service_Requests_2024_0_(For_sprint_map)",2024],["311_Customer_Service_Requests_2025",2025]]
    .forEach(s=>SRC311.push({base:B311X+encodeURIComponent(s[0])+"/FeatureServer/0/query?",yr:s[1]}));
  const W311={fl311:"where=SRType%3D%27WW-Storm+Flooded+Street%27",wb311:"where=SRType+LIKE+%27%25Water+In+Basement%25%27"};
  function url311(src,kind){return src.base+W311[kind]+"&outFields=SRType,Address&resultRecordCount=2000&f=geojson";}
  const RD="https://mdgeodata.md.gov/imap/rest/services/Transportation/MD_RoadCenterlines/MapServer/";
  function roadUrl(layer,env,limit){
    return RD+layer+"/query?geometry="+env+"&geometryType=esriGeometryEnvelope&inSR=4326&outFields=*&outSR=4326&geometryPrecision=6&resultRecordCount="+limit+"&f=geojson";}
  const BLDG_BASE="https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_BuildingFootprints/MapServer/0/query?";
  function bldgUrl(w,s,e,n,limit){
    return BLDG_BASE+"geometry="+[w,s,e,n].map(v=>(+v).toFixed(5)).join(",")+
      "&geometryType=esriGeometryEnvelope&inSR=4326&outFields=OBJECTID&outSR=4326&geometryPrecision=6&resultRecordCount="+limit+"&f=geojson";}
  const BUS_BASE="https://mdgeodata.md.gov/imap/rest/services/Transportation/MD_Transit/MapServer/9/query?";

  async function fetchGeo(url){
    try{
      let r=await fetch(url).then(x=>x.json());
      if(r&&r.features&&r.features.length&&r.features[0].geometry&&r.features[0].geometry.coordinates)return r;
      if(r&&r.features&&!r.features.length)return {type:"FeatureCollection",features:[]};
      const conv=j=>{
        if(!(j&&j.features&&j.features.length))return null;
        const g0=j.features[0].geometry||{};
        if(g0.rings)return {type:"FeatureCollection",features:j.features.map(f=>({type:"Feature",properties:f.attributes,geometry:{type:"Polygon",coordinates:f.geometry.rings}}))};
        if(g0.paths)return {type:"FeatureCollection",features:j.features.map(f=>({type:"Feature",properties:f.attributes,geometry:{type:"MultiLineString",coordinates:f.geometry.paths}}))};
        if("x" in g0)return {type:"FeatureCollection",features:j.features.map(f=>({type:"Feature",properties:f.attributes,geometry:{type:"Point",coordinates:[f.geometry.x,f.geometry.y]}}))};
        return null;};
      let c=conv(r);if(c)return c;
      r=await fetch(url.replace("f=geojson","f=json")).then(x=>x.json());
      c=conv(r);if(c)return c;
    }catch(e){}
    return null;}
  function firstName(p){
    if(!p)return "";
    for(const k of ["NAME","Name","name","stop_name","STOP_NAME","SCHOOLNAME","SCHOOL_NAME","FACILITY","Facility","LABEL"])
      if(typeof p[k]==="string"&&p[k].trim())return p[k].trim();
    for(const k in p)if(/name/i.test(k)&&typeof p[k]==="string"&&p[k].trim())return p[k].trim();
    return "";}
  function pts(g){
    return g.features.filter(f=>f.geometry&&f.geometry.type==="Point").map(f=>{
      const p=f.properties||{};
      return {name:firstName(p),addr:p.ADDRESS||p.Address||p.address||"",props:p,
              lat:f.geometry.coordinates[1],lng:f.geometry.coordinates[0]};});}

  function infNote(msg){const el=document.getElementById("infNote");if(el)el.textContent=msg||"";}
  // Merge county Census places into the neighborhoods layer for whole-Beltway coverage.
  let placesLoaded=false;
  function mergePlaces(){
    if(placesLoaded)return;placesLoaded=true;
    Promise.all(PLACES_URLS.map(u=>fetchGeo(u))).then(gs=>{
      const feats=[];
      gs.forEach(g=>{if(g&&g.features)g.features.forEach(f=>{
        const p=f.properties||{};const nm=p.NAME||p.Name||p.name;
        if(!nm||!f.geometry)return;
        if(/^baltimore(\s+city)?$/i.test(nm.trim()))return; // keep city neighborhoods, not the whole-city polygon
        feats.push({type:"Feature",properties:{Name:nm,_place:true},geometry:f.geometry});});});
      if(!feats.length)return;
      if(!LIVE.nb)LIVE.nb={type:"FeatureCollection",features:[]};
      // keep city neighborhoods first (more specific); append county places after
      const have={};LIVE.nb.features.forEach(f=>{if(f.properties&&f.properties.Name)have[f.properties.Name.toLowerCase()]=1;});
      feats.forEach(f=>{const k=f.properties.Name.toLowerCase();if(!have[k]){have[k]=1;LIVE.nb.features.push(f);}});
      if(show.nb)drawBoundaries();
    });
  }
  function loadLive(){
    fetchGeo(NB_URL).then(g=>{if(g){LIVE.nb=g;mergePlaces();drawBoundaries();}});
    fetchGeo(CSA_URL).then(g=>{if(g){LIVE.csa=g;drawChoro();}});
    fetchGeo(TRACT_URL).then(g=>{if(g){LIVE.tract=g;drawChoro();}});
    const infra={},failed=[];
    Promise.all(Object.keys(INFRA_URLS).map(k=>
      Promise.all(INFRA_URLS[k].map(u=>fetchGeo(u))).then(gs=>{
        let all=[];gs.forEach(g=>{if(g)all=all.concat(pts(g));});
        if(all.length)infra[k]=all;else failed.push(k);})
    )).then(()=>{
      Object.keys(infra).forEach(k=>{const seen={},uniq=[];
        infra[k].forEach(p2=>{const key=p2.lat.toFixed(4)+","+p2.lng.toFixed(4);
          if(seen[key])return;seen[key]=1;uniq.push(p2);});
        infra[k]=uniq;});
      // split charter schools out of the public-school dataset when flagged
      if(infra.schPub){
        const ch=[],pub=[];
        infra.schPub.forEach(s=>{(/charter/i.test(JSON.stringify(s.props||{}))?ch:pub).push(s);});
        if(ch.length){infra.schCh=ch;infra.schPub=pub;}
        else if(!failed.includes("schCh"))failed.push("schCh (no charter flag in city dataset)");
      }
      if(Object.keys(infra).length){LIVE.infra=infra;refresh();}
      infNote(failed.length?("No live data for: "+failed.join(", ")+"."):"");
    });
  }

  // ---------- point-in-polygon + place naming ----------
  function pipRing(r,lng,lat){let c=false;
    for(let i=0,j=r.length-1;i<r.length;j=i++){
      const xi=r[i][0],yi=r[i][1],xj=r[j][0],yj=r[j][1];
      if(((yi>lat)!==(yj>lat))&&(lng<(xj-xi)*(lat-yi)/(yj-yi)+xi))c=!c;}
    return c;}
  function pipGeom(g,lat,lng){
    if(!g)return false;
    const polys=g.type==="MultiPolygon"?g.coordinates:(g.type==="Polygon"?[g.coordinates]:[]);
    for(const p of polys){
      if(pipRing(p[0],lng,lat)){let hole=false;
        for(let h=1;h<p.length;h++)if(pipRing(p[h],lng,lat)){hole=true;break;}
        if(!hole)return true;}}
    return false;}
  function nbNameAt(lat,lng){
    if(!LIVE.nb)return null;
    for(const f of LIVE.nb.features)if(pipGeom(f.geometry,lat,lng))return (f.properties&&f.properties.Name)||null;
    return null;}
  function facLabel(s){ // "Loch Raven"-style place name for a facility
    if(s._lbl)return s._lbl;
    const nb=nbNameAt(s.lat,s.lng);
    const v=nb||s.addr||s.name||"";
    if(nb||!LIVE.nb)s._lbl=v; // only cache once neighborhoods are loaded (or point is outside them)
    return v;}
  // some datasets label every police record "Headquarters" (or similar generic text)
  // instead of the actual station/place — treat those as no real name
  function isGenericName(n){return !n||/^\s*(head\s*quarters?|hq|police(\s+department)?|station|main|central office|office)\s*$/i.test(n);}
  // police district names ("Northern","Southwestern","Central", etc.) — we want the
  // actual place/location, not the district, so detect these and replace with the place
  function isPoliceDistrict(n){return !n||/district|precinct|division|northern|southern|eastern|western|northwest|northeast|southwest|southeast|central|headquarters|hq/i.test(n);}
  // the larger place/city that contains a point: a county CDP / incorporated place
  // if the point falls in one, otherwise Baltimore City (the study area minus the
  // county places). Used to disambiguate generic names like "Downtown".
  function parentPlaceAt(lat,lng){
    if(LIVE.nb)for(const f of LIVE.nb.features){const p=f.properties||{};
      if(p._place&&pipGeom(f.geometry,lat,lng))return p.Name;}
    return inBeltway(lat,lng)?"Baltimore City":null;
  }
  // "Neighborhood, City" label so facilities in different downtowns are distinct
  function facPlaceLabel(s){
    const nb=nbNameAt(s.lat,s.lng);
    const city=parentPlaceAt(s.lat,s.lng);
    let base=nb||s.addr||"";
    if(nb&&city&&city.toLowerCase()!==nb.toLowerCase())base=nb+", "+city;
    return base;
  }
  function facTitle(t,s){
    if(t==="fire")return ICON[t].name+(facPlaceLabel(s)?" — "+facPlaceLabel(s):"");
    if(t==="police"){
      const place=facPlaceLabel(s);
      if(place)return place+" Police Station";
      if(s.name&&!isPoliceDistrict(s.name))return s.name;
      return ICON[t].name;
    }
    return s.name||ICON[t].name;
  }

  // ---------- subwatershed population (2020 Census via TIGERweb) ----------
  let wsPopState=0; // 0=idle 1=loading 2=done 3=failed
  const wsPopWaiters=[];
  function loadWsPop(){
    if(wsPopState)return;wsPopState=1;
    (async()=>{
      let rows=null;
      const bases=["https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/",
                   "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/"];
      outer:
      for(const base of bases)for(let lay=0;lay<=14;lay++){
        try{
          const u=base+lay+"/query?where=1%3D1&geometry="+WENV+"&geometryType=esriGeometryEnvelope&inSR=4326"+
            "&outFields=POP100,CENTLAT,CENTLON&returnGeometry=false&resultRecordCount=3500&f=json";
          const r=await fetch(u).then(x=>x.json());
          if(r&&r.features&&r.features.length>50&&r.features[0].attributes&&
             r.features[0].attributes.POP100!=null&&r.features[0].attributes.CENTLAT!=null){
            rows=r.features.map(f=>({p:+f.attributes.POP100||0,lat:+f.attributes.CENTLAT,lng:+f.attributes.CENTLON}));
            break outer;}
        }catch(e){}
      }
      if(rows){
        SUBWS.features.forEach(f=>{let t=0;
          for(const b of rows)if(pipGeom(f.geometry,b.lat,b.lng))t+=b.p;
          f.properties._pop=t;});
        wsPopState=2;
      }else wsPopState=3;
      wsPopWaiters.splice(0).forEach(fn=>{try{fn();}catch(e){}});
    })();
  }

  // ---------- land cover stats (Chesapeake Conservancy 1 m, via MD iMAP) ----------
  const LC_EXPORT="https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_HighResolutionLandCover/MapServer/export";
  const LC_CLASSES=[ // exact palette from the service legend
    {k:(0<<16)+(197<<8)+255,n:"Water"},
    {k:(0<<16)+(168<<8)+132,n:"Wetlands"},
    {k:(38<<16)+(115<<8)+0,n:"Tree canopy",t:1},
    {k:(76<<16)+(230<<8)+0,n:"Shrub / scrub"},
    {k:(163<<16)+(255<<8)+115,n:"Low vegetation (lawns, fields)"},
    {k:(255<<16)+(170<<8)+0,n:"Barren land"},
    {k:(255<<16)+(0<<8)+0,n:"Buildings"},
    {k:(156<<16)+(156<<8)+156,n:"Other paved surfaces"},
    {k:0,n:"Roads"},
    {k:(115<<16)+(115<<8)+0,n:"Tree canopy",t:1},
    {k:(230<<16)+(230<<8)+0,n:"Tree canopy",t:1},
    {k:(255<<16)+(255<<8)+115,n:"Tree canopy",t:1}];
  const LC_MAP={};LC_CLASSES.forEach(c=>LC_MAP[c.k]=c);
  function lcStats(f,cb){
    const p=f.properties||(f.properties={});
    if(p._lc){cb&&cb(p._lc);return;}
    if(p._lcBusy)return; p._lcBusy=1;
    try{
      const rings=[];
      (f.geometry.type==="MultiPolygon"?f.geometry.coordinates:[f.geometry.coordinates]).forEach(poly=>
        poly.forEach(r=>rings.push(r.map(pt=>{const m=L.CRS.EPSG3857.project(L.latLng(pt[1],pt[0]));return [m.x,m.y];}))));
      let x0=1/0,y0=1/0,x1=-1/0,y1=-1/0;
      rings.forEach(r=>r.forEach(pt=>{x0=Math.min(x0,pt[0]);y0=Math.min(y0,pt[1]);x1=Math.max(x1,pt[0]);y1=Math.max(y1,pt[1]);}));
      const W=Math.min(640,Math.max(180,Math.round((x1-x0)/12))),H=Math.max(120,Math.round(W*(y1-y0)/(x1-x0)));
      const img=new Image();img.crossOrigin="anonymous";
      img.onload=()=>{
        try{
          const cv=document.createElement("canvas");cv.width=W;cv.height=H;
          const cx=cv.getContext("2d",{willReadFrequently:true});
          cx.drawImage(img,0,0,W,H);
          const dat=cx.getImageData(0,0,W,H).data;
          // polygon mask on a second canvas
          const mc=document.createElement("canvas");mc.width=W;mc.height=H;
          const mx=mc.getContext("2d",{willReadFrequently:true});
          mx.fillStyle="#fff";mx.beginPath();
          rings.forEach(r=>{r.forEach((pt,i)=>{const px=(pt[0]-x0)/(x1-x0)*W,py=(y1-pt[1])/(y1-y0)*H;
            i?mx.lineTo(px,py):mx.moveTo(px,py);});mx.closePath();});
          mx.fill("evenodd");
          const msk=mx.getImageData(0,0,W,H).data;
          const tal={};let tot=0;
          for(let i=0;i<dat.length;i+=4){
            if(msk[i+3]<128||dat[i+3]<128)continue;
            const c=LC_MAP[(dat[i]<<16)+(dat[i+1]<<8)+dat[i+2]];
            if(!c)continue;
            tal[c.n]=(tal[c.n]||0)+1;tot++;}
          if(tot<50){p._lc={err:1};p._lcBusy=0;cb&&cb(p._lc);return;}
          const tree=(tal["Tree canopy"]||0)/tot*100;
          const imperv=((tal["Buildings"]||0)+(tal["Other paved surfaces"]||0)+(tal["Roads"]||0))/tot*100;
          p._lc={tree,imperv,tot};
          cb&&cb(p._lc);
        }catch(e){p._lc={err:1};cb&&cb(p._lc);}
      };
      img.onerror=()=>{p._lc={err:1};p._lcBusy=0;cb&&cb(p._lc);};
      img.src=LC_EXPORT+"?bbox="+[x0,y0,x1,y1].join(",")+"&bboxSR=3857&imageSR=3857&size="+W+","+H+"&format=png32&transparent=true&f=image";
    }catch(e){p._lc={err:1};cb&&cb(p._lc);}
  }
  function lcBlock(f){
    const lc=f.properties&&f.properties._lc;
    const cap='<div style="font-size:10.5px;color:#5d6b78;margin-top:4px">Land cover: Chesapeake Conservancy 1 m (2013–14), via MD iMAP</div>';
    if(!lc)return '<br><i>Computing land cover…</i>'+cap;
    if(lc.err)return '<br><i>Land cover unavailable (needs internet).</i>';
    return '<br>Tree cover: <b>'+lc.tree.toFixed(1)+'%</b>'+
      '<br>Impervious (roads, roofs, paving): <b>'+lc.imperv.toFixed(1)+'%</b>'+cap;
  }
  // ---------- soil hydrologic group (USDA NRCS SSURGO, via Soil Data Access) ----------
  const HSG_LAB={A:"A — sandy, drains fast (low runoff)",B:"B — loamy (moderate runoff)",
                 C:"C — clay loam (high runoff)",D:"D — clay / impervious (very high runoff)"};
  function ringWKT(geom){
    const polys=geom.type==="MultiPolygon"?geom.coordinates:(geom.type==="Polygon"?[geom.coordinates]:[]);
    let best=null,bestA=0;
    polys.forEach(p=>{const a=Math.abs(ringArea(p[0]));if(a>bestA){bestA=a;best=p[0];}});
    if(!best)return null;
    let r=best;
    if(r.length>80){const step=Math.ceil(r.length/80);r=best.filter((_,i)=>i%step===0);
      if(r[0][0]!==r[r.length-1][0]||r[0][1]!==r[r.length-1][1])r.push(best[0]);}
    return "POLYGON(("+r.map(pt=>pt[0].toFixed(5)+" "+pt[1].toFixed(5)).join(",")+"))";
  }
  function hsgStats(f,cb){
    const p=f.properties||(f.properties={});
    if(p._hsg){cb&&cb();return;}
    if(p._hsgBusy)return;p._hsgBusy=1;
    const wkt=ringWKT(f.geometry);
    if(!wkt){p._hsg={err:1};cb&&cb();return;}
    const q="SELECT hydgrp, SUM(comppct_r) AS pct FROM component WHERE mukey IN "+
            "(SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('"+wkt+"')) "+
            "AND hydgrp IS NOT NULL GROUP BY hydgrp ORDER BY pct DESC";
    fetch("https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest",
      {method:"POST",headers:{"Content-Type":"application/json"},
       body:JSON.stringify({format:"JSON+COLUMNNAME",query:q})})
      .then(r=>r.json()).then(j=>{
        const t=j&&j.Table;
        if(!t||t.length<2){p._hsg={err:1};cb&&cb();return;}
        const rows=t.slice(1).map(x=>({g:String(x[0]).charAt(0),pct:+x[1]})).filter(x=>HSG_LAB[x.g]);
        const tot=rows.reduce((a,b)=>a+b.pct,0)||1;
        rows.forEach(x=>x.share=x.pct/tot*100);
        if(!rows.length){p._hsg={err:1};} else {p._hsg={rows,dom:rows[0].g};}
        cb&&cb();
      }).catch(()=>{p._hsg={err:1};cb&&cb();});
  }
  function hsgBlock(f){
    const h=f.properties&&f.properties._hsg;
    const cap='<div style="font-size:10.5px;color:#5d6b78;margin-top:2px">Soil hydrologic group: USDA NRCS SSURGO</div>';
    if(!h)return '<br><i>Loading soil group…</i>';
    if(h.err)return '<br><i>Soil group unavailable (needs internet).</i>';
    const parts=h.rows.filter(x=>x.share>=5).map(x=>x.g+" "+x.share.toFixed(0)+"%").join(", ");
    return '<br>Dominant soil group: <b>'+(HSG_LAB[h.dom]||h.dom)+'</b>'+
      (parts?'<br>Soil mix: '+parts:'')+cap;
  }
  function liveTip(l,fn){ // refresh an open tooltip/popup once async stats land
    return ()=>{const c=fn();
      if(l.isTooltipOpen&&l.isTooltipOpen())l.setTooltipContent(c);
      if(l.isPopupOpen&&l.isPopupOpen())l.setPopupContent(c);};}

  // ---------- boundaries ----------
  function ringArea(r){let a=0;for(let i=0;i<r.length-1;i++){a+=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1];}return a/2;}
  function ringCentroid(r){let a=0,cx=0,cy=0;
    for(let i=0;i<r.length-1;i++){const f=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1];a+=f;cx+=(r[i][0]+r[i+1][0])*f;cy+=(r[i][1]+r[i+1][1])*f;}
    if(Math.abs(a)<1e-12)return [r[0][1],r[0][0]];
    return [cy/(3*a),cx/(3*a)];}
  function bestCentroid(geom){
    const polys=geom.type==="MultiPolygon"?geom.coordinates:[geom.coordinates];
    let best=null,bestA=0;
    polys.forEach(p=>{const a=Math.abs(ringArea(p[0]));if(a>bestA){bestA=a;best=p[0];}});
    return best?ringCentroid(best):null;}
  // ---------- per-area flood-impact stats (for a selected neighborhood/subwatershed) ----------
  function _projYm(lat){return 6378137*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));}
  function _llToCell(lat,lng){
    if(!_MERC)return null;
    const mx=6378137*lng*Math.PI/180, my=_projYm(lat);
    const nx=(mx-_MERC[0])/(_MERC[2]-_MERC[0]), ny=(_MERC[3]-my)/(_MERC[3]-_MERC[1]);
    return [Math.round(nx*(GW-1)),Math.round(ny*(GH-1))];
  }
  function _cellToLL(cx,cy){
    const nx=cx/(GW-1), ny=cy/(GH-1);
    const mx=_MERC[0]+nx*(_MERC[2]-_MERC[0]), my=_MERC[3]-ny*(_MERC[3]-_MERC[1]);
    const lng=mx/6378137*180/Math.PI, lat=(2*Math.atan(Math.exp(my/6378137))-Math.PI/2)*180/Math.PI;
    return [lat,lng];
  }
  // % of an area's land that is under >=0.10 m of modeled water in the current scenario
  function computeAreaFlood(geom){
    if(typeof FLOOD_DEPTH==="undefined"||!_MERC)return null;
    const g=FLOOD_DEPTH[scenKey()]; if(!g)return null;
    const bb=geomBBox(geom); // [minLng,minLat,maxLng,maxLat]
    const c0=_llToCell(bb[3],bb[0]), c1=_llToCell(bb[1],bb[2]); if(!c0||!c1)return null;
    let x0=Math.max(0,Math.min(c0[0],c1[0])), x1=Math.min(GW-1,Math.max(c0[0],c1[0]));
    let y0=Math.max(0,Math.min(c0[1],c1[1])), y1=Math.min(GH-1,Math.max(c0[1],c1[1]));
    let tot=0,wet=0;
    for(let cy=y0;cy<=y1;cy++)for(let cx=x0;cx<=x1;cx++){
      const ll=_cellToLL(cx,cy);
      if(!pipGeom(geom,ll[0],ll[1]))continue;
      tot++; if((g[cy*GW+cx]||0)>=10)wet++;
    }
    return {tot,wet,pct:tot?wet/tot*100:0};
  }
  // Modeled flood depth (m) for a building footprint.
  // The CityCAT water grid is PATCHY at ~39 m resolution (only ~18% of cells are wet, and a
  // building's exact footprint cell is very often 0 even with water all around it). So a building
  // is considered flooded if modeled water REACHES it: we sample the footprint interior, its
  // edge, and a thin ~40 m (1-cell) ring just outside, and flag it flooded if ANY sample is in
  // water (taking the deepest). This matches "is there water at this building" and fixes the
  // many-dry-buildings-in-obvious-water problem, while a building well away from any wet cell
  // (no sample wet) correctly stays dry.
  function buildingFloodDepth(f){
    const ctr=fCentroid(f); if(!ctr)return 0;
    let maxd=0;
    const consider=v=>{if(v>maxd)maxd=v;};
    consider(depthLL(ctr[0],ctr[1]));
    try{
      const ring=f.geometry.type==="MultiPolygon"?f.geometry.coordinates[0][0]:f.geometry.coordinates[0];
      const step=Math.max(1,Math.floor(ring.length/16));
      const cosL=Math.cos(ctr[0]*Math.PI/180);
      const outDeg=0.00036; // ~40 m (one grid cell) outward, into the street/ground that carries water
      for(let i=0;i<ring.length;i+=step){
        const vlat=ring[i][1], vlng=ring[i][0];
        consider(depthLL(vlat,vlng));                 // footprint edge
        const dlat=vlat-ctr[0], dlng=vlng-ctr[1];
        const len=Math.sqrt(dlat*dlat+(dlng*cosL)*(dlng*cosL))||1e-9;
        const k=outDeg/len;
        consider(depthLL(vlat+dlat*k, vlng+dlng*k));  // ~40 m beyond the edge
        consider(depthLL(ctr[0]+dlat*0.5, ctr[1]+dlng*0.5)); // mid interior
      }
    }catch(e){}
    return maxd>=0.10?maxd:0;
  }
  // loaded building footprints flooded (footprint actually in >=0.10 m) inside an area
  function buildingsFloodedInGeom(geom){
    let feats=[]; [bldFlood,bldView].forEach(gg=>{if(gg&&gg.features)feats=feats.concat(gg.features);});
    if(!feats.length)return null;
    const seen={}; let n=0;
    feats.forEach(f=>{const id=f.properties&&f.properties.OBJECTID;
      if(id!=null){if(seen[id])return;seen[id]=1;}
      const ctr=fCentroid(f); if(!ctr||!pipGeom(geom,ctr[0],ctr[1]))return;
      if(buildingFloodDepth(f)>=0.10)n++;});
    return n;
  }
  // selected infrastructure points flooded inside an area (only the types turned on)
  function infraFloodedInGeom(geom){
    if(!show.infra)return {total:0,groups:[]};
    const src=infraData(); let total=0; const groups=[];
    Object.keys(ICON).forEach(t=>{if(!inf[t])return;
      const names=[];
      (src[t]||[]).forEach(s=>{
        if(!inBeltway(s.lat,s.lng)||!pipGeom(geom,s.lat,s.lng))return;
        if(depthMaxLL(s.lat,s.lng,1)>=0.10){names.push(facTitle(t,s)||ICON[t].name);}
      });
      if(names.length){total+=names.length;groups.push({label:ICON[t].name,names});}
    });
    if(inf.bus&&busData){const bn=[];
      busData.features.forEach(f=>{const c=f.geometry&&f.geometry.coordinates;
        if(!c||!inBeltway(c[1],c[0])||!pipGeom(geom,c[1],c[0]))return;
        if(depthMaxLL(c[1],c[0],1)>=0.10){const nm=firstName(f.properties)||"Bus stop";bn.push(nm);}});
      if(bn.length){total+=bn.length;groups.push({label:"MTA bus stop",names:bn});}}
    return {total,groups};
  }
  // parcels (by land use) flooded inside an area — MD PropertyData parcel points
  const PARCEL_URL="https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertyData/MapServer/0/query?";
  function parcelClass(desc){
    const d=String(desc||"").toLowerCase();
    if(/apart|residential|condominium/.test(d)&&!/commerc/.test(d))return "Residential";
    if(/residential\/commercial|commercial\/residential/.test(d))return "Mixed-use";
    if(/industrial/.test(d))return "Industrial";
    if(/commercial/.test(d))return "Commercial";
    if(/exempt/.test(d))return "Institutional/Exempt";
    return "Other";
  }
  function parcelsFloodedInArea(f,cb){
    const p=f.properties||(f.properties={});
    // same scale-aware key as floodStatsBlock so forecast reruns recompute parcels
    const key=scenKey()+"@"+depthScale().toFixed(3);
    p._parc=p._parc||{};
    if(p._parc[key]){cb&&cb(p._parc[key]);return;}
    if(p._parcBusy)return; p._parcBusy=1;
    const bb=geomBBox(f.geometry);
    const env=[bb[0],bb[1],bb[2],bb[3]].map(v=>(+v).toFixed(5)).join(",");
    const res={total:0,flooded:0,by:{}};
    (async()=>{
      for(let off=0;off<20000;off+=2000){
        const url=PARCEL_URL+"geometry="+env+"&geometryType=esriGeometryEnvelope&inSR=4326"+
          "&outFields=DESCLU&outSR=4326&geometryPrecision=6&orderByFields=OBJECTID"+
          "&resultOffset="+off+"&resultRecordCount=2000&f=geojson";
        const g=await fetchGeo(url);
        if(!g||!g.features||!g.features.length)break;
        g.features.forEach(ft=>{
          if(!ft.geometry||ft.geometry.type!=="Point")return;
          const c=ft.geometry.coordinates; if(!pipGeom(f.geometry,c[1],c[0]))return;
          res.total++;
          if(depthLL(c[1],c[0])>=0.10){const cls=parcelClass(ft.properties&&ft.properties.DESCLU);
            res.flooded++; res.by[cls]=(res.by[cls]||0)+1;}
        });
        if(g.features.length<2000)break;
      }
      p._parcBusy=0; p._parc[key]=res; cb&&cb(res);
    })();
  }
  // flood-impact block shown in a neighborhood/subwatershed tooltip when Floodwater is on
  function floodStatsBlock(f){
    if(!show.flood)return "";
    // cache key must include the forecast depth-scale so two forecasts that snap to the
    // same design run but differ in rainfall don't reuse each other's stats
    const key=scenKey()+"@"+depthScale().toFixed(3), p=f.properties||(f.properties={});
    p._ffs=p._ffs||{};
    let st=p._ffs[key]; if(st===undefined){st=computeAreaFlood(f.geometry);p._ffs[key]=st;}
    if(!st||st.tot===0)return "";
    const hdr = MODE.cur==="forecast"
      ? 'In a '+curRainIn().toFixed(1)+' in / '+curDurH()+'-hr forecast'
      : 'In this '+S.rp+'-yr, '+S.dur+'-hr storm';
    let html='<div style="margin-top:5px;border-top:1px solid #e3e9ef;padding-top:4px">'+
      '<b>'+hdr+'</b>'+
      '<br>Area flooded: <b>'+st.pct.toFixed(1)+'%</b>';
    const b=buildingsFloodedInGeom(f.geometry);
    if(b!=null)html+='<br>Buildings flooded (loaded here): <b>'+b+'</b>';
    // parcels by land use (cached async)
    const parc=(f.properties._parc||{})[key];
    if(parc){
      const parts=Object.keys(parc.by).sort((a,c)=>parc.by[c]-parc.by[a]).map(k=>parc.by[k]+" "+k.toLowerCase());
      html+='<br>Parcels flooded: <b>'+parc.flooded+'</b>'+(parc.total?' of '+parc.total+' ('+(parc.total?(parc.flooded/parc.total*100).toFixed(0):0)+'%)':'');
      if(parts.length)html+='<div style="font-size:11px;color:#31404f">'+parts.join(", ")+'</div>';
    }else{
      html+='<br><i>Counting flooded parcels…</i>';
    }
    // infrastructure the user turned on, listed by name (collapsible)
    if(show.infra){
      const ih=infraFloodedInGeom(f.geometry);
      if(ih.total===0){html+='<br>No selected infrastructure flooded here.';}
      else{html+='<details style="margin-top:3px"><summary style="cursor:pointer">Infrastructure flooded (<b>'+ih.total+'</b>) ▾</summary>';
        ih.groups.forEach(gp=>{html+='<div style="font-size:11px;color:#31404f">'+gp.label+': '+gp.names.join("; ")+'</div>';});
        html+='</details>';
      }
    }
    html+='</div>';
    return html;
  }
  // distinct highlight for the area the user clicks
  let selLayer=null, selReset=null;
  const SEL_STYLE={color:"#b91c1c",weight:3.2,fillColor:"#f59e0b",fillOpacity:0.4};
  function selectFeature(l,resetStyle){
    if(selLayer&&selReset){try{selLayer.setStyle(selReset);}catch(e){}}
    selLayer=l; selReset=resetStyle; try{l.setStyle(SEL_STYLE);}catch(e){}
  }

  function drawBoundaries(){
    nbLayer.clearLayers();wsLayer.clearLayers();
    if(show.nb){
      if(LIVE.nb){
        // white casing underneath so the dark boundary reads over dense buildings
        L.geoJSON(LIVE.nb,{pane:"bndtop",interactive:false,style:{color:"#ffffff",weight:4.2,opacity:.9,fill:false}}).addTo(nbLayer);
        L.geoJSON(LIVE.nb,{pane:"bndtop",style:{color:"#1f2d3d",weight:2,opacity:.95,fill:true,fillColor:"#3c4c5c",fillOpacity:0.05},
          onEachFeature:(f,l)=>{const p=f.properties||{};
            const base={color:"#1f2d3d",weight:2,opacity:.95,fill:true,fillColor:"#3c4c5c",fillOpacity:0.05};
            const tip=()=>`<b>${p.Name||"Neighborhood"}</b>${p.Population?"<br>Population: "+(+p.Population).toLocaleString()+" (Open Baltimore)":""}`+floodStatsBlock(f)+lcBlock(f)+hsgBlock(f);
            l.bindTooltip(tip,{sticky:true,direction:"top"});l.bindPopup(tip);
            l.on("mouseover",()=>{if(l!==selLayer)l.setStyle({fillOpacity:0.18});});
            l.on("mouseout",()=>{if(l!==selLayer)l.setStyle(base);});
            l.on("click",()=>{selectFeature(l,base);});
            l.on("mouseover popupopen",()=>{lcStats(f,liveTip(l,tip));hsgStats(f,liveTip(l,tip));
              if(show.flood)parcelsFloodedInArea(f,liveTip(l,tip));});}
        }).addTo(nbLayer);
      }else for(let k=0;k<15;k++){
        L.rectangle(cellRect(k),{pane:"bnd",color:"#3c4c5c",weight:1.4,fill:false,interactive:false}).addTo(nbLayer);
      }
    }
    if(show.ws){
      L.geoJSON(SUBWS,{pane:"bndtop",interactive:false,style:{color:"#ffffff",weight:5,opacity:.9,fill:false}}).addTo(wsLayer);
      L.geoJSON(SUBWS,{pane:"bndtop",style:{color:"#0b5563",weight:3.2,opacity:.98,fillColor:"#0e7490",fillOpacity:.05},
        onEachFeature:(f,l)=>{const nm=(f.properties&&f.properties.name)||"Subwatershed";
          const base={color:"#0b5563",weight:3.2,opacity:.98,fillColor:"#0e7490",fillOpacity:.05};
          const tip=()=>{const pp=f.properties._pop;
            return "<b>"+nm+"</b><br>Population: "+(pp!=null?("~"+pp.toLocaleString()+" (2020 Census)"):
              (wsPopState===3?"unavailable":"computing…"))+floodStatsBlock(f)+lcBlock(f)+hsgBlock(f);};
          l.bindTooltip(tip,{sticky:true,direction:"top"});l.bindPopup(tip);
          l.on("mouseover",()=>{if(l!==selLayer)l.setStyle({fillOpacity:.16});});
          l.on("mouseout",()=>{if(l!==selLayer)l.setStyle(base);});
          l.on("click",()=>{selectFeature(l,base);});
          l.on("mouseover popupopen",()=>{const up=liveTip(l,tip);
            if(wsPopState<2){wsPopWaiters.push(up);loadWsPop();}
            lcStats(f,up);hsgStats(f,up);
            if(show.flood)parcelsFloodedInArea(f,up);});
          try{const c=bestCentroid(f.geometry);
            if(c)L.tooltip({permanent:true,direction:"center",className:"wlbl"}).setLatLng(c).setContent(nm).addTo(wsLayer);}catch(e){}}
      }).addTo(wsLayer);
    }
  }

  // registry of dynamic overlays so forecast focus changes can force them to redraw
  const _dynLayers=[];
  function redrawDynamicLayers(){_dynLayers.forEach(l=>{if(l._map&&l._fcGo)l._fcGo();});}
  // ---------- ArcGIS dynamic export-image overlay (renders any MapServer for the current view) ----------
  function esriDynamic(url,opts){
    const lay=L.imageOverlay("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      [[0,0],[0.0001,0.0001]],{opacity:opts.opacity!=null?opts.opacity:1,interactive:false,pane:opts.pane});
    let t=null;
    const BLANK="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    function go(){
      if(!lay._map)return;
      let b=map.getBounds();
      // build the clamp: Beltway, intersected with the forecast focus circle's bbox when active
      let clamp=opts.clamp;
      const fb=focusBoundsLL();
      if(fb){clamp=clamp?L.latLngBounds(
        L.latLng(Math.max(clamp.getSouth(),fb.getSouth()),Math.max(clamp.getWest(),fb.getWest())),
        L.latLng(Math.min(clamp.getNorth(),fb.getNorth()),Math.min(clamp.getEast(),fb.getEast()))):fb;}
      if(clamp){ // only ask the server for the clamp area
        if(!b.intersects(clamp)){lay.setUrl(BLANK);return;}
        b=L.latLngBounds(
          L.latLng(Math.max(b.getSouth(),clamp.getSouth()),Math.max(b.getWest(),clamp.getWest())),
          L.latLng(Math.min(b.getNorth(),clamp.getNorth()),Math.min(b.getEast(),clamp.getEast())));
      }
      const pTL=map.latLngToContainerPoint(b.getNorthWest()),pBR=map.latLngToContainerPoint(b.getSouthEast());
      const w=Math.max(1,Math.round(pBR.x-pTL.x)),h=Math.max(1,Math.round(pBR.y-pTL.y));
      const p1=L.CRS.EPSG3857.project(b.getSouthWest()),p2=L.CRS.EPSG3857.project(b.getNorthEast());
      lay.setBounds(b);
      lay.setUrl(url+"/export?bbox="+[p1.x,p1.y,p2.x,p2.y].join(",")+"&bboxSR=3857&imageSR=3857"+
        "&size="+w+","+h+(opts.layers?"&layers=show:"+opts.layers:"")+
        (opts.dynamicLayers?"&dynamicLayers="+encodeURIComponent(opts.dynamicLayers):"")+
        "&format=png32&transparent=true&f=image");
    }
    function sched(){if(t)clearTimeout(t);t=setTimeout(go,250);}
    lay._fcGo=go;               // allow forecast focus changes to force a redraw
    _dynLayers.push(lay);
    lay.on("add",()=>{go();map.on("moveend zoomend",sched);});
    lay.on("remove",()=>{map.off("moveend zoomend",sched);});
    return lay;
  }

  // ---------- FEMA flood zones (official MDE DFIRM, drawn by MDE's server) ----------
  const fema=esriDynamic("https://mdgeodata.md.gov/imap/rest/services/Hydrology/MD_Floodplain/MapServer",
    {layers:"1",opacity:.7,pane:"fema",clamp:beltwayBounds});
  function drawFema(){
    document.getElementById("femaSubs").style.display=show.fema?"block":"none";
    if(show.fema){if(!map.hasLayer(fema))fema.addTo(map);}
    else if(map.hasLayer(fema))map.removeLayer(fema);
  }

  // ---------- context rasters: land cover (1 m) + SSURGO soils (MD iMAP) ----------
  const landcover=esriDynamic("https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_HighResolutionLandCover/MapServer",
    {opacity:.72,pane:"landcover",clamp:beltwayBounds});
  function drawLandcover(){const sub=document.getElementById("lcSubs");if(sub)sub.style.display=show.landcover?"block":"none";
    if(show.landcover){if(!map.hasLayer(landcover))landcover.addTo(map);}
    else if(map.hasLayer(landcover))map.removeLayer(landcover);}
  // colour SSURGO polygons by hydrologic soil group (A–D, incl. dual groups)
  const HSG_FILL={A:[44,127,184],"A/D":[120,110,190],B:[127,205,187],"B/D":[150,170,120],
                  C:[253,174,97],"C/D":[240,120,80],D:[215,25,28]};
  const _hsgInfos=Object.keys(HSG_FILL).map(k=>({value:k,label:k,
    symbol:{type:"esriSFS",style:"esriSFSSolid",color:HSG_FILL[k].concat([255]),
      outline:{type:"esriSLS",style:"esriSLSSolid",color:[255,255,255,90],width:0.3}}}));
  const SOIL_DL=JSON.stringify([{id:0,source:{type:"mapLayer",mapLayerId:0},
    drawingInfo:{renderer:{type:"uniqueValue",field1:"HYDROLGRP",
      defaultSymbol:{type:"esriSFS",style:"esriSFSSolid",color:[180,180,180,150],
        outline:{type:"esriSLS",style:"esriSLSSolid",color:[255,255,255,90],width:0.3}},
      uniqueValueInfos:_hsgInfos}}}]);
  const soil=esriDynamic("https://mdgeodata.md.gov/imap/rest/services/Geoscientific/MD_SSURGOSoils/MapServer",
    {opacity:.62,pane:"soil",clamp:beltwayBounds,dynamicLayers:SOIL_DL});
  function drawSoil(){const sub=document.getElementById("soilSubs");if(sub)sub.style.display=show.soil?"block":"none";
    if(show.soil){if(!map.hasLayer(soil))soil.addTo(map);}
    else if(map.hasLayer(soil))map.removeLayer(soil);}

  // ---------- FEMA flood-hazard zones as vectors (to classify building severity) ----------
  // 100-year (1% annual) = high severity, 500-year (0.2%) = moderate, floodway = extreme.
  let femaZones=null, femaZonesLoading=false;
  const FEMA_ZONE_URL="https://mdgeodata.md.gov/imap/rest/services/Hydrology/MD_Floodplain/MapServer/1/query";
  function femaCat(z){
    const s=String(z||"").toUpperCase();
    if(/FLOODWAY/.test(s))return "floodway";
    if(/0\.2|500|X\s*PROT|SHADED/.test(s))return "mod";      // 500-year / 0.2% annual chance
    if(/^A|^V|AE|AO|AH|A99/.test(s))return "sev";            // 100-year / 1% annual chance
    return null;
  }
  // bounding box of a polygon/multipolygon — lets femaZoneAt skip the expensive
  // point-in-polygon test for zones that can't possibly contain the point
  function geomBBox(g){
    let x0=1/0,y0=1/0,x1=-1/0,y1=-1/0;
    const polys=g.type==="MultiPolygon"?g.coordinates:(g.type==="Polygon"?[g.coordinates]:[]);
    polys.forEach(p=>p[0].forEach(pt=>{
      if(pt[0]<x0)x0=pt[0];if(pt[0]>x1)x1=pt[0];
      if(pt[1]<y0)y0=pt[1];if(pt[1]>y1)y1=pt[1];}));
    return [x0,y0,x1,y1];
  }
  async function loadFemaZones(){
    if(femaZones||femaZonesLoading)return;femaZonesLoading=true;busy(true);
    const b=beltwayBounds;
    const env=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(v=>v.toFixed(5)).join(",");
    // page through the service (3,700+ polygons inside the Beltway) so none drop
    const all=[];let offset=0;
    for(let page=0;page<12;page++){
      const url=FEMA_ZONE_URL+"?geometry="+env+"&geometryType=esriGeometryEnvelope&inSR=4326"+
        "&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF&outSR=4326&geometryPrecision=6&where=1%3D1"+
        "&orderByFields=OBJECTID&resultOffset="+offset+"&resultRecordCount=2000&f=geojson";
      const g=await fetchGeo(url);
      if(!g||!g.features||!g.features.length)break;
      all.push.apply(all,g.features);
      if(g.features.length<2000)break;
      offset+=2000;
    }
    femaZonesLoading=false;busy(false);
    if(all.length){
      femaZones=all.map(f=>{
        const p=f.properties||{};
        return {geom:f.geometry,bbox:geomBBox(f.geometry),
          cat:femaCat(p.ZONE_SUBTY||p.FLD_ZONE),
          zone:p.FLD_ZONE||"",sub:p.ZONE_SUBTY||""};})
        .filter(z=>z.cat); // keep only zones we color (100-yr, 500-yr, floodway)
      renderBld(); // recolor buildings now that FEMA zones are known
    }
  }
  // classify a point by the FEMA zone that contains it (bbox prefilter, then pip)
  function femaZoneAt(lat,lng){
    if(!femaZones)return null;
    for(const z of femaZones){
      const b=z.bbox;
      if(lng<b[0]||lng>b[2]||lat<b[1]||lat>b[3])continue; // outside bbox -> skip pip
      if(pipGeom(z.geom,lat,lng))return z;
    }
    return null;
  }

  // ---------- streams (USGS NHD flowlines — same network as StreamStats) ----------
  // Drawn as clean vector lines (no flow-direction arrows, no gauge/structure points)
  // and clipped to the Beltway boundary shapefile. Source: USGS NHD MapServer (the real
  // USGS streams), NOT the StreamStats grid (which is a separate layer).
  const rStreams=L.canvas({pane:"streams"});
  const streamsLayer=L.layerGroup();
  let streamsData=null, streamsLoading=false;
  // USGS NHD MapServer flowline layers (network + non-network connectors/artificial paths)
  const STREAM_LAYERS=[4,5,6];
  function streamUrl(layer,env){
    return "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/"+layer+
      "/query?geometry="+env+"&geometryType=esriGeometryEnvelope&inSR=4326&outFields=GNIS_NAME"+
      "&outSR=4326&geometryPrecision=6&where=1%3D1&resultRecordCount=4000&f=geojson";}
  // keep only the portion of each stream line inside the Beltway polygon AND (when a
  // forecast focus is active) inside the selected focus circle
  function clipLineToBeltway(line){
    const out=[];let run=[];
    for(const pt of line){
      if(inBeltway(pt[1],pt[0])&&fcPass(pt[1],pt[0])){run.push([pt[1],pt[0]]);}
      else{if(run.length>1)out.push(run);run=[];}
    }
    if(run.length>1)out.push(run);
    return out;}
  // Load the real USGS NHD flowlines for the whole Beltway in ONE query per layer, all layers
  // in parallel (fast — matches the production tool). No tiling/retries, so it loads quickly.
  async function loadStreams(){
    if(streamsData||streamsLoading)return;streamsLoading=true;busy(true);
    const b=beltwayBounds;
    const env=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(v=>v.toFixed(5)).join(",");
    const seen={},feats=[];
    try{
      const results=await Promise.all(STREAM_LAYERS.map(lay=>fetchGeo(streamUrl(lay,env))));
      results.forEach(g=>{if(g)for(const f of g.features){
        if(!f.geometry)continue;
        const id=JSON.stringify(f.geometry.coordinates&&f.geometry.coordinates[0]);
        if(seen[id])continue;seen[id]=1;feats.push(f);}});
    }catch(e){}
    streamsLoading=false;busy(false);
    streamsData={type:"FeatureCollection",features:feats};
    renderStreams();
  }
  // clip a lat/lng polyline to the Beltway (+ forecast focus) -> array of sub-polylines
  function clipPolyLL(pts){
    const out=[];let run=[];
    for(const p of pts){
      if(inBeltway(p[0],p[1])&&fcPass(p[0],p[1]))run.push(p);
      else{if(run.length>1)out.push(run);run=[];}
    }
    if(run.length>1)out.push(run);
    return out;
  }
  function renderStreams(){
    streamsLayer.clearLayers();
    if(!show.streams||!streamsData)return;
    // real USGS NHD flowlines, clipped to the Beltway (+ forecast focus)
    streamsData.features.forEach(f=>{
      const nm=(f.properties&&(f.properties.GNIS_NAME||f.properties.NAME||f.properties.gnis_name))||"Stream";
      const lines=f.geometry.type==="MultiLineString"?f.geometry.coordinates:[f.geometry.coordinates];
      lines.forEach(line=>{
        if(!line||line.length<2)return;
        clipLineToBeltway(line).forEach(seg=>{
          L.polyline(seg,{pane:"streams",renderer:rStreams,color:"#d8392b",weight:1.8,opacity:.9})
            .bindTooltip("<b>"+nm+"</b><br>USGS NHD stream",{sticky:true})
            .addTo(streamsLayer);});
      });
    });
  }
  function drawStreams(){
    if(show.streams){
      if(!map.hasLayer(streamsLayer))streamsLayer.addTo(map);
      if(!streamsData)loadStreams(); else renderStreams();
    }else if(map.hasLayer(streamsLayer))map.removeLayer(streamsLayer);
  }

  // ---------- StreamStats stream-cell grid (local GeoTIFF -> PNG overlay) ----------
  // Prepared offline (see _make_streamgrid.py): the statewide streamgrid.tif was
  // cropped to the Beltway, reprojected to EPSG:3857 and saved as a transparent
  // blue PNG so no local .tif read or map server is needed. Sits in the streams
  // pane, so the Beltway clip-path applies to it automatically.
  let streamGridOverlay=null;
  function drawStreamGrid(){
    if(typeof STREAMGRID_IMG==="undefined"){return;} // data/streamgrid.js not built
    if(show.streamGrid){
      if(!streamGridOverlay)
        // own pane (below the USGS stream LINES) so both layers can show at once, and
        // ?v= busts the browser cache so the recolored (purple) PNG loads, not the old blue one
        streamGridOverlay=L.imageOverlay(STREAMGRID_IMG+"?v=2purple",STREAMGRID_BOUNDS,
          {opacity:.85,interactive:false,pane:"streamgrid"});
      if(!map.hasLayer(streamGridOverlay))streamGridOverlay.addTo(map);
    }else if(streamGridOverlay&&map.hasLayer(streamGridOverlay))map.removeLayer(streamGridOverlay);
  }

  // ---------- socio-economic choropleth ----------
  function quantBreaks(vals){
    const v=vals.filter(x=>x!=null&&isFinite(x)).sort((a,b)=>a-b);
    if(!v.length)return null;
    const q=p=>v[Math.min(v.length-1,Math.floor(p*v.length))];
    return {b:[q(.2),q(.4),q(.6),q(.8)],min:v[0],max:v[v.length-1]};}
  function classOf(v,br){let i=0;while(i<4&&v>br.b[i])i++;return i;}
  function drawChoro(){
    choroLayer.clearLayers();
    const leg=document.getElementById("choroLeg");
    if(choroMetric==="none"){leg.style.display="none";return;}
    const m=METRICS[choroMetric];
    const live=LIVE[m.src];
    if(live){
      // clip the socio-economic layer to the Beltway: keep only areas whose
      // centroid falls inside the study boundary
      const feats=live.features.filter(f=>{const c=bestCentroid(f.geometry);return c&&inBeltway(c[0],c[1]);});
      const fc={type:"FeatureCollection",features:feats};
      const vals=feats.map(f=>m.val(f.properties||{}));
      const br=quantBreaks(vals);if(!br){leg.style.display="none";return;}
      const isPct=(m.fmt===fmtPct);
      L.geoJSON(fc,{pane:"bndtop",style:f=>{
          const v=m.val(f.properties||{});
          return {color:"#fff",weight:.7,fillColor:v==null?"#ccc":CHORO_COLS[classOf(v,br)],fillOpacity:.62};},
        onEachFeature:(f,l)=>{const p=f.properties||{};const v=m.val(p);
          const areaNm=m.src==="csa"?p.CSA2010:("Census tract "+String(p.GEOID||"").slice(5));
          // resolve the place/neighborhood name at the area's centroid (stable, not cursor)
          const ctr=bestCentroid(f.geometry);
          const tip=()=>{
            const nb=ctr?nbNameAt(ctr[0],ctr[1]):null;
            const where=nb?(nb+" ("+areaNm+")"):areaNm;
            let desc;
            if(v==null)desc=`No data for ${m.lab.toLowerCase()} here.`;
            else if(isPct)desc=`About <b>${m.fmt(v)}</b> of ${where} falls under “${m.lab.replace(/^%\s*/,'')}”.`;
            else desc=`${m.lab} in ${where} is <b>${m.fmt(v)}</b>.`;
            return `<b>${where}</b><br>${m.lab}: <b>${v==null?"n/a":m.fmt(v)}</b>`+
              (p.tpop10?`<br>Population: ${(+p.tpop10).toLocaleString()}`:"")+
              `<div style="font-size:11px;color:#31404f;margin-top:4px;white-space:normal">${desc}</div>`+
              `<div style="font-size:10.5px;color:#5d6b78;margin-top:2px;white-space:normal">${MDESC[choroMetric]||""}</div>`;
          };
          l.bindTooltip(tip,{sticky:true,direction:"top"});}
      }).addTo(choroLayer);
      document.getElementById("clMin").textContent=m.fmt(br.min);
      document.getElementById("clMax").textContent=m.fmt(br.max);
    }else{
      const vals=DEMO[choroMetric].vals;
      const br=quantBreaks(vals);
      for(let k=0;k<15;k++){
        const v=vals[k];
        L.rectangle(cellRect(k),{pane:"choro",color:"#fff",weight:.8,fillColor:CHORO_COLS[classOf(v,br)],fillOpacity:.62})
          .bindTooltip(`<b>${nbName(k)}</b><br>${m.lab}: <b>${m.fmt(v)}</b> (sample)`,{sticky:true})
          .addTo(choroLayer);
      }
      document.getElementById("clMin").textContent=m.fmt(br.min)+" (sample)";
      document.getElementById("clMax").textContent=m.fmt(br.max);
    }
    leg.style.display="block";
  }

  // ---------- real roads (MDOT SHA centerlines) ----------
  let roadFlood=null, roadView=null, roadTimer=null, roadBusy=false, roadFloodLoading=false;
  const roadBase=esriDynamic("https://mdgeodata.md.gov/imap/rest/services/Transportation/MD_RoadCenterlines/MapServer",
    {layers:"0,1,2,3",opacity:.55,pane:"road",clamp:beltwayBounds});
  async function loadFloodRoads(){ // roads around each flooded area — shown at every zoom
    if(roadFloodLoading||roadFlood)return;roadFloodLoading=true;
    const seen={},feats=[];
    for(const sd of seeds){
      const pad=0.055;
      const w=LO(Math.max(0,sd[0]-pad)),e=LO(Math.min(1,sd[0]+pad));
      const n=LA(Math.max(0,sd[1]-pad)),s=LA(Math.min(1,sd[1]+pad));
      const env=[Math.min(w,e),Math.min(s,n),Math.max(w,e),Math.max(s,n)].map(v=>v.toFixed(5)).join(",");
      for(const lay of [3,2]){
        const g=await fetchGeo(roadUrl(lay,env,lay===3?1500:400));
        if(g)for(const f of g.features){const id=(f.properties&&(f.properties.OBJECTID||f.properties.objectid))||JSON.stringify(f.geometry&&f.geometry.coordinates&&f.geometry.coordinates[0]);
          if(seen[id])continue;seen[id]=1;feats.push(f);}
      }
    }
    roadFloodLoading=false;
    if(feats.length){roadFlood={type:"FeatureCollection",features:feats};renderRoads();updateBriefing();}
  }
  function scheduleRoads(){if(roadTimer)clearTimeout(roadTimer);roadTimer=setTimeout(fetchViewRoads,450);}
  async function fetchViewRoads(){
    if(!show.roads)return;
    if(map.getZoom()<15){roadView=null;renderRoads();return;}
    if(roadBusy)return;roadBusy=true;
    const b=map.getBounds();
    const env=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(v=>v.toFixed(5)).join(",");
    const parts=[];
    for(const lay of [3,2]){const g=await fetchGeo(roadUrl(lay,env,lay===3?1800:500));if(g)parts.push(g);}
    roadBusy=false;
    if(parts.length){roadView={type:"FeatureCollection",features:[].concat(...parts.map(p=>p.features))};renderRoads();updateBriefing();}
  }
  function lineMid(geom){
    const line=geom.type==="MultiLineString"?geom.coordinates[0]:geom.coordinates;
    if(!line||!line.length)return null;
    const p=line[Math.floor(line.length/2)];
    return [p[1],p[0]];}
  function roadName(p){
    if(!p)return "";
    for(const k of ["ROAD_NAME","ROADNAME","FULLNAME","FULL_NAME","ST_NAME","NAME","name"])
      if(typeof p[k]==="string"&&p[k].trim())return p[k].trim();
    for(const k in p)if(/name/i.test(k)&&typeof p[k]==="string"&&p[k].trim())return p[k].trim();
    return "";}
  // Road passability classes by modeled flood depth (deepest = red):
  //   green  = passable  (no flooding, depth < DRY)      -> "Dry or wet"
  //   yellow = caution   (DRY <= depth < DEEP)           -> "Shallow / partial flooding"
  //   red    = closed    (depth >= DEEP, the deepest)    -> "Deep - restricted / closed"
  const DRY=0.10;   // m - below this the road is effectively not flooded (green)
  const DEEP=1.00;  // m - 1 m or more of water = deep / impassable (red)
  const RCOL={green:"#16a34a",yellow:"#d4a017",red:"#dc2626"};
  function roadClassForDepth(d){ if(d>=DEEP)return "red"; if(d>=DRY)return "yellow"; return "green"; }
  function renderRoads(){
    roadLayer.clearLayers();roadWetCount=0;
    if(!show.roads){if(map.hasLayer(roadBase))map.removeLayer(roadBase);return;}
    if(!map.hasLayer(roadBase))roadBase.addTo(map);
    if(!show.flood)return; // no floodwater shown: every road keeps the normal base-map color
    const seen={},feats=[];
    // in forecast mode with a focus, only draw roads near the selected area
    const fClipR=(MODE.cur==="forecast"&&FC.lat!=null&&FC.rad>0);
    [roadFlood,roadView].forEach(g=>{if(g)for(const f of g.features){
      const id=(f.properties&&(f.properties.OBJECTID||f.properties.objectid))||JSON.stringify(f.geometry&&f.geometry.coordinates&&f.geometry.coordinates[0]);
      if(seen[id])continue;seen[id]=1;
      if(fClipR){const m=lineMid(f.geometry);if(!m||!inFocus(m[0],m[1]))continue;}
      feats.push(f);}});
    if(!feats.length)return;
    const STEP=0.00025; // sample roughly every 25 m along the road
    const LABEL={green:"Passable \u2014 no significant flooding",
                 yellow:"Caution \u2014 shallow/partial flooding (under 1 m)",
                 red:"Deep \u2014 restricted / closed (1 m or more)"};
    feats.forEach(f=>{
      const nm=roadName(f.properties)||"Road";
      const lines=f.geometry.type==="MultiLineString"?f.geometry.coordinates:[f.geometry.coordinates];
      lines.forEach(line=>{
        if(!line||line.length<2)return;
        let run=[],cls=null,maxd=0;
        const flush=()=>{
          if(run.length>1&&cls){
            const dashed=(cls==="red");
            L.polyline(run,{pane:"road",renderer:rRoad,color:RCOL[cls],weight:cls==="green"?3:3.6,
                            opacity:cls==="green"?.85:.95,dashArray:dashed?"5 4":null})
              .bindTooltip("<b>"+nm+"</b><br>"+LABEL[cls]+" \u2014 up to "+maxd.toFixed(2)+" m ("+(maxd*3.281).toFixed(1)+" ft) of water",{sticky:true})
              .addTo(roadLayer);
            if(cls==="red")roadWetCount++;}
          run=[];cls=null;maxd=0;};
        for(let i=0;i<line.length-1;i++){
          const x1=line[i][0],y1=line[i][1],x2=line[i+1][0],y2=line[i+1][1];
          const n=Math.max(1,Math.ceil(Math.max(Math.abs(x2-x1),Math.abs(y2-y1))/STEP));
          for(let k=0;k<=n;k++){
            const lng=x1+(x2-x1)*k/n,lat=y1+(y2-y1)*k/n;
            const d=inFocus(lat,lng)?depthLL(lat,lng):0;  // exact cell -> matches water raster; focus clip
            const c=roadClassForDepth(d);
            if(c!==cls){flush();cls=c;}         // break the run when the class changes
            run.push([lat,lng]); if(d>maxd)maxd=d;
          }
        }
        flush();
      });
    });
  }

  // ---------- live building footprints ----------
  const BLDG_MIN_ZOOM=13;
  let bldFlood=null, bldView=null, bldTimer=null, bldBusy=false, lastBC=null, bldFloodLoading=false;
  const bldgBase=esriDynamic("https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_BuildingFootprints/MapServer",
    {layers:"0",opacity:.4,pane:"bldg",clamp:beltwayBounds});
  function bldNote(msg){document.getElementById("bldgNote").textContent=msg||"";}
  async function loadFloodBuildings(){
    if(bldFloodLoading||bldFlood)return;bldFloodLoading=true;busy(true);
    const seen={},feats=[];
    for(const sd of seeds){
      const pad=0.055;
      const w=LO(Math.max(0,sd[0]-pad)),e=LO(Math.min(1,sd[0]+pad));
      const n=LA(Math.max(0,sd[1]-pad)),s=LA(Math.min(1,sd[1]+pad));
      const g=await fetchGeo(bldgUrl(Math.min(w,e),Math.min(s,n),Math.max(w,e),Math.max(s,n),2000));
      if(g)for(const f of g.features){const id=f.properties&&f.properties.OBJECTID;
        if(id!=null&&seen[id])continue;if(id!=null)seen[id]=1;feats.push(f);}
    }
    bldFloodLoading=false;busy(false);
    if(feats.length){bldFlood={type:"FeatureCollection",features:feats};renderBld();updateBriefing();bldNote("");}
    else bldNote("Could not load buildings (needs internet).");
  }
  function scheduleBld(){if(bldTimer)clearTimeout(bldTimer);bldTimer=setTimeout(fetchViewBld,400);}
  async function fetchViewBld(){
    if(!show.bldg)return;
    if(map.getZoom()<BLDG_MIN_ZOOM){bldView=null;renderBld();return;}
    if(bldBusy)return;bldBusy=true;
    const b=map.getBounds();
    const g=await fetchGeo(bldgUrl(b.getWest(),b.getSouth(),b.getEast(),b.getNorth(),4000));
    bldBusy=false;
    if(g){bldView=g;renderBld();updateBriefing();}
  }
  function fCentroid(f){
    try{
      let ring=f.geometry.type==="MultiPolygon"?f.geometry.coordinates[0][0]:f.geometry.coordinates[0];
      let sx=0,sy=0;for(const p of ring){sx+=p[0];sy+=p[1];}
      return [sy/ring.length,sx/ring.length];}catch(e){return null;}}
  // FEMA severity colors for buildings inside official flood-hazard zones
  const FEMA_BCOL={sev:"#d8392b",mod:"#ff8000",floodway:"#7a1f16"};
  const FEMA_BLAB={sev:"In FEMA 100-year zone (1% annual chance)",
                   mod:"In FEMA 500-year zone (0.2% annual chance)",
                   floodway:"In FEMA regulatory floodway"};
  // ---------- building detail (stories / year / use + basement + basement-flood risk) ----------
  // pulled on demand from MD PropertyData parcel points; INDICATIVE estimates, labeled as such.
  const _bldInfoCache={};
  async function fetchBuildingInfo(lat,lng){
    const key=lat.toFixed(5)+","+lng.toFixed(5);
    if(_bldInfoCache[key]!==undefined)return _bldInfoCache[key];
    const d=0.00035, env=[lng-d,lat-d,lng+d,lat+d].join(",");
    const u="https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertyData/MapServer/0/query?"+
      "geometry="+encodeURIComponent(env)+"&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326"+
      "&spatialRel=esriSpatialRelIntersects&outFields=RESITYP,DESCLU,YEARBLT,SQFTSTRC,BLDG_STORY,BLDG_UNITS,STRUCNST"+
      "&returnGeometry=false&f=json&resultRecordCount=1";
    try{const j=await fetch(u).then(r=>r.json());
      const a=(j.features&&j.features[0])?j.features[0].attributes:null;
      _bldInfoCache[key]=a; return a;
    }catch(e){_bldInfoCache[key]=null; return null;}
  }
  // basement presence is not in public data -> indicative guess from age/use (Baltimore
  // rowhouses & older homes very commonly have basements)
  function basementGuess(a){
    if(!a)return {likely:null,txt:"unknown (no parcel record)"};
    const yr=+a.YEARBLT||0, use=String(a.DESCLU||"").toLowerCase(), typ=String(a.RESITYP||"").toUpperCase();
    const resid=/resid|apart|dwell|townhouse|row|condominium/.test(use)||["SF","TH","AP","DU","CN"].includes(typ);
    if(resid&&yr>0&&yr<1980)return {likely:true,txt:"likely YES (older residential \u2014 typical for Baltimore)"};
    if(resid)return {likely:"maybe",txt:"possible (residential)"};
    // clearly non-residential uses (commercial/industrial on slabs) usually have NO basement
    if(/commercial|industrial|warehouse/.test(use))return {likely:false,txt:"unlikely (commercial/industrial \u2014 usually slab, no basement)"};
    return {likely:"maybe",txt:"unknown (non-residential or no data)"};
  }
  // nearest mapped USGS NHD stream (miles) from the local baked flowlines (STREAMLINES) or the
  // live-loaded network; returns null if neither is available (caller falls back to a live fetch)
  function nearestStreamLoaded(lat,lng){
    const cosL=Math.cos(lat*Math.PI/180); let best=Infinity, nm="";
    if(typeof STREAMLINES!=="undefined"&&STREAMLINES.length){
      for(const s of STREAMLINES){const pts=s.pts||s, snm=s.nm||"";
        for(const p of pts){const dx=(p[1]-lng)*cosL, dy=p[0]-lat, mi=Math.sqrt(dx*dx+dy*dy)*69;
          if(mi<best){best=mi;nm=snm;}}}
    }else if(typeof streamsData!=="undefined"&&streamsData&&streamsData.features){
      streamsData.features.forEach(f=>{if(!f.geometry)return;
        const lines=f.geometry.type==="MultiLineString"?f.geometry.coordinates:[f.geometry.coordinates];
        lines.forEach(line=>line.forEach(pt=>{
          const dx=(pt[0]-lng)*cosL, dy=pt[1]-lat, mi=Math.sqrt(dx*dx+dy*dy)*69;
          if(mi<best){best=mi;nm=(f.properties&&(f.properties.GNIS_NAME||f.properties.gnis_name))||"";}}));});
    }
    return isFinite(best)?{mi:best,name:nm}:null;
  }
  // nearest StreamStats stream-cell (miles) from the baked cell list (includes buried/piped
  // channels the NHD flowlines may miss). Returns Infinity if the list isn't loaded/empty.
  function nearestStreamStatsMi(lat,lng){
    if(typeof STREAMCELLS==="undefined"||!STREAMCELLS.length)return Infinity;
    const cosL=Math.cos(lat*Math.PI/180); let best=Infinity;
    for(let i=0;i<STREAMCELLS.length;i++){
      const dx=(STREAMCELLS[i][1]-lng)*cosL, dy=STREAMCELLS[i][0]-lat;
      const mi=Math.sqrt(dx*dx+dy*dy)*69;
      if(mi<best)best=mi;
    }
    return best;
  }
  // on-demand nearest stream. Combines (a) USGS NHD flowlines (loaded layer or a small live
  // fetch) AND (b) the StreamStats stream-cell grid, returning whichever is closer + its source.
  const _streamNearCache={};
  async function nearestStreamMi(lat,lng){
    const ss=nearestStreamStatsMi(lat,lng);                 // StreamStats grid distance (local)
    // NHD distance: prefer the already-loaded network, else a small live fetch
    let nhd=Infinity, nhdName="";
    const loaded=nearestStreamLoaded(lat,lng);
    if(loaded){nhd=loaded.mi;nhdName=loaded.name;}
    else{
      const key=lat.toFixed(3)+","+lng.toFixed(3);
      if(_streamNearCache[key]!==undefined){const c=_streamNearCache[key];nhd=c.mi==null?Infinity:c.mi;nhdName=c.name||"";}
      else{
        const cosL=Math.cos(lat*Math.PI/180), d=0.01;
        const env=[lng-d,lat-d,lng+d,lat+d].join(",");
        const u="https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query?geometry="+env+
          "&geometryType=esriGeometryEnvelope&inSR=4326&outFields=GNIS_NAME&outSR=4326&geometryPrecision=6&f=geojson&resultRecordCount=200";
        try{
          const g=await fetch(u).then(r=>r.json());
          let best=Infinity,nm="";
          (g&&g.features||[]).forEach(f=>{if(!f.geometry)return;
            const lines=f.geometry.type==="MultiLineString"?f.geometry.coordinates:[f.geometry.coordinates];
            lines.forEach(line=>line.forEach(pt=>{
              const dx=(pt[0]-lng)*cosL, dy=pt[1]-lat, mi=Math.sqrt(dx*dx+dy*dy)*69;
              if(mi<best){best=mi;nm=(f.properties&&(f.properties.GNIS_NAME||f.properties.gnis_name))||"";}}));});
          _streamNearCache[key]={mi:isFinite(best)?best:null,name:nm};
          nhd=isFinite(best)?best:Infinity; nhdName=nm;
        }catch(e){_streamNearCache[key]={mi:null,name:""};}
      }
    }
    // combine: closest of NHD vs StreamStats
    let mi=Math.min(nhd,ss), src="", name="";
    if(!isFinite(mi))return {mi:null,name:"",src:"none"};
    if(ss<=nhd){src="StreamStats grid";name=nhdName&&Math.abs(nhd-ss)<0.03?nhdName:"";}
    else{src="USGS NHD";name=nhdName;}
    return {mi,name,src};
  }
  // ----- elevation (m) via USGS EPQS, cached; used for the "how high the house sits" factor -----
  const _elevCache={};
  async function elevationM(lat,lng){
    const key=lat.toFixed(5)+","+lng.toFixed(5);
    if(_elevCache[key]!==undefined)return _elevCache[key];
    try{
      const u="https://epqs.nationalmap.gov/v1/json?x="+lng+"&y="+lat+"&units=Meters&wkid=4326";
      const j=await fetch(u).then(r=>r.json());
      let v=j&&j.value; v=(v==null||v==="")?null:+v;
      _elevCache[key]=v; return v;
    }catch(e){_elevCache[key]=null; return null;}
  }
  // lowest nearby ground elevation (m) sampled on a small ring around the house — approximates
  // the street/low point water would pond at; house minus this = the home's freeboard.
  async function lowNearbyElevM(lat,lng){
    const d=0.0006; // ~65 m ring
    const pts=[[lat+d,lng],[lat-d,lng],[lat,lng+d],[lat,lng-d]];
    const vals=await Promise.all(pts.map(p=>elevationM(p[0],p[1])));
    const ok=vals.filter(v=>v!=null);
    return ok.length?Math.min.apply(null,ok):null;
  }
  // Combined basement-flood risk: surface water on the street + home freeboard (elevation above
  // the local low point) + stream proximity + basement presence. Baltimore rowhomes often sit
  // raised, so even a flooded street may not reach the basement -> freeboard lowers the risk.
  async function basementRisk(lat,lng,depthM,bg){
    const inch=depthM*39.3701;
    const [homeEl,lowEl,stream]=await Promise.all([elevationM(lat,lng),lowNearbyElevM(lat,lng),nearestStreamMi(lat,lng)]);
    let freeboardFt=null;
    if(homeEl!=null&&lowEl!=null)freeboardFt=(homeEl-lowEl)*3.281; // how high the house sits vs the low point
    const streamMi=(stream&&stream.mi!=null)?stream.mi:null;      // null = unknown / none within ~1 km
    const streamM=(streamMi!=null)?streamMi*1609.34:null;         // metres to nearest stream
    const nearStream=(streamM!=null&&streamM<=500);              // within the 500 m risk band
    // base score from street surface water
    let score=0;
    if(inch>=12)score=3; else if(inch>=6)score=2; else if(inch>=2)score=1;
    // STREAM PROXIMITY (0-500 m) contributes on its OWN (buried/piped channels + high
    // groundwater can flood a basement even without ponding on the street). Graded by distance:
    if(streamM!=null){
      if(streamM<=100)score+=2;        // right on/over a stream or buried channel
      else if(streamM<=250)score+=1.5;
      else if(streamM<=500)score+=1;   // still within the elevated-risk band
    }
    // elevation relief: a home sitting well above the local low point sheds surface water
    if(freeboardFt!=null){
      if(freeboardFt>=3)score-=2;               // clearly raised (typical raised rowhome stoop)
      else if(freeboardFt>=1.5)score-=1;
      else if(freeboardFt<=0.3)score+=0.5;      // at/below street grade -> water pools to the door
    }
    if(bg&&bg.likely===true)score+=0.5;         // a basement exists to flood
    let risk,rcol,na=false;
    // NO BASEMENT -> basement flooding can't happen here regardless of street water
    if(bg&&bg.likely===false){
      risk="N/A"; rcol="#64748b"; na=true;
    } else {
      if(score>=3){risk="High";rcol="#dc2626";}
      else if(score>=1.5){risk="Moderate";rcol="#d4a017";}
      else {risk="Low";rcol="#16a34a";}
    }
    return {risk,rcol,na,inch,freeboardFt,streamMi,streamM,streamName:(stream&&stream.name)||"",
            streamSrc:(stream&&stream.src)||"",nearStream,homeEl,lowEl};
  }
  // building popup HTML: flood depth + stories/year/use + basement + basement-flood risk
  async function buildingPopupHTML(lat,lng,depthM){
    const inch=depthM*39.3701;
    const a=await fetchBuildingInfo(lat,lng);
    const bg=basementGuess(a);
    const br=await basementRisk(lat,lng,depthM,bg);   // elevation + stream + surface water
    let h='<div style="min-width:220px"><b>Building</b>';
    h+='<div style="margin:3px 0"><b>Street flood depth here: </b>'+
      (depthM>=0.10?('<span style="color:#08519c;font-weight:700">'+depthM.toFixed(2)+' m / '+inch.toFixed(1)+' in</span>')
                  :'<span style="color:#16a34a">essentially dry</span>')+'</div>';
    h+='<div style="margin-top:4px;padding-top:4px;border-top:1px solid #e2e8f0">';
    if(a){
      const st=(a.BLDG_STORY!=null&&a.BLDG_STORY!=="")?a.BLDG_STORY:"\u2014";
      h+='Stories: <b>'+st+'</b>'+(a.BLDG_UNITS?(" \u00b7 units: "+a.BLDG_UNITS):"")+'<br>';
      if(a.YEARBLT&&+a.YEARBLT>0)h+='Year built: '+a.YEARBLT+'<br>';
      if(a.DESCLU)h+='Use: '+a.DESCLU+'<br>';
    }else{h+='No parcel record found at this point.<br>';}
    h+='Basement: <b>'+bg.txt+'</b></div>';
    // basement-flood risk + WHY (freeboard / stream / surface water)
    h+='<div style="margin-top:4px;padding-top:4px;border-top:1px solid #e2e8f0">';
    h+='<b>Basement-flood risk: </b><span style="display:inline-block;padding:1px 7px;border-radius:9px;color:#fff;font-weight:700;background:'+br.rcol+'">'+br.risk+'</span>';
    if(br.na){
      // no basement -> basement flooding doesn't apply (street may still flood around it)
      h+='<div style="color:#64748b;font-size:11px;margin-top:2px">This building likely has <b>no basement</b>, so basement flooding does not apply'+
         (inch>=6?' \u2014 but the street around it floods, which can still affect ground-floor entry.':'.')+'</div>';
    } else {
      // how high the house sits relative to the local low point
      if(br.freeboardFt!=null){
        if(br.freeboardFt>=1.5)
          h+='<div style="color:#16a34a;font-size:11px;margin-top:2px">\u25b2 Sits about <b>'+br.freeboardFt.toFixed(1)+' ft above</b> the nearby low point \u2014 street water is less likely to reach the basement (typical raised Baltimore rowhome).</div>';
        else if(br.freeboardFt<=0.3)
          h+='<div style="color:#b45309;font-size:11px;margin-top:2px">\u25bc Sits about at street grade (\u2248'+br.freeboardFt.toFixed(1)+' ft) \u2014 surface water can pond to the door/basement.</div>';
        else
          h+='<div style="color:#64748b;font-size:11px;margin-top:2px">Sits \u2248'+br.freeboardFt.toFixed(1)+' ft above the nearby low point.</div>';
      }
      // stream proximity (0-500 m risk band) — nearest of USGS NHD streams & the StreamStats
      // grid (the grid includes buried/piped channels the surface streams map may omit)
      if(br.streamM!=null){
        const m=Math.round(br.streamM);
        const srcTxt=br.streamSrc?(" \u00b7 "+br.streamSrc):"";
        h+='<div style="font-size:11px;color:'+(br.nearStream?"#b45309":"#64748b")+';margin-top:2px">Nearest stream / buried channel: <b>'+m+' m</b>'+(br.streamName?(" ("+br.streamName+")"):"")+srcTxt+
           (br.nearStream?' \u2014 within 500 m: stream backwater / high groundwater can flood a basement even without street ponding.':' \u2014 beyond the 500 m stream-risk band.')+'</div>';
      } else {
        h+='<div style="font-size:11px;color:#94a3b8;margin-top:2px">No mapped stream or buried channel within ~1 km.</div>';
      }
      // entry rule-of-thumb from surface depth
      if(inch>=36)h+='<div style="font-size:11px;color:#5d6b78;margin-top:2px">Water &gt;3 ft could reach first-floor windows.</div>';
      else if(inch>=6)h+='<div style="font-size:11px;color:#5d6b78;margin-top:2px">Water &gt;6 in can enter at doorways/thresholds.</div>';
    }
    h+='</div>';
    h+='<div style="margin-top:4px;font-size:10px;color:#94a3b8">Risk blends modeled street water, home elevation (USGS 3DEP), stream proximity (USGS NHD + StreamStats grid) and likely basement presence. Indicative estimate from public data, not engineering-grade.</div></div>';
    return h;
  }

  function renderBld(){
    bldgLayer.clearLayers();
    if(!show.bldg){if(map.hasLayer(bldgBase))map.removeLayer(bldgBase);updateBldgUI(null);return;}
    if(!map.hasLayer(bldgBase))bldgBase.addTo(map);
    const seen={},feats=[];
    // in forecast mode with a focus, only draw buildings INSIDE the selected area
    const fClip=(MODE.cur==="forecast"&&FC.lat!=null&&FC.rad>0);
    [bldFlood,bldView].forEach(g=>{if(g)for(const f of g.features){
      const id=f.properties&&f.properties.OBJECTID;
      if(id!=null&&seen[id])continue;if(id!=null)seen[id]=1;
      if(fClip){const ct=fCentroid(f);if(!ct||!inFocus(ct[0],ct[1]))continue;}
      feats.push(f);}});
    if(!feats.length){updateBldgUI(null);return;}
    const c={minor:0,mod:0,sev:0,tot:0};
    // classify a building: modeled floodwater depth first, otherwise FEMA hazard zone
    function classify(f){
      const ctr=fCentroid(f);if(!ctr)return {cat:null};
      // flooded only if the footprint itself sits in water (shared strict test) — no over-marking
      const d=(show.flood&&inFocus(ctr[0],ctr[1]))?buildingFloodDepth(f):0;
      const dcat=show.flood?bCat(d):null;
      return {ctr,d,dcat};
    }
    // classify + tally up-front; the canvas renderer draws asynchronously so we
    // must NOT rely on the style callback to build the counts
    feats.forEach(f=>{const r=classify(f);f.__cls=r;if(r.dcat){c[r.dcat]++;c.tot++;}});
    L.geoJSON({type:"FeatureCollection",features:feats},{pane:"bldg",renderer:rBldg,style:f=>{
        const r=f.__cls||{};
        if(r.dcat)return {color:"#6b5410",weight:.6,fillColor:BCOL[r.dcat],fillOpacity:.9};
        return {color:"#7d8b99",weight:.5,fillColor:"#9aa7b3",fillOpacity:.35};},
      onEachFeature:(f,l)=>{const r=f.__cls||{};
        let tip="Building footprint (not flooded in this scenario)";
        if(r.dcat)tip=`<b>${BLAB[r.dcat]}</b><br>${r.d.toFixed(2)} m · ${(r.d*3.281).toFixed(1)} ft of water<br><i>Click for building details + basement risk</i>`;
        else tip+="<br><i>Click for building details + basement risk</i>";
        l.bindTooltip(tip,{sticky:true});
        // bind the popup up-front (reliable on the canvas renderer), fill it on open
        l.bindPopup("Loading building details\u2026",{maxWidth:270});
        l.on("popupopen",(ev)=>{
          if(typeof dismissBldgHint==="function")dismissBldgHint();  // user found the feature
          const ctr=r.ctr||fCentroid(f); if(!ctr){l.setPopupContent("No location for this building.");return;}
          const dep=r.d!=null?r.d:(show.flood?depthLL(ctr[0],ctr[1]):0);
          const pop=ev.popup;
          buildingPopupHTML(ctr[0],ctr[1],dep)
            .then(html=>{pop.setContent(html);})
            .catch(e=>{pop.setContent('<b>Building</b><br>Street flood depth: '+(dep*39.3701).toFixed(1)+' in.<br>'+
              '<span style="color:#b45309">Could not load full building details (needs internet for parcel + elevation data).</span>');});
        });
        }
    }).addTo(bldgLayer);
    updateBldgUI(show.flood?c:null);
  }
  function updateBldgUI(c){
    lastBC=c;
    document.getElementById("bldgList").innerHTML=
      brow(BCOL.sev,BLAB.sev,c?c.sev:"–")+brow(BCOL.mod,BLAB.mod,c?c.mod:"–")+brow(BCOL.minor,BLAB.minor,c?c.minor:"–");
    const st=document.getElementById("bldStatN");
    if(st)st.textContent=c?c.tot:"–";
  }

  // ---------- 311 reports ----------
  function draw311(kind){
    const lay=kind==="fl311"?fl311Layer:wb311Layer;
    lay.clearLayers();
    if(!show[kind]){map.removeLayer(lay);return;}
    lay.addTo(map);
    const col=kind==="fl311"?"#d97706":"#7c3aed";
    const label=kind==="fl311"?"311: flooded street":"311: water in basement";
    if(!LIVE[kind]){
      if(lay._loading)return;lay._loading=true;busy(true);
      Promise.all(SRC311.map(s=>fetchGeo(url311(s,kind)).then(g=>({g,yr:s.yr}))))
        .then(rs=>{lay._loading=false;busy(false);
          const feats=[],gotYr={};
          rs.forEach(r=>{if(!r.g||!r.g.features.length)return;
            if(r.yr>=2023){if(gotYr[r.yr])return;gotYr[r.yr]=1;}
            r.g.features.forEach(f=>{f.properties=f.properties||{};f.properties._yr=r.yr;feats.push(f);});});
          LIVE[kind]={type:"FeatureCollection",features:feats};
          draw311(kind);});
      return;
    }
    LIVE[kind].features.forEach(f=>{
      if(!f.geometry||f.geometry.type!=="Point")return;
      const [lng,lat]=f.geometry.coordinates;
      if(!fcPass(lat,lng))return;   // forecast focus: only within the selected area
      L.circleMarker([lat,lng],{radius:3.5,color:col,weight:1,fillColor:col,fillOpacity:.75})
        .bindTooltip(`<b>${label} (${(f.properties&&f.properties._yr)||""})</b>${f.properties&&f.properties.Address?"<br>"+f.properties.Address:""}`,{sticky:true})
        .addTo(lay);});
  }

  // ---------- bus stops ----------
  // Load once for the whole Beltway (in tiles so the server isn't overwhelmed),
  // clip to the boundary, and show at every zoom — no zoom-in required.
  let busBusy=false,busTimer=null,busData=null,busLoading=false;
  function scheduleBus(){if(busTimer)clearTimeout(busTimer);busTimer=setTimeout(fetchBus,300);}
  async function loadAllBus(){
    if(busData||busLoading)return;busLoading=true;busy(true);infNote("Loading bus stops…");
    const b=beltwayBounds;
    const S0=b.getSouth(),N0=b.getNorth(),W0=b.getWest(),E0=b.getEast();
    const NX=4,NY=4; // split the Beltway envelope into a grid of smaller queries
    const seen={},feats=[];
    for(let iy=0;iy<NY;iy++)for(let ix=0;ix<NX;ix++){
      const w=W0+(E0-W0)*ix/NX,e=W0+(E0-W0)*(ix+1)/NX;
      const s=S0+(N0-S0)*iy/NY,n=S0+(N0-S0)*(iy+1)/NY;
      const url=BUS_BASE+"geometry="+[w,s,e,n].map(v=>v.toFixed(5)).join(",")+
        "&geometryType=esriGeometryEnvelope&inSR=4326&outFields=*&outSR=4326&resultRecordCount=2000&f=geojson";
      const g=await fetchGeo(url);
      if(g)for(const f of g.features){
        if(!f.geometry||f.geometry.type!=="Point")continue;
        const key=f.geometry.coordinates[0].toFixed(5)+","+f.geometry.coordinates[1].toFixed(5);
        if(seen[key])continue;seen[key]=1;feats.push(f);}
    }
    busLoading=false;busy(false);
    busData={type:"FeatureCollection",features:feats};
    renderBus();
    updateBriefing();
  }
  function renderBus(){
    busLayer.clearLayers();
    if(!(show.infra&&inf.bus))return;
    if(!busData){infNote("Loading bus stops…");return;}
    let n=0;
    busData.features.forEach(f=>{
      const [lng,lat]=f.geometry.coordinates;
      if(!inBeltway(lat,lng))return; // clip to Beltway boundary
      n++;
      const nm=firstName(f.properties)||"Bus stop";
      const d=(show.flood&&inFocus(lat,lng))?depthLL(lat,lng):0;  // forecast focus clip
      L.circleMarker([lat,lng],{radius:4,color:"#fff",weight:1.2,fillColor:d>=0.1?"#d8392b":"#0f766e",fillOpacity:.9})
        .bindTooltip(`<b>${nm}</b><br>MTA bus stop`+(d>=0.1?`<br>Flooded in this scenario (${d.toFixed(2)} m)`:""),{sticky:true})
        .addTo(busLayer);});
    infNote(n+" MTA bus stops shown.");
  }
  function fetchBus(){
    if(!(show.infra&&inf.bus)){busLayer.clearLayers();if(map.hasLayer(busLayer))map.removeLayer(busLayer);return;}
    if(!map.hasLayer(busLayer))busLayer.addTo(map);
    if(!busData){loadAllBus();return;}
    renderBus();
  }

  // ---------- infrastructure markers + facility status ----------
  function infraData(){return LIVE.infra||FALLBACK_INFRA;}
  function facilityStatus(A){
    const src=infraData(),out=[];
    ["fire","police","hosp"].forEach(t=>{(src[t]||[]).forEach(s=>{
      if(!inBeltway(s.lat,s.lng))return; // keep only facilities inside the Beltway boundary
      const d=(show.flood&&inFocus(s.lat,s.lng))?depthLL(s.lat,s.lng):0;  // exact cell -> matches water; focus clip
      out.push({name:s.name,lbl:facTitle(t,s),type:t,depth:d,flooded:show.flood&&d>=0.10});});});
    return out;}
  function drawVectors(A){
    areaLayer.clearLayers();stnLayer.clearLayers();
    if(show.infra){
      const src=infraData();
      Object.keys(ICON).forEach(t=>{if(!inf[t])return;
        (src[t]||[]).forEach(s=>{
          if(!inBeltway(s.lat,s.lng))return; // clip all infrastructure to the Beltway boundary
          const io=inBox(s.lat,s.lng);
          const d=(show.flood&&inFocus(s.lat,s.lng))?depthLL(s.lat,s.lng):0;  // exact cell -> matches water; focus clip
          const wet=show.flood&&d>=0.10;
          const col=wet?"#d8392b":"#34618a";
          const icon=L.divIcon({className:"",iconSize:[24,24],iconAnchor:[12,12],
            html:`<div class="stnmk" style="border-color:${col};background:${ICON[t].bg}">${ICON[t].L}</div>`});
          let status="";
          if(show.flood)status="<br>"+(!io?"outside the modeled flood extent":
            wet?`flooded — ${d.toFixed(2)} m (${(d*3.281).toFixed(1)} ft) of water`:"not flooded in this scenario");
          const plc=facLabel(s);
          const title=facTitle(t,s);
          L.marker([s.lat,s.lng],{icon}).addTo(stnLayer)
            .bindTooltip(`<b>${title}</b>`+
              (t==="fire"&&s.name?`<br>Units: ${s.name}`:(plc&&plc!==title?`<br>${plc}`:""))+
              `${s.addr?"<br>"+s.addr:""}${t==="fire"?"":"<br>"+ICON[t].name}${status}`,{direction:"top"});});});
      if(!map.hasLayer(stnLayer))stnLayer.addTo(map);
    }else map.removeLayer(stnLayer);
    fetchBus();
  }

  let _lastFocusSig=null;
  function updateFlood(){
    if(show.flood){floodOverlay.setUrl(floodImgUrl());if(!map.hasLayer(floodOverlay))floodOverlay.addTo(map);}
    else if(map.hasLayer(floodOverlay))map.removeLayer(floodOverlay);
    renderBld();renderRoads();
    drawFocusView();   // forecast focus spotlight + ring (no-op in design mode / Beltway)
    // when the forecast focus changes, re-clip the server rasters (streams/landcover/soil/
    // FEMA/roads/buildings dynamic overlays) AND the point layers (reports / 311 / live
    // conditions) to the new area so nothing outside the selected region is shown
    const fsig=focusActive()?(FC.lat.toFixed(4)+","+FC.lng.toFixed(4)+","+FC.rad):(MODE.cur);
    if(fsig!==_lastFocusSig){_lastFocusSig=fsig;redrawDynamicLayers();redrawPointLayers();}
    // historical-likelihood shading depends on the current RAINFALL, so refresh it whenever
    // the flood scenario updates (design storm change or forecast "Show flood results")
    if(show.hist)drawHist();
  }
  // redraw the currently-visible report / live-condition point layers (they re-apply the
  // forecast focus filter on each draw)
  function redrawPointLayers(){
    if(show.fl311)draw311("fl311");
    if(show.wb311)draw311("wb311");
    if(show.reports)drawReports();
    if(show.social)drawSocial();
    if(show.mycoast)drawMyCoast();
    if(show.closures)drawClosures();
    if(show.cameras)drawCameras();
    if(show.weather)drawWeather();
    if(show.usgs)drawUsgs();
    if(show.noaa)drawNoaa();
    if(show.claims)drawClaims();
    if(show.hist)drawHist();           // re-shade historical likelihood for new rainfall/focus
    if(show.streams)renderStreams();   // re-clip stream lines to the focus
    if(show.streamGrid)drawStreamGrid();
  }

  // recompute just the top briefing sentence + stat cards from the CURRENT loaded
  // data (buildings/roads/bus counts arrive asynchronously, so this is called again
  // whenever those layers finish loading)
  // human-readable list of the non-flood layers currently switched on
  function activeLayerSummary(){
    const on=[];
    if(show.fema)on.push("FEMA flood-hazard zones");
    if(show.roads)on.push("roads");
    if(show.bldg)on.push("building footprints");
    if(show.streams)on.push("USGS streams");
    if(show.streamGrid)on.push("StreamStats grid");
    if(show.landcover)on.push("land cover");
    if(show.soil)on.push("soil (hydrologic groups)");
    if(show.nb)on.push("neighborhoods & places");
    if(show.ws)on.push("subwatersheds");
    if(choroMetric&&choroMetric!=="none"&&METRICS[choroMetric])on.push(METRICS[choroMetric].lab.toLowerCase());
    if(show.fl311)on.push("311 flooded-street reports");
    if(show.wb311)on.push("311 water-in-basement reports");
    if(show.infra){const its=Object.keys(inf).filter(k=>inf[k])
      .map(k=>k==="bus"?"bus stops":(ICON[k]?ICON[k].name.toLowerCase():k));
      if(its.length)on.push("infrastructure ("+its.join(", ")+")");}
    return on;
  }
  function updateBriefing(){
    const A=lastA||analyze();
    const rin=curRainIn();
    const fac=facilityStatus(A);
    const stHit=fac.filter(s=>s.flooded).length;
    const bldF=lastBC?(lastBC.sev+lastBC.mod+lastBC.minor):0;
    const busImp=busImpactedCount();
    const sentEl=document.getElementById("sentence"), statsEl=document.getElementById("stats");
    if(!show.flood){
      const on=activeLayerSummary();
      let msg = on.length
        ? `Floodwater modeling is <b>off</b>. Currently showing: ${on.join(", ")}. Turn on <b>Floodwater (modeled)</b> for the CityCAT storm-impact briefing.`
        : `Turn on <b>Floodwater (modeled)</b> for the CityCAT storm-impact briefing, or switch on layers in the panel to explore the study area.`;
      if(show.ws&&typeof SUBWS!=="undefined")
        msg+=`<div class="wsnote">Subwatersheds in the study area: ${SUBWS.features.map(x=>x.properties.name).join(", ")}.</div>`;
      sentEl.innerHTML=msg; statsEl.innerHTML=""; return;
    }
    const stormTxt = MODE.cur==="forecast"
      ? `A forecast of <b>${(+rin).toFixed(1)} inches</b> of rain over <b>${curDurH()} hour${curDurH()===1?"":"s"}</b> (pluvial / rain-on-grid, nearest CityCAT run: ${fcNearest().rp}-yr ${FC.dur}-hr ${fcNearest().base} in)`
      : `A <b>${S.rp}-year, ${S.dur}-hour</b> storm (about <b>${rin} inches</b> of rain, CityCAT model)`;
    sentEl.innerHTML=
      `${stormTxt} floods `+
      `<b>${bldF.toLocaleString()}</b> of the loaded buildings, makes <b>${roadWetCount}</b> road ${roadWetCount===1?"stretch":"stretches"} impassable`+
      (busImp!=null?`, affects <b>${busImp}</b> MTA bus ${busImp===1?"stop":"stops"}`:``)+
      `, and floods <b>${stHit}</b> of ${fac.length} emergency facilities.`;
    statsEl.innerHTML=
      stat(bldF.toLocaleString(),"buildings flooded (loaded)",bldF?"alert":"good")+
      stat(roadWetCount,"roads impassable",roadWetCount?"alert":"good")+
      stat(busImp==null?"…":busImp,"bus stops affected",busImp?"alert":"good")+
      stat(stHit+" / "+fac.length,"facilities flooded",stHit?"alert":"good");
    // in forecast mode with a focus, add a line about the spotlighted area
    if(MODE.cur==="forecast"&&FC.lat!=null&&FC.rad>0){
      const facHere=fac.filter(s=>inFocus(s.lat,s.lng)).length;
      const facHit=fac.filter(s=>s.flooded&&inFocus(s.lat,s.lng)).length;
      sentEl.innerHTML+=`<div class="wsnote">Focused ${fcFocusText()}${FC._name?` (${FC._name})`:""}: `+
        `${facHit} of ${facHere} emergency ${facHere===1?"facility":"facilities"} flooded here. `+
        `Everything outside the circle is dimmed on the map.</div>`;
    }
  }

  // ---------- refresh ----------
  function refresh(){
    const A=analyze();lastA=A;const base=analyze("base");
    const rin=curRainIn();
    const ri=document.getElementById("rainInfo");
    ri.textContent="≈ "+(+rin).toFixed(1)+" in of rain";
    ri.title=`Design rainfall (NOAA Atlas 14, Baltimore):\n10-yr: ${RAIN[10][1]} in / 1 hr · ${RAIN[10][24]} in / 24 hr\n100-yr: ${RAIN[100][1]} in / 1 hr · ${RAIN[100][24]} in / 24 hr`;
    // keep the forecast "nearest run" note current
    if(MODE.cur==="forecast")updateForecastNote();
    // draw the flood + recolor buildings/roads FIRST so the counts are real
    updateFlood();
    updateBriefing();
    const fac=facilityStatus(A);
    const sl=document.getElementById("stnList");sl.innerHTML="";
    if(!show.flood){
      sl.innerHTML=`<div class="lpnote">Turn on the <b>Floodwater (modeled)</b> layer to see which emergency facilities are flooded in a storm.</div>`;
    }else{
      const flooded=fac.filter(s=>s.flooded);
      const dry=fac.filter(s=>!s.flooded);
      const rows=facShowAll?flooded.concat(dry):flooded;
      const cnt=document.getElementById("facCount"); if(cnt)cnt.textContent=flooded.length+" flooded / "+fac.length+" total";
      if(!rows.length){sl.innerHTML=`<div class="lpnote">No emergency facilities are flooded in this scenario.${fac.length?' Use "Show all" to list all '+fac.length+'.':''}</div>`;}
      rows.forEach(s=>{const col=s.flooded?"var(--blocked)":"var(--ok)";
        const lab=s.flooded?(s.depth?s.depth.toFixed(2)+" m":"flooded"):"not flooded";
        sl.insertAdjacentHTML("beforeend",`<div class="stn"><span class="ring" style="background:${col}"></span><span class="ptmini">${ICON[s.type].L}</span>${s.lbl||s.name||ICON[s.type].name}<span class="gap" style="color:${col}">${lab}</span></div>`);});
    }
    const gb=document.getElementById("gibox");
    if(S.cond==="gi"){const roads=base.blocked-A.blocked,areas=base.isoNbs.length-A.isoNbs.length,ppl=base.people-A.people;
      gb.style.display="block";
      gb.innerHTML=`<b>Green infrastructure effect.</b> Keeps <b>${Math.max(0,roads)}</b> road links open, reconnects <b>${Math.max(0,areas)}</b> ${areas===1?"neighborhood":"neighborhoods"}, and restores access for about <b>${Math.max(0,ppl).toLocaleString()}</b> residents versus no green infrastructure.`;
    } else gb.style.display="none";
    drawVectors(A);
  }
  function stat(n,l,cls){return `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`;}
  function brow(c,l,n){return `<div class="bstat"><span class="sw2" style="background:${c}"></span>${l}<span class="n2">${n}</span></div>`;}

  // (Removed) The "what this depth looks like" stock-photo viewer was taken out —
  // depths are reported as plain numbers in popups, and real local photos are shown
  // via the "Reported flooding" layers below.

  // ---------- cursor-following depth readout ----------
  const cd=document.getElementById("curDepth");
  let hoverPending=false,hoverEvt=null;
  map.on("mousemove",e=>{hoverEvt=e;if(hoverPending)return;hoverPending=true;
    requestAnimationFrame(()=>{hoverPending=false;const ev=hoverEvt;if(!ev)return;
      const lat=ev.latlng.lat,lng=ev.latlng.lng;
      const d=(show.flood&&inBox(lat,lng))?depthLL(lat,lng):0;
      if(d>=0.1){
        cd.style.display="block";
        cd.style.left=(ev.containerPoint.x+16)+"px";
        cd.style.top=(ev.containerPoint.y+14)+"px";
        cd.textContent=d.toFixed(2)+" m · "+(d*3.281).toFixed(1)+" ft deep";
      }else cd.style.display="none";});});
  map.on("mouseout",()=>{cd.style.display="none";});

  // ---------- reported / observed flooding (photos + social media + MyCoast) ----------
  const repLayer=L.layerGroup(), socLayer=L.layerGroup(), ytLayer=L.layerGroup(), mycLayer=L.layerGroup();
  const REP=(typeof FLOOD_REPORTS!=="undefined")?FLOOD_REPORTS:[];
  const SOC=(typeof SOCIAL_REPORTS!=="undefined")?SOCIAL_REPORTS:[];
  const YT =(typeof YOUTUBE_REPORTS!=="undefined")?YOUTUBE_REPORTS:[];
  let MYC=(typeof MYCOAST_REPORTS!=="undefined")?MYCOAST_REPORTS.slice():[]; // baked fallback; refreshed live
  const NEWS=(typeof NEWS_REPORTS!=="undefined")?NEWS_REPORTS:[];
  const RCL=(typeof ROADCLOSURE_REPORTS!=="undefined")?ROADCLOSURE_REPORTS:[];

  // photo gallery modal (reuses #galModal in index.html)
  let _lbList=[], _lbIdx=0;
  function openGallery(title, subtitle, images, credit, videos){
    const gm=document.getElementById("galModal"); if(!gm)return;
    document.getElementById("galTitle").innerHTML=title||"Reported flooding";
    const sub=document.getElementById("galSub"); sub.innerHTML=subtitle||"";
    const wrap=document.getElementById("galImgs"); wrap.innerHTML="";
    _lbList=(images||[]).slice();
    (images||[]).forEach((src,ix)=>{
      const im=document.createElement("img"); im.src=src; im.loading="lazy"; im.title="Click to enlarge";
      im.style.cursor="zoom-in";
      im.onerror=()=>{im.style.display="none";};
      im.onclick=()=>openLightbox(ix);
      wrap.appendChild(im);
    });
    // video links
    const vids=videos||[];
    let cr=document.getElementById("galCredit");
    let vhtml=credit?('<div>'+credit+'</div>'):'';
    if(vids.length){
      vhtml+='<div style="margin-top:6px"><b>Videos of flooding here:</b> ';
      vhtml+=vids.map((u,i)=>'<a href="'+u+'" target="_blank" rel="noopener">'+vidLabel(u,i)+'</a>').join(" &nbsp;\u00b7&nbsp; ");
      vhtml+='</div>';
    }
    cr.innerHTML=vhtml;
    gm.classList.add("on");
  }
  function vidLabel(u,i){
    const t=/tiktok/.test(u)?"TikTok":/facebook/.test(u)?"Facebook":/youtu/.test(u)?"YouTube":"Video";
    return "\u25b6 "+t+" "+(i+1);
  }
  // full-screen lightbox with next/prev navigation + click-to-zoom & pan
  let _lbZoom=1, _lbPanX=0, _lbPanY=0, _lbDrag=null;
  function openLightbox(ix){
    if(typeof ix==="string"){_lbList=[ix];ix=0;}
    _lbIdx=ix||0;
    let lb=document.getElementById("lightbox");
    if(!lb){
      lb=document.createElement("div"); lb.id="lightbox";
      lb.innerHTML='<span id="lbClose" title="Close (Esc)">\u00d7</span>'+
        '<button id="lbPrev" class="lbnav" title="Previous (\u2190)"><span>\u2039</span></button>'+
        '<div id="lbStage"><img id="lightboxImg" alt="flood photo"></div>'+
        '<button id="lbNext" class="lbnav" title="Next photo (\u2192)"><span>\u203a</span><small>NEXT</small></button>'+
        '<div id="lbZoomCtl"><button id="lbZoomOut" title="Zoom out">\u2212</button>'+
          '<button id="lbZoomReset" title="Fit to screen">Fit</button>'+
          '<button id="lbZoomIn" title="Zoom in">+</button></div>'+
        '<div id="lbCount"></div><div id="lbHint">Scroll or use + / \u2212 to zoom \u00b7 drag to pan \u00b7 \u2190 \u2192 to change photo</div>';
      document.body.appendChild(lb);
      lb.onclick=e=>{if(e.target.id==="lightbox"||e.target.id==="lbClose")lb.classList.remove("on");};
      document.getElementById("lbPrev").onclick=e=>{e.stopPropagation();lbStep(-1);};
      document.getElementById("lbNext").onclick=e=>{e.stopPropagation();lbStep(1);};
      document.getElementById("lbZoomIn").onclick=e=>{e.stopPropagation();lbSetZoom(_lbZoom*1.4);};
      document.getElementById("lbZoomOut").onclick=e=>{e.stopPropagation();lbSetZoom(_lbZoom/1.4);};
      document.getElementById("lbZoomReset").onclick=e=>{e.stopPropagation();lbSetZoom(1);};
      const img=document.getElementById("lightboxImg");
      // click the image to toggle zoom (1x -> 2.2x)
      img.onclick=e=>{e.stopPropagation();lbSetZoom(_lbZoom>1?1:2.2);};
      // wheel to zoom
      document.getElementById("lbStage").addEventListener("wheel",e=>{
        e.preventDefault();lbSetZoom(_lbZoom*(e.deltaY<0?1.15:1/1.15));},{passive:false});
      // drag to pan when zoomed
      img.addEventListener("mousedown",e=>{if(_lbZoom<=1)return;e.preventDefault();
        _lbDrag={x:e.clientX,y:e.clientY,px:_lbPanX,py:_lbPanY};});
      document.addEventListener("mousemove",e=>{if(!_lbDrag)return;
        _lbPanX=_lbDrag.px+(e.clientX-_lbDrag.x);_lbPanY=_lbDrag.py+(e.clientY-_lbDrag.y);lbApply();});
      document.addEventListener("mouseup",()=>{_lbDrag=null;});
      document.addEventListener("keydown",e=>{
        if(!lb.classList.contains("on"))return;
        if(e.key==="ArrowRight")lbStep(1);
        else if(e.key==="ArrowLeft")lbStep(-1);
        else if(e.key==="Escape")lb.classList.remove("on");
        else if(e.key==="+"||e.key==="=")lbSetZoom(_lbZoom*1.4);
        else if(e.key==="-")lbSetZoom(_lbZoom/1.4);
      });
    }
    lbShow(); lb.classList.add("on");
  }
  function lbSetZoom(z){
    _lbZoom=Math.max(1,Math.min(6,z));
    if(_lbZoom===1){_lbPanX=0;_lbPanY=0;}
    lbApply();
  }
  function lbApply(){
    const img=document.getElementById("lightboxImg"); if(!img)return;
    img.style.transform="translate("+_lbPanX+"px,"+_lbPanY+"px) scale("+_lbZoom+")";
    img.style.cursor=_lbZoom>1?"grab":"zoom-in";
  }
  function lbShow(){
    const src=_lbList[_lbIdx]; if(!src)return;
    document.getElementById("lightboxImg").src=src;
    _lbZoom=1;_lbPanX=0;_lbPanY=0;lbApply();
    const c=document.getElementById("lbCount"); if(c)c.textContent=(_lbIdx+1)+" / "+_lbList.length;
    const multi=_lbList.length>1;
    document.getElementById("lbPrev").style.display=multi?"":"none";
    document.getElementById("lbNext").style.display=multi?"":"none";
  }
  function lbStep(d){ if(!_lbList.length)return; _lbIdx=(_lbIdx+d+_lbList.length)%_lbList.length; lbShow(); }
  (function(){const gm=document.getElementById("galModal");
    if(gm){document.getElementById("galClose").onclick=()=>gm.classList.remove("on");
      gm.onclick=e=>{if(e.target.id==="galModal")gm.classList.remove("on");};}})();

  function repMarker(r,color){
    const m=L.circleMarker([r.lat,r.lng],{radius:6,color:"#fff",weight:1.5,fillColor:color,fillOpacity:.95});
    const imgs=r.images||[];
    const n=imgs.length;
    const evt=r.event?("<br>"+r.event):(r.when?("<br>"+r.when):"");
    const src="<br><span style=\"color:#5d6b78\">"+(r.source||"Flood report")+"</span>";
    let html="<b>"+(r.name||"Flood report")+"</b>"+evt+src;
    if(r.floodClass)html+='<br><span class="floodtag floodtag-'+r.floodClass+'">'+(r.floodClass==="coastal"?"Coastal / high-tide flooding":"Inland (rainfall) flooding")+'</span>';
    else if(r.reportType)html+="<br>"+r.reportType;
    if(r.rainIn!=null)html+='<br><span style="color:#2563eb">\u2614 '+r.rainIn+' in. of rain in the 24 h before this report</span>';
    if(n){
      html+='<div class="repthumbwrap">';
      html+='<img class="repthumb" src="'+imgs[0]+'" onerror="this.style.display=\'none\'">';
      html+='</div>';
      html+='<button class="repmore" data-i="'+ridx(r)+'">'+(n>1?("See all "+n+" photos"):"View photo")+' \u25be</button>';
    }
    const vids=r.videos||[];
    if(vids.length) html+='<br><b>\u25b6 Watch flooding videos here:</b> '+vids.map((u,i)=>'<a href="'+u+'" target="_blank" rel="noopener">'+vidLabel(u,i)+'</a>').join(" &nbsp;\u00b7&nbsp; ");
    if(r.url)html+='<br><a href="'+r.url+'" target="_blank" rel="noopener">Open original report</a>';
    m.bindPopup(html,{maxWidth:270});
    const openG=()=>openGallery(r.name||"Reported flooding",
        (r.event||r.when||"")+(r.source?(" \u00b7 "+r.source):""), imgs, r.credit||"", vids);
    m.on("popupopen",ev=>{
      const b=ev.popup._contentNode.querySelector(".repmore"); if(b)b.onclick=openG;
      const th=ev.popup._contentNode.querySelector(".repthumb"); if(th){th.style.cursor="pointer";th.onclick=openG;}
    });
    return m;
  }
  const _allrep=[]; function ridx(r){let i=_allrep.indexOf(r); if(i<0){i=_allrep.push(r)-1;} return i;}

  // Validated reported-flooding points are shown wherever they occur (some, like
  // Ellicott City, Glen Burnie and Laurel, sit outside the Beltway study area).
  function drawReports(){
    repLayer.clearLayers();
    if(!show.reports){if(map.hasLayer(repLayer))map.removeLayer(repLayer);return;}
    if(!map.hasLayer(repLayer))repLayer.addTo(map);
    REP.forEach(r=>{if(!fcPass(r.lat,r.lng))return;repMarker(r,"#c026d3").addTo(repLayer);});
  }
  function drawSocial(){
    socLayer.clearLayers();
    if(!show.social){if(map.hasLayer(socLayer))map.removeLayer(socLayer);return;}
    if(!map.hasLayer(socLayer))socLayer.addTo(map);
    SOC.forEach(r=>{if(!fcPass(r.lat,r.lng))return;repMarker(r,"#0891b2").addTo(socLayer);});
    YT.forEach(r=>{if(!fcPass(r.lat,r.lng))return;repMarker(r,"#0891b2").addTo(socLayer);});
  }
  // MyCoast live refresh: pull the current reports straight from MyCoast MD (CORS-enabled)
  // so new reports appear automatically; fall back to the baked MYCOAST_REPORTS on failure.
  let mycTried=false;
  const MYC_BASE="https://services1.arcgis.com/tikbh7xC3WJpzTz6/arcgis/rest/services/currentFL_viewMD/FeatureServer/0/query";
  const MYC_BBOX="-76.80,39.18,-76.45,39.46";
  function mycClass(rt){rt=String(rt||"");
    if(rt==="High Tide Flooding"||rt==="Coastal Storm Damage"||rt==="King Tide")return "coastal";
    if(rt==="Storm Reporter")return "inland"; return null;}
  async function refreshMyCoastLive(){
    if(mycTried)return; mycTried=true;
    try{
      busy(true);
      let feats=[],off=0;
      for(let page=0;page<6;page++){
        const u=MYC_BASE+"?where=1%3D1&geometry="+encodeURIComponent(MYC_BBOX)+
          "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects"+
          "&outFields=*&f=json&resultRecordCount=1000&resultOffset="+off;
        const d=await fetch(u).then(r=>r.json());
        const fs=(d&&d.features)||[]; feats=feats.concat(fs);
        if(fs.length<1000)break; off+=1000;
      }
      busy(false);
      const out=[],seen={};
      feats.forEach(f=>{const a=f.attributes||{};const cls=mycClass(a.Report_Type);if(!cls)return;
        let lat=a.Latitude,lng=a.Longitude; if(lat==null||lng==null)return; lat=+lat;lng=+lng;
        if(!(lat>=39.18&&lat<=39.46&&lng>=-76.80&&lng<=-76.45))return;
        const key=lat.toFixed(5)+","+lng.toFixed(5)+","+(a.Date||"");if(seen[key])return;seen[key]=1;
        const imgs=String(a.ImageUrls||"").split("|").filter(s=>/^http/.test(s)).map(s=>s.replace(/-\d{2,4}x\d{2,4}(?=\.\w+$)/,""));
        const rec={name:a.Title||"MyCoast report",lat:+lat.toFixed(6),lng:+lng.toFixed(6),
          source:"MyCoast citizen report (mycoast.org/md)",reportType:String(a.Report_Type||""),floodClass:cls,
          when:(typeof a.Date==="number")?new Date(a.Date).toISOString().slice(0,10):"",images:imgs,url:a.Report_URL||""};
        if(typeof a.Precipitation24h==="number"&&a.Precipitation24h>0)rec.rainIn=Math.round(a.Precipitation24h*100)/100;
        out.push(rec);});
      if(out.length){MYC=out;}   // use fresh data if we got any
    }catch(e){busy(false);/* keep baked fallback */}
    if(show.mycoast)drawMyCoast();
  }
  function drawMyCoast(){
    mycLayer.clearLayers();
    const sub=document.getElementById("mycSubs");if(sub)sub.style.display=show.mycoast?"block":"none";
    if(!show.mycoast){if(map.hasLayer(mycLayer))map.removeLayer(mycLayer);return;}
    if(!map.hasLayer(mycLayer))mycLayer.addTo(map);
    if(!mycTried){refreshMyCoastLive();}   // auto-update from MyCoast the first time the layer is on
    // coastal/high-tide = blue, inland/rainfall = orange
    MYC.forEach(r=>{if(!fcPass(r.lat,r.lng))return;const col=(r.floodClass==="coastal")?"#2563eb":(r.floodClass==="inland")?"#d97706":"#059669";
      repMarker(r,col).addTo(mycLayer);});
  }
  // ---------- live traffic cameras (MDOT CHART) ----------
  // time helper for "live" labels
  function agoLabel(ms){
    if(!ms)return "";
    const d=Date.now()-ms;
    if(d<0)return "just now";
    const mn=Math.round(d/60000);
    if(mn<1)return "just now";
    if(mn<60)return mn+" min ago";
    const hr=Math.round(mn/60); if(hr<24)return hr+" h ago";
    return Math.round(hr/24)+" d ago";
  }
  function stamp(ms){
    if(!ms)return "";
    try{return new Date(ms).toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}catch(e){return "";}
  }
  const camLayer=L.layerGroup();
  let CAM=(typeof CHART_CAMERAS!=="undefined")?CHART_CAMERAS.slice():[];  // baked fallback
  const CAM_LIVE="https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do";
  let camLiveTried=false;
  function camInBeltway(lat,lng){return lat!=null&&lng!=null&&lat>=39.19&&lat<=39.45&&lng>=-76.76&&lng<=-76.46;}
  async function refreshCamerasLive(){
    if(camLiveTried)return; camLiveTried=true;
    try{
      busy(true);
      const data=await fetch(CAM_LIVE).then(r=>r.json());
      busy(false);
      const rows=(data&&data.data)||[];
      const live=[];
      rows.forEach(c=>{let lat=c.lat,lng=c.lon; if(lat==null||lng==null)return;
        lat=+lat;lng=+lng; if(!camInBeltway(lat,lng))return;
        live.push({id:c.id,name:(c.description||c.name||"Traffic camera").trim(),lat:+lat.toFixed(6),lng:+lng.toFixed(6),
          video:c.publicVideoURL||"",route:((c.routePrefix||"")+" "+(c.routeNumber||"")).trim(),
          online:String(c.opStatus||"").toUpperCase()==="OK",updated:c.lastCachedDataUpdateTime||c.lastUpdate||0});});
      if(live.length){CAM=live;}        // use fresh list if we got one
    }catch(e){busy(false);/* keep baked fallback */}
    if(show.cameras)drawCameras();
  }
  function drawCameras(){
    camLayer.clearLayers();
    if(!show.cameras){if(map.hasLayer(camLayer))map.removeLayer(camLayer);return;}
    if(!map.hasLayer(camLayer))camLayer.addTo(map);
    if(!camLiveTried){refreshCamerasLive();}   // pull fresh list the first time it's turned on
    CAM.forEach(c=>{
      if(c.lat==null||c.lng==null)return;
      if(!fcPass(c.lat,c.lng))return;   // forecast focus
      const col=c.online?"#0ea5e9":"#94a3b8";
      const m=L.marker([c.lat,c.lng],{icon:L.divIcon({className:"camdiv",
        html:'<div class="campin" title="Live traffic camera">\uD83D\uDCF9</div>',iconSize:[20,20],iconAnchor:[10,10]})});
      let html='<b>'+(c.name||"Traffic camera")+'</b>';
      if(c.route)html+='<br><span style="color:#5d6b78">'+c.route+'</span>';
      html+='<br><span style="color:#5d6b78">MDOT CHART traffic camera'+(c.online?"":" (offline now)")+'</span>';
      if(c.video)html+='<br><a href="'+c.video+'" target="_blank" rel="noopener">\u25b6 Open LIVE video</a>'+
                       '<br><span style="color:#94a3b8;font-size:11px">Opens MDOT\u2019s live stream (real-time) in a new tab. The live player shows the current time; image quality is set by MDOT.</span>';
      m.bindPopup(html,{maxWidth:270});
      m.addTo(camLayer);
    });
  }
  // ---------- live weather stations (MDOT CHART RWIS) : precipitation focus ----------
  const wxLayer=L.layerGroup();
  let WX=(typeof CHART_WEATHER!=="undefined")?CHART_WEATHER.slice():[]; let wxTried=false; // baked fallback
  const WX_LIVE="https://chartexp1.sha.maryland.gov/CHARTExportClientService/getRWISMapDataJSON.do";
  async function refreshWeatherLive(){
    if(wxTried)return; wxTried=true;
    try{
      busy(true);
      const data=await fetch(WX_LIVE).then(r=>r.json());
      busy(false);
      const rows=(data&&data.data)||[];
      WX=rows.filter(s=>s.lat!=null&&s.lon!=null&&camInBeltway(+s.lat,+s.lon)).map(s=>({
        id:s.id,name:(s.name||s.description||"Weather station").trim(),lat:+(+s.lat).toFixed(6),lng:+(+s.lon).toFixed(6),
        precip:s.precipitationType||"No Data Available",air:s.airTemp||"",rh:s.relativeHumidity||"",
        wind:s.windDescription||"",updated:s.lastUpdate||s.lastCachedDataUpdateTime||0}));
    }catch(e){busy(false);}
    if(show.weather)drawWeather();
  }
  function drawWeather(){
    wxLayer.clearLayers();
    if(!show.weather){if(map.hasLayer(wxLayer))map.removeLayer(wxLayer);return;}
    if(!map.hasLayer(wxLayer))wxLayer.addTo(map);
    if(!wxTried){refreshWeatherLive();}   // try live; baked CHART_WEATHER shows meanwhile
    WX.forEach(s=>{
      if(!fcPass(s.lat,s.lng))return;   // forecast focus
      const raining=/rain|snow|wet|precip/i.test(s.precip)&&!/no data|none/i.test(s.precip);
      const col=raining?"#1d4ed8":"#0f766e";   // raining = strong blue, else deep teal
      const m=L.marker([s.lat,s.lng],{icon:L.divIcon({className:"wxdiv",
        html:'<div class="wxpin" style="background:'+col+'" title="Live weather station">\u2614</div>',
        iconSize:[24,24],iconAnchor:[12,12]})});
      let html='<b>'+s.name+'</b><br><span style="color:#5d6b78">MDOT CHART weather station (RWIS)</span>';
      html+='<br><b>Precipitation:</b> '+(s.precip||"\u2014");
      if(s.air)html+='<br>Air temp: '+s.air;
      if(s.rh)html+='<br>Humidity: '+s.rh;
      if(s.wind)html+='<br>Wind: '+s.wind;
      if(s.updated)html+='<br><span style="color:#5d6b78">Updated '+stamp(s.updated)+' ('+agoLabel(s.updated)+')</span>';
      html+='<br><span style="color:#94a3b8;font-size:11px">CHART reports precipitation type (rain/none), not amount in inches.</span>';
      m.bindPopup(html,{maxWidth:260});
      m.addTo(wxLayer);
    });
  }
  // ---------- FEMA NFIP flood-insurance claims by ZIP (ZCTA choropleth) ----------
  // ---------- USGS stream gauges (live gage height + streamflow) ----------
  const usgsLayer=L.layerGroup();
  let USG=(typeof USGS_GAUGES!=="undefined")?USGS_GAUGES.slice():[]; let usgsTried=false;
  async function refreshUsgsLive(){
    if(usgsTried)return; usgsTried=true;
    try{
      busy(true);
      const u="https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=-76.80,39.18,-76.45,39.46&parameterCd=00065,00060&siteStatus=active";
      const d=await fetch(u).then(r=>r.json()); busy(false);
      const sites={};
      (d.value&&d.value.timeSeries||[]).forEach(t=>{
        const src=t.sourceInfo,code=src.siteCode[0].value,nm=src.siteName;
        const gl=src.geoLocation.geogLocation,lat=+gl.latitude.toFixed(6),lng=+gl.longitude.toFixed(6);
        const vc=t.variable.variableCode[0].value,vals=t.values[0].value,last=vals&&vals.length?vals[vals.length-1]:null;
        const s=sites[code]||(sites[code]={id:code,name:nm.replace(/\b\w/g,c=>c.toUpperCase()),lat,lng});
        if(last&&last.value!=null&&last.value!==""&&last.value!=="-999999"){
          if(vc==="00065"){s.gageHt=last.value;s.when=last.dateTime;}
          if(vc==="00060"){s.flow=last.value;s.when=s.when||last.dateTime;}
        }});
      const arr=Object.values(sites); if(arr.length)USG=arr;
    }catch(e){busy(false);}
    if(show.usgs)drawUsgs();
  }
  function drawUsgs(){
    usgsLayer.clearLayers();
    if(!show.usgs){if(map.hasLayer(usgsLayer))map.removeLayer(usgsLayer);return;}
    if(!map.hasLayer(usgsLayer))usgsLayer.addTo(map);
    if(!usgsTried){refreshUsgsLive();}
    USG.forEach(s=>{
      if(s.lat==null||s.lng==null)return;
      if(!fcPass(s.lat,s.lng))return;   // forecast focus
      const m=L.marker([s.lat,s.lng],{icon:L.divIcon({className:"usgsdiv",
        html:'<div class="usgspin" title="USGS stream gauge">\u25B2</div>',iconSize:[22,22],iconAnchor:[11,11]})});
      let html='<b>'+s.name+'</b><br><span style="color:#5d6b78">USGS stream gauge #'+s.id+'</span>';
      if(s.gageHt!=null)html+='<br><b>Gage height:</b> '+s.gageHt+' ft';
      if(s.flow!=null)html+='<br>Streamflow: '+s.flow+' ft\u00b3/s';
      if(s.when)html+='<br><span style="color:#5d6b78">Reading: '+stamp(Date.parse(s.when))+' ('+agoLabel(Date.parse(s.when))+')</span>';
      html+='<br><a href="https://waterdata.usgs.gov/monitoring-location/'+s.id+'/" target="_blank" rel="noopener">USGS site page</a>';
      m.bindPopup(html,{maxWidth:250}); m.addTo(usgsLayer);
    });
  }
  // ---------- NOAA / NWS weather stations (live obs + precipitation) ----------
  const noaaLayer=L.layerGroup();
  let NOA=(typeof NOAA_STATIONS!=="undefined")?NOAA_STATIONS.slice():[]; let noaaTried=false;
  function mm2in(v){return v==null?null:Math.round(v/25.4*100)/100;}
  async function refreshNoaaLive(){
    if(noaaTried)return; noaaTried=true;
    try{
      busy(true);
      const out=[];
      for(const sid of ["KBWI","KDMH","KMTN"]){
        try{
          const st=await fetch("https://api.weather.gov/stations/"+sid).then(r=>r.json());
          const c=st.geometry.coordinates;
          const o=(await fetch("https://api.weather.gov/stations/"+sid+"/observations/latest").then(r=>r.json())).properties;
          const g=k=>(o[k]&&o[k].value!=null)?o[k].value:null;
          out.push({id:sid,name:st.properties.name||sid,lat:+c[1].toFixed(6),lng:+c[0].toFixed(6),
            tempC:g("temperature"),rh:g("relativeHumidity"),
            precip1h_mm:g("precipitationLastHour"),precip3h_mm:g("precipitationLast3Hours"),
            precip6h_mm:g("precipitationLast6Hours"),desc:o.textDescription||"",when:o.timestamp||""});
        }catch(e){}
      }
      busy(false); if(out.length)NOA=out;
    }catch(e){busy(false);}
    if(show.noaa)drawNoaa();
  }
  function drawNoaa(){
    noaaLayer.clearLayers();
    if(!show.noaa){if(map.hasLayer(noaaLayer))map.removeLayer(noaaLayer);return;}
    if(!map.hasLayer(noaaLayer))noaaLayer.addTo(map);
    if(!noaaTried){refreshNoaaLive();}
    NOA.forEach(s=>{
      if(s.lat==null||s.lng==null)return;
      if(!fcPass(s.lat,s.lng))return;   // forecast focus
      const p1=mm2in(s.precip1h_mm),p3=mm2in(s.precip3h_mm),p6=mm2in(s.precip6h_mm);
      const raining=(p1||p3||p6);
      const col=raining?"#1d4ed8":"#6d28d9";
      const m=L.marker([s.lat,s.lng],{icon:L.divIcon({className:"noaadiv",
        html:'<div class="noaapin" style="background:'+col+'" title="NOAA/NWS weather station">\u2601</div>',iconSize:[24,24],iconAnchor:[12,12]})});
      let html='<b>'+s.name+'</b><br><span style="color:#5d6b78">NOAA / NWS station '+s.id+'</span>';
      if(s.desc)html+='<br>'+s.desc;
      html+='<br><b>Precipitation</b>: '+(p1!=null?('last hr '+p1+' in'):'')+
            (p3!=null?((p1!=null?' \u00b7 ':'')+'3 hr '+p3+' in'):'')+
            (p6!=null?' \u00b7 6 hr '+p6+' in':'')+((p1==null&&p3==null&&p6==null)?'none reported':'');
      if(s.tempC!=null)html+='<br>Temp: '+Math.round(s.tempC*9/5+32)+'\u00b0F';
      if(s.rh!=null)html+='<br>Humidity: '+Math.round(s.rh)+'%';
      if(s.when)html+='<br><span style="color:#5d6b78">Observed '+stamp(Date.parse(s.when))+' ('+agoLabel(Date.parse(s.when))+')</span>';
      m.bindPopup(html,{maxWidth:250}); m.addTo(noaaLayer);
    });
  }
  // ---------- FEMA NFIP flood-insurance claims by ZIP (ZCTA choropleth) ----------
  const claimLayer=L.layerGroup();
  const CLAIMS=(typeof FEMA_CLAIMS!=="undefined")?FEMA_CLAIMS:[];
  // color ramp (OrRd) keyed to claim count
  function claimColor(n){
    if(!n)return "#f0f0f0";
    if(n<10)return "#fee5d9"; if(n<30)return "#fcae91"; if(n<80)return "#fb6a4a";
    if(n<200)return "#de2d26"; return "#a50f15";
  }
  function drawClaims(){
    claimLayer.clearLayers();
    const sub=document.getElementById("claimSubs");if(sub)sub.style.display=show.claims?"block":"none";
    if(!show.claims){if(map.hasLayer(claimLayer))map.removeLayer(claimLayer);return;}
    if(!map.hasLayer(claimLayer))claimLayer.addTo(map);
    CLAIMS.forEach(c=>{
      if(!c.geometry)return;
      // forecast focus: only show ZIP areas that overlap the selected circle
      if(focusActive()&&!geomIntersectsFocus(c.geometry))return;
      const gj={type:"Feature",properties:{},geometry:c.geometry};
      let html='<b>ZIP '+c.zip+'</b><br><span style="color:#5d6b78">FEMA NFIP flood-insurance claims</span>'+
        '<br><b>'+c.n.toLocaleString()+'</b> paid claim'+(c.n===1?"":"s")+
        (c.yrMin&&c.yrMax?' ('+c.yrMin+'\u2013'+c.yrMax+')':'');
      if(c.paid)html+='<br>Total paid: <b>$'+Number(c.paid).toLocaleString()+'</b>';
      if(c.avgDepthIn!=null){
        const d=c.avgDepthIn, above=d>=0;
        // little diagram: water level relative to the building's ground/first floor
        const diagram=
          '<div style="margin:5px 0;border:1px solid #e2e8f0;border-radius:6px;padding:5px 7px;background:#f8fafc;font-size:11px;line-height:1.4">'+
            '<div style="font-weight:600;color:#334155">Water vs. building floor</div>'+
            '<div>\uD83C\uDFE0 Building first floor = <b>0 in</b> (reference)</div>'+
            (above
              ? '<div style="color:#1d4ed8">\uD83C\uDF0A Avg flood reached <b>+'+d+' in ABOVE</b> the first floor</div>'
              : '<div style="color:#0f766e">\uD83C\uDF0A Avg flood stayed <b>'+Math.abs(d)+' in BELOW</b> the first floor (crawlspace/ground, not into the living floor)</div>')+
          '</div>';
        html+=diagram;
        html+='<span style="color:#94a3b8;font-size:11px">Average of all claims here over '+((c.yrMin&&c.yrMax)?(c.yrMin+'\u2013'+c.yrMax):'the record')+'. FEMA measures water depth relative to the building\u2019s first/lowest floor.</span>';
      }
      if(!c.n)html+='<br><span style="color:#5d6b78">No recorded claims</span>';
      html+='<br><span style="color:#94a3b8;font-size:11px">Shaded by <b>number of claims</b>. FEMA redacts exact locations; shown by ZIP.</span>';
      const poly=L.geoJSON(gj,{pane:"bndtop",   // bndtop is above the mask so it stays clickable
        style:{color:"#b91c1c",weight:1,opacity:.6,fillColor:claimColor(c.n),fillOpacity:c.n?0.55:0.12},
        onEachFeature:(ft,lyr)=>{
          lyr.bindTooltip(html,{sticky:true});
          lyr.bindPopup(html,{maxWidth:240});
          lyr.on("mouseover",()=>lyr.setStyle({weight:2.5,fillOpacity:c.n?0.7:0.2}));
          lyr.on("mouseout",()=>lyr.setStyle({weight:1,fillOpacity:c.n?0.55:0.12}));
        }});
      poly.addTo(claimLayer);
    });
  }
  // ---------- Historical flood likelihood (data-driven, LOCAL; 311 + rainfall; NO model) ----------
  const histLayer=L.layerGroup();
  const HCELLS=(typeof FLOODHIST_CELLS!=="undefined")?FLOODHIST_CELLS:null;
  const HPREC=(typeof FLOODHIST_PREC!=="undefined")?FLOODHIST_PREC:3;
  // pre-parse cell keys to numeric coords once (for fast local lookup)
  const _hcells=[];
  if(HCELLS){for(const k in HCELLS){const p=k.split(",");_hcells.push([+p[0],+p[1],HCELLS[k]]);}}
  // Pool the report-day rainfalls (tenths of an inch) from every cell within radMi of a point.
  // Returns {thr, med, n, dist} — the LOCAL rainfall threshold at which flooding reports start
  // right here, computed only from nearby 311 history (no big-area generalization).
  function histLocal(lat,lng,radMi){
    radMi=radMi||0.25;   // ~400 m default neighborhood around the point
    const cosL=Math.cos(lat*Math.PI/180);
    const rains=[]; let cells=0, nearest=1e9;
    for(const c of _hcells){
      const dx=(c[1]-lng)*cosL, dy=c[0]-lat;
      const mi=Math.sqrt(dx*dx+dy*dy)*69;
      if(mi<nearest)nearest=mi;
      if(mi<=radMi){cells++;for(const v of c[2])rains.push(v/10);}  // tenths -> inches
    }
    if(!rains.length)return {n:0,dist:nearest};
    rains.sort((a,b)=>a-b);
    const pct=(arr,p)=>{const i=(arr.length-1)*p/100,lo=Math.floor(i),hi=Math.ceil(i);
      return lo===hi?arr[lo]:arr[lo]+(arr[hi]-arr[lo])*(i-lo);};
    return {thr:+pct(rains,20).toFixed(2), med:+pct(rains,50).toFixed(2),
            n:rains.length, cells, dist:nearest};
  }
  // classify a LOCAL history record h against rainfall R (inches)
  function histClassLocal(h,R){
    if(!h||!h.n)return {k:"none",col:"#9aa7b3",
      txt:`No 311 flooded-street reports recorded within ~\u00bc mile of this point${h&&isFinite(h.dist)?` (nearest history \u2248 ${h.dist.toFixed(1)} mi away)`:""}.`};
    const conf=h.n>=8?"high":h.n>=3?"moderate":"low";
    if(R>=h.thr) return {k:"likely",col:"#b91c1c",
      txt:`<b>Likely.</b> This spot has flooded in <b>${h.n}</b> past rainstorm${h.n===1?"":"s"}; `+
          `reports here start around <b>${h.thr}&Prime; of rain</b> (median ${h.med}&Prime;), and your `+
          `${R.toFixed(1)}&Prime; forecast meets or exceeds that. Confidence: ${conf}.`};
    if(R>=h.thr-0.4) return {k:"possible",col:"#f59e0b",
      txt:`<b>Possible.</b> Local reports start around <b>${h.thr}&Prime;</b>; your ${R.toFixed(1)}&Prime; `+
          `forecast is close. Based on ${h.n} past event${h.n===1?"":"s"} near here. Confidence: ${conf}.`};
    return {k:"low",col:"#64748b",
      txt:`<b>Lower chance.</b> Past flooding right here needed about <b>${h.thr}&Prime;</b>; `+
          `your ${R.toFixed(1)}&Prime; forecast is below that. Based on ${h.n} past event${h.n===1?"":"s"} near here.`};
  }
  // short popup used by Pick-a-location / address when the Historical layer is on
  function histPointMsg(lat,lng){
    const R=curRainIn(), h=histLocal(lat,lng), cls=histClassLocal(h,R);
    return `<br><span style="color:#5d6b78">Historical flood likelihood (local 311 + rainfall)</span>`+
           `<br>For <b>${R.toFixed(1)}&Prime;</b> of rain: ${cls.txt}`;
  }
  // color each stored cell by its local trigger threshold (lower threshold = floods more easily)
  function histCellColor(thr){
    if(thr<=0.4)return "#b91c1c";   // floods at light rain
    if(thr<=0.8)return "#f59e0b";
    if(thr<=1.5)return "#eab308";
    return "#64748b";
  }
  function drawHist(){
    histLayer.clearLayers();
    const sub=document.getElementById("histSubs");if(sub)sub.style.display=show.hist?"block":"none";
    if(!show.hist){if(map.hasLayer(histLayer))map.removeLayer(histLayer);return;}
    if(!map.hasLayer(histLayer))histLayer.addTo(map);
    if(!HCELLS){toast("Historical flood data not built yet (run _make_floodhist.py).");return;}
    const R=curRainIn();
    // Draw each local history cell as a small dot sized by how often it floods and colored by
    // its LOCAL threshold. This shows real, street-level evidence — not a big shaded blob.
    _hcells.forEach(c=>{
      const lat=c[0],lng=c[1],rl=c[2];
      if(!inBeltway(lat,lng))return;
      if(focusActive()&&!inFocus(lat,lng))return;          // focus clip
      const h=histLocal(lat,lng,0.12);                     // tight pool for this cell
      const cls=histClassLocal(h,R);
      const n=rl.length;
      const rad=Math.min(10,3+Math.sqrt(n));               // more report-days = bigger dot
      // dot color = the rainfall this spot needs to flood (its local threshold); the
      // Likely/Possible/Lower verdict vs the current rainfall is in the popup text
      const thr=h.thr!=null?h.thr:(rl[Math.floor(rl.length*0.2)]/10);
      const dotCol=histCellColor(thr);
      // ring the dots that your current rainfall would trigger, so "likely" spots stand out
      const ring=(cls.k==="likely")?"#111":"#ffffff";
      const html=`<b>Historical flood spot</b><br><span style="color:#5d6b78">Local 311 flooded-street history</span>`+
        `<br>${n} past rainstorm${n===1?"":"s"} flooded within ~110 m here; flooding starts around <b>${thr.toFixed(2)}&Prime;</b>.`+
        `<br>For <b>${R.toFixed(1)}&Prime;</b> of rain (${MODE.cur==="forecast"?"forecast":"design storm"}): ${cls.txt}`+
        `<div style="margin-top:4px;font-size:10px;color:#94a3b8">Open Baltimore 311 (2010\u2013present) + BWI rainfall. Reporting-biased; not a hydraulic model.</div>`;
      const m=L.circleMarker([lat,lng],{pane:"bndtop",radius:rad,
        color:ring,weight:cls.k==="likely"?2:1,fillColor:dotCol,
        fillOpacity:0.82});
      m.bindTooltip(html,{sticky:true});m.bindPopup(html,{maxWidth:250});
      m.addTo(histLayer);
    });
  }
  const newsLayer=L.layerGroup();
  function drawNews(){ if(map.hasLayer(newsLayer))map.removeLayer(newsLayer); } // News layer retired (folded into Social)
  const rclLayer=L.layerGroup();
  function drawClosures(){
    rclLayer.clearLayers();
    if(!show.closures){if(map.hasLayer(rclLayer))map.removeLayer(rclLayer);return;}
    if(!map.hasLayer(rclLayer))rclLayer.addTo(map);
    RCL.forEach(r=>{
      if(!fcPass(r.lat,r.lng))return;   // forecast focus
      const m=L.marker([r.lat,r.lng],{icon:L.divIcon({className:"rcldiv",
        html:'<div class="rclpin" title="Flood-related road closure">\u26D4</div>',iconSize:[20,20],iconAnchor:[10,10]})});
      m.bindPopup('<b>'+(r.name||"Road closure")+'</b><br><span style="color:#5d6b78">Known City flood-related road closure</span>');
      m.addTo(rclLayer);
    });
  }

  // ---------- controls ----------
  function seg(id,key,cast){document.querySelectorAll("#"+id+" button").forEach(b=>b.onclick=()=>{
    document.querySelectorAll("#"+id+" button").forEach(x=>x.classList.remove("on"));
    b.classList.add("on");S[key]=cast(b.dataset[key]);refresh();});}
  seg("rp","rp",Number);seg("dur","dur",Number);seg("cond","cond",String);

  // ----- Forecast mode wiring (shares every downstream feature via scenKey/depthScale) -----
  // rainfall-only depth ratio (excludes the animation factor, for display)
  function fcRainScale(){const n=fcNearest(); let s=n.base>0?FC.rain/n.base:1;
    if(s<0)s=0; if(s>2.5)s=2.5; return s;}
  function fcFocusText(){
    if(FC.lat==null||!(FC.rad>0))return "whole Beltway";
    return "within "+FC.rad+" mi"+(FC.rad==1?"":"")+" of the chosen location";
  }
  function updateForecastNote(){
    const el=document.getElementById("fcNote"); if(!el)return;
    const loc=document.getElementById("fcLoc");
    if(loc)loc.textContent=(FC.lat==null)
      ? "No location chosen — forecast covers the whole Beltway."
      : "Focused on "+(FC._name||(FC.lat.toFixed(4)+", "+FC.lng.toFixed(4)))+" ("+fcFocusText()+").";
    if(MODE.cur!=="forecast"){el.textContent="";return;}
    const n=fcNearest(), sc=fcRainScale();
    el.innerHTML="Nearest CityCAT run: <b>"+n.rp+"-yr "+FC.dur+"-hr</b> ("+n.base+" in). "+
      "Depths scaled \u00d7<b>"+sc.toFixed(2)+"</b> to your "+FC.rain.toFixed(1)+" in"+
      (sc>=2.5?" (capped)":"")+". <span style=\"color:#94a3b8\">Pluvial demo \u2014 snaps to the pre-run library.</span>";
  }
  function setMode(m){
    MODE.cur=m;
    document.querySelectorAll("#floodMode button").forEach(x=>x.classList.toggle("on",x.dataset.mode===m));
    const dp=document.getElementById("designPanel"), fp=document.getElementById("forecastPanel");
    if(dp)dp.style.display=(m==="design")?"block":"none";
    if(fp)fp.style.display=(m==="forecast")?"block":"none";
    if(m!=="forecast"){clearFocusView();}
    if(m==="forecast"&&typeof fcSetDirty==="function")fcSetDirty(false);  // start clean
    updateForecastNote();
    // changing scenario invalidates cached per-area stats keys automatically (keys include mode)
    refresh();
    if(m==="forecast"&&FC.lat!=null&&FC.rad>0)map.setView([FC.lat,FC.lng],14);
  }
  document.querySelectorAll("#floodMode button").forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
  // set/replace the forecast focus point (called by address search + pick-a-location)
  function setForecastFocus(lat,lng,name){
    FC.lat=lat; FC.lng=lng; FC._name=name||null;
    updateForecastNote();
    if(MODE.cur==="forecast"){refresh(); if(FC.rad>0)map.setView([lat,lng],14);}
  }
  // mark the rainfall/duration as changed-but-not-applied (the map updates on "Show flood results")
  let fcDirty=false;
  function fcSetDirty(on){
    fcDirty=on;
    const p=document.getElementById("fcPending"); if(p)p.style.display=on?"block":"none";
    const btn=document.getElementById("fcRun");
    if(btn)btn.style.background=on?"#b4690a":"#0f3d5c";
  }
  // update the rainfall value + inputs, but DON'T redraw the map (wait for the apply button)
  function setFcRain(v){
    v=Math.max(0,Math.min(12,(+v)||0)); FC.rain=v;
    const num=document.getElementById("fcRain"), rng=document.getElementById("fcRainRange");
    if(num&&+num.value!==v)num.value=v;
    if(rng&&+rng.value!==v)rng.value=Math.min(10,v);
    updateForecastNote(); fcSetDirty(true);
  }
  // apply the current forecast rainfall/duration to the map
  function runForecast(){
    FC.animT=1;                               // show full result (reset any animation)
    const fa=document.getElementById("fcAnim"); if(fa)fa.value=100;
    const fan=document.getElementById("fcAnimNote"); if(fan)fan.textContent="Showing the modeled maximum (100%).";
    fcSetDirty(false); updateForecastNote(); refresh();
    if(FC.lat!=null&&FC.rad>0)map.setView([FC.lat,FC.lng],FC.rad<=0.5?15:FC.rad<=1?14:13);
  }
  (function(){
    const num=document.getElementById("fcRain"), rng=document.getElementById("fcRainRange");
    if(num)num.addEventListener("input",()=>setFcRain(num.value));
    if(rng)rng.addEventListener("input",()=>setFcRain(rng.value));
    const runBtn=document.getElementById("fcRun"); if(runBtn)runBtn.onclick=runForecast;
    document.querySelectorAll("#fcDur button").forEach(b=>b.onclick=()=>{
      document.querySelectorAll("#fcDur button").forEach(x=>x.classList.remove("on"));
      b.classList.add("on"); FC.dur=Number(b.dataset.fcdur); updateForecastNote(); fcSetDirty(true);});
    // focus radius (½/1/2 mi, or Beltway=0)
    document.querySelectorAll("#fcRad button").forEach(b=>b.onclick=()=>{
      document.querySelectorAll("#fcRad button").forEach(x=>x.classList.remove("on"));
      b.classList.add("on"); FC.rad=Number(b.dataset.rad);
      updateForecastNote(); refresh();
      if(FC.rad>0&&FC.lat!=null)map.setView([FC.lat,FC.lng],FC.rad<=0.5?15:FC.rad<=1?14:13);
      else map.fitBounds(beltwayBounds);
    });
  })();

  // ----- Water build-up animation (illustrative: scales depths 0..max over the storm) -----
  let fcAnimTimer=null;
  function fcSetAnim(pct){
    FC.animT=Math.max(0,Math.min(1,pct/100));
    const note=document.getElementById("fcAnimNote");
    if(note)note.textContent=(pct>=100)
      ? "Showing the modeled maximum (100%)."
      : "Showing \u2248 "+Math.round(pct)+"% of the way to the modeled maximum over the "+FC.dur+"-hr storm.";
    updateFlood();               // redraw flood raster + buildings/roads at this water level
    if(lastA)drawVectors(lastA); // recolor infrastructure markers at this level
    updateBriefing();            // keep the headline counts in sync with the animation
  }
  function fcStopAnim(){
    if(fcAnimTimer){clearInterval(fcAnimTimer);fcAnimTimer=null;}
    const btn=document.getElementById("fcPlay"); if(btn)btn.innerHTML="\u25B6 Play";
  }
  function fcPlayAnim(){
    const rng=document.getElementById("fcAnim"), btn=document.getElementById("fcPlay");
    if(fcAnimTimer){fcStopAnim();return;}
    if(btn)btn.innerHTML="\u2759\u2759 Pause";
    let v=0; if(rng)rng.value=0; fcSetAnim(0);
    // longer storms play a touch slower so 1-hr vs 24-hr read differently
    const stepMs=FC.dur>=24?230:150;
    fcAnimTimer=setInterval(()=>{v+=5; if(v>=100){v=100;}
      if(rng)rng.value=v; fcSetAnim(v);
      if(v>=100)fcStopAnim();},stepMs);
  }
  (function(){
    const rng=document.getElementById("fcAnim"), btn=document.getElementById("fcPlay");
    if(rng)rng.addEventListener("input",()=>{fcStopAnim();fcSetAnim(+rng.value);});
    if(btn)btn.onclick=fcPlayAnim;
  })();

  document.querySelectorAll("#bmCtl .bmopt").forEach(b=>b.onclick=()=>{
    document.querySelectorAll("#bmCtl .bmopt").forEach(x=>x.classList.remove("on"));
    b.classList.add("on");setBasemap(b.dataset.bm);});

  // Layers, Legend and Emergency-facility panels are collapsed by default. CLICK a
  // header to open that panel; it STAYS open until the user clicks another panel,
  // which closes the previous one (accordion). Clicking the open panel closes it.
  const _panels=[];
  function syncChevrons(){
    _panels.forEach(x=>{const cv=x.querySelector(".panchev");
      if(cv)cv.textContent=x.classList.contains("pinopen")?"\u25BE":"\u25B8";});
  }
  function hoverPanel(panelId,headId,openByDefault){
    const p=document.getElementById(panelId),h=document.getElementById(headId);
    if(!p||!h)return;
    p.classList.add("hoverpanel");            // collapsible via CSS
    if(openByDefault)p.classList.add("pinopen");   // start expanded
    _panels.push(p);
    // independent toggle (each panel opens/closes on its own; others stay as they are)
    h.addEventListener("click",ev=>{ if(ev.target.closest(".info")||ev.target.id==="facToggle")return;
      p.classList.toggle("pinopen");
      syncChevrons();
    });
  }
  hoverPanel("lpanel","lpToggle",true);    // Layers open by default
  hoverPanel("legend","legToggle",false);  // Legend hidden; opens when the user clicks it
  hoverPanel("side","sideToggle",false);   // facility panel stays collapsed until clicked
  syncChevrons();

  // point-data sources per layer key, so we can tell if a layer has anything in the focus
  function layerPoints(k){
    switch(k){
      case "reports": return REP;
      case "social":  return [].concat(SOC||[],YT||[]);
      case "mycoast": return MYC;
      case "closures":return RCL;
      case "cameras": return CAM;
      case "weather": return WX;
      case "usgs":    return USG;
      case "noaa":    return NOA;
      case "fl311":   return (LIVE.fl311&&LIVE.fl311.features)?LIVE.fl311.features.map(f=>({lat:f.geometry.coordinates[1],lng:f.geometry.coordinates[0]})):null;
      case "wb311":   return (LIVE.wb311&&LIVE.wb311.features)?LIVE.wb311.features.map(f=>({lat:f.geometry.coordinates[1],lng:f.geometry.coordinates[0]})):null;
      default: return undefined;   // not a point layer we gate
    }
  }
  const LAYER_LABEL={reports:"Validated flood photos",social:"Social media & newsletter reports",
    mycoast:"MyCoast reports",closures:"Flood-related road closures",cameras:"Live traffic cameras",
    weather:"CHART weather stations",usgs:"USGS stream gauges",noaa:"NOAA/NWS stations",
    claims:"Flood-insurance claims",fl311:"311 flooded-street reports",wb311:"311 water-in-basement reports",
    streams:"Streams",streamGrid:"StreamStats grid",landcover:"Land cover",soil:"Soil groups",fema:"FEMA flood hazard"};
  // after a layer is turned on with a forecast focus active, warn if nothing is in the area
  function checkLayerInFocus(k){
    if(!focusActive()||!show[k])return;
    const pts=layerPoints(k);
    if(pts===undefined)return;                 // raster/other layer — skip the point check
    const run=()=>{const arr=layerPoints(k);
      if(!arr){setTimeout(run,700);return;}    // data still loading — re-check shortly
      const any=arr.some(p=>p&&p.lat!=null&&inFocus(p.lat,p.lng));
      if(!any)toast((LAYER_LABEL[k]||"This layer")+": none found in the selected area.");};
    setTimeout(run,300);
  }
  function lyr(id,k,fn){document.getElementById(id).onchange=e=>{show[k]=e.target.checked;fn();
    if(e.target.checked)checkLayerInFocus(k);};}
  lyr("lFlood","flood",()=>{updateFlood();if(lastA)drawVectors(lastA);});
  lyr("lFema","fema",drawFema);
  lyr("lRoads","roads",()=>{if(show.roads&&!roadFlood)loadFloodRoads();renderRoads();fetchViewRoads();});
  // building-click hint: show while Buildings is on and the user hasn't opened a building popup yet
  let _bldHintDone=false;
  function updateBldgHint(){
    const el=document.getElementById("bldgHint"); if(!el)return;
    el.style.display=(show.bldg&&!_bldHintDone)?"block":"none";
  }
  function dismissBldgHint(){_bldHintDone=true;updateBldgHint();}
  lyr("lBldg","bldg",()=>{if(show.bldg&&!bldFlood)loadFloodBuildings();renderBld();fetchViewBld();updateBldgHint();});
  lyr("lNb","nb",drawBoundaries);
  lyr("lWs","ws",()=>{if(show.ws)loadWsPop();drawBoundaries();});
  lyr("lStreams","streams",drawStreams);
  lyr("lStreamGrid","streamGrid",drawStreamGrid);
  lyr("lLand","landcover",drawLandcover);
  lyr("lSoil","soil",drawSoil);
  lyr("l311fl","fl311",()=>draw311("fl311"));
  lyr("l311wb","wb311",()=>draw311("wb311"));
  lyr("lReports","reports",drawReports);
  lyr("lSocial","social",drawSocial);
  lyr("lMyCoast","mycoast",drawMyCoast);
  lyr("lClosures","closures",drawClosures);
  lyr("lCameras","cameras",drawCameras);
  lyr("lWeather","weather",drawWeather);
  lyr("lUsgs","usgs",drawUsgs);
  lyr("lNoaa","noaa",drawNoaa);
  lyr("lClaims","claims",drawClaims);
  lyr("lHist","hist",drawHist);
  lyr("lInfra","infra",()=>{
    document.getElementById("infraSubs").style.display=show.infra?"block":"none";
    if(lastA)drawVectors(lastA);});
  document.querySelectorAll("#infraSubs input").forEach(cb=>cb.onchange=()=>{
    inf[cb.dataset.inf]=cb.checked;if(lastA)drawVectors(lastA);});
  document.getElementById("choroSel").onchange=e=>{choroMetric=e.target.value;drawChoro();};

  map.on("moveend zoomend",()=>{scheduleBld();scheduleBus();scheduleRoads();});

  // ---------- address search ----------
  let addrMarker=null;
  // Local gazetteer built from every known report / social / closure location so
  // town and street names in the tool resolve instantly even when the online
  // geocoder is rate-limited, down, or doesn't recognize an informal name.
  const LOCAL_GAZ=(function(){
    const g={};
    const norm=s=>String(s||"").toLowerCase().replace(/[^a-z0-9 ]+/g," ").replace(/\s+/g," ").trim();
    [].concat(REP,SOC,YT,MYC,RCL).forEach(r=>{
      if(!r||r.lat==null||r.lng==null)return;
      const k=norm(r.name); if(k&&!g[k])g[k]={lat:r.lat,lng:r.lng,name:r.name};
    });
    // a few common town / place aliases users may type
    const extra={
      "ellicott city":[39.2673,-76.7983],"main street ellicott city":[39.2673,-76.7983],
      "glen burnie":[39.1626,-76.6247],"laurel":[39.0993,-76.8483],"laurel md":[39.0993,-76.8483],
      "fells point":[39.2820,-76.5930],"towson":[39.4015,-76.6019],"catonsville":[39.2720,-76.7319],
      "oella":[39.2735,-76.7830],"dundalk":[39.2506,-76.5205],"parkville":[39.3782,-76.5397],
      "essex":[39.3090,-76.4750],"pikesville":[39.3743,-76.7225],"woodlawn":[39.3223,-76.7280],
      "linthicum heights":[39.2065,-76.6650],"joppatowne":[39.4140,-76.3484],"joppa":[39.4205,-76.3550],
      "edgewood":[39.4209,-76.2902],"white marsh":[39.3837,-76.4511],"owings mills":[39.4196,-76.7802],
      "randallstown":[39.3673,-76.7953],"silver spring":[39.0040,-77.0197],"timonium":[39.4390,-76.6470],
      "hampden":[39.3311,-76.6326],"federal hill":[39.2799,-76.6127],"canton":[39.2820,-76.5760],
      "highlandtown":[39.2886,-76.5683],"pigtown":[39.2830,-76.6288],"mount washington":[39.3699,-76.6492]
    };
    Object.keys(extra).forEach(k=>{if(!g[k])g[k]={lat:extra[k][0],lng:extra[k][1],name:k.replace(/\b\w/g,c=>c.toUpperCase())};});
    return {map:g,norm};
  })();
  function localGeocode(q){
    const k=LOCAL_GAZ.norm(q); if(!k)return null;
    if(LOCAL_GAZ.map[k])return LOCAL_GAZ.map[k];
    // partial / contains match (e.g. user types "Thames" -> "Thames St")
    let best=null;
    for(const key in LOCAL_GAZ.map){
      if(key===k)continue;
      if(key.indexOf(k)>=0||k.indexOf(key)>=0){
        if(!best||Math.abs(key.length-k.length)<Math.abs(best.k.length-k.length))best={k:key,v:LOCAL_GAZ.map[key]};
      }
    }
    return best?best.v:null;
  }
  function showAddrResult(lat,lng,nm,fromLocal){
    if(addrMarker)map.removeLayer(addrMarker);addrMarker=L.marker([lat,lng]).addTo(map);map.setView([lat,lng],16);
    // in forecast mode, an address also sets the focus the results center on
    if(MODE.cur==="forecast")setForecastFocus(lat,lng,nm);
    if(!inBox(lat,lng)){addrMarker.bindPopup("<b>"+nm+"</b><br>Outside the modeled flood extent (study area is the Baltimore Beltway)."+(fromLocal?"<br><span style='color:#5d6b78'>Matched from known flood-report locations.</span>":"")).openPopup();return;}
    addrMarker.bindPopup(floodPointMsg(lat,lng,nm)).openPopup();
  }
  // shared flood message for a point — uses EXACT cell depth (matches the blue water &
  // building shading, so a pin never says "flooded" where no water is drawn). In forecast
  // mode the wording is a "possibility of flooding" (not a deterministic model statement).
  function floodPointMsg(lat,lng,nm){
    const d=depthLL(lat,lng);                 // exact cell, same as the water raster
    const head=nm?("<b>"+nm+"</b><br>"):"";
    const forecast=(MODE.cur==="forecast");
    // the local historical-likelihood line is appended whenever the Historical layer is on
    const hx=(show.hist?histPointMsg(lat,lng):"");
    if(d>=0.10){
      const verb=forecast?"<b>Possibility of flooding</b>":"<b>Flooded</b>";
      return head+verb+" here in the "+scenLabel()+" ("+d.toFixed(2)+" m / "+(d*3.281).toFixed(1)+" ft)."+(show.flood?"":" Turn on the Floodwater layer to see it.")+hx;
    }
    const verb=forecast?"<b>Low / no</b> modeled flooding":"<b>Not flooded</b>";
    return head+verb+" at this point in the "+scenLabel()+"."+hx;
  }
  async function findAddress(){const q=document.getElementById("addrInput").value.trim();if(!q)return;
    const btn=document.getElementById("addrBtn"),old=btn.textContent;btn.textContent="...";btn.disabled=true;
    try{
      let a=null;
      // more suffixes covering all counties in / around the study area
      const suffixes=[", Baltimore, MD",", Baltimore County, MD",", Howard County, MD",
        ", Anne Arundel County, MD",", Harford County, MD",", Ellicott City, MD",
        ", Maryland",", MD",""];
      for(const sfx of suffixes){
        const url="https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q="+encodeURIComponent(q+sfx);
        try{const r=await fetch(url); const j=await r.json();
          if(j&&j.length){const la=+j[0].lat,lo=+j[0].lon;
            // widened accept box: includes Ellicott City, Laurel, Silver Spring, Harford Co.
            if(la>38.8&&la<39.75&&lo>-77.25&&lo<-76.05){a=j;break;}}
        }catch(_){}
      }
      if(a&&a.length){
        const lat=+a[0].lat,lng=+a[0].lon,nm=a[0].display_name.split(",").slice(0,2).join(",");
        showAddrResult(lat,lng,nm,false);return;
      }
      // online failed / rate-limited / out of box -> try the local gazetteer
      const loc=localGeocode(q);
      if(loc){showAddrResult(loc.lat,loc.lng,loc.name,true);return;}
      alert("Address or place not found near Baltimore. Try a fuller address (e.g. '1900 Thames St'), a nearby town name (e.g. 'Ellicott City'), or check your spelling.");
    }catch(e){
      const loc=localGeocode(q);
      if(loc){showAddrResult(loc.lat,loc.lng,loc.name,true);}
      else alert("Could not look up the address. The online search needs an internet connection — try a known town or street name.");
    }
    finally{btn.textContent=old;btn.disabled=false;}}
  document.getElementById("addrBtn").onclick=findAddress;
  document.getElementById("addrInput").addEventListener("keydown",e=>{if(e.key==="Enter")findAddress();});

  // ----- pick-a-location flood check -----
  let pickMode=false, pickMarker=null;
  const pickBtn=document.getElementById("pickBtn");
  if(pickBtn)pickBtn.onclick=()=>{pickMode=!pickMode;pickBtn.classList.toggle("on",pickMode);
    document.getElementById("map").style.cursor=pickMode?"crosshair":"";};
  map.on("click",e=>{
    if(!pickMode)return;
    const lat=e.latlng.lat,lng=e.latlng.lng;
    if(pickMarker)map.removeLayer(pickMarker);
    pickMarker=L.marker([lat,lng]).addTo(map);
    // in forecast mode, the picked point also becomes the focus the results center on
    if(MODE.cur==="forecast")setForecastFocus(lat,lng,"the picked point");
    let msg;
    if(!inBox(lat,lng))msg="This point is outside the modeled flood extent.";
    else{msg=floodPointMsg(lat,lng,null);
      if(!show.flood&&depthLL(lat,lng)>=0.10)msg+=" (Turn on the Floodwater layer to see it on the map.)";}
    pickMarker.bindPopup(msg).openPopup();
  });
  // ----- building-detail + basement-risk on map click (reliable fallback for the canvas
  // footprints: find the nearest loaded building to the click and open its detail popup) -----
  function nearestBuilding(lat,lng){
    const cosL=Math.cos(lat*Math.PI/180); let best=null,bd=1e9;
    const scan=g=>{if(!g||!g.features)return;for(const f of g.features){const ct=fCentroid(f);if(!ct)continue;
      const dx=(ct[1]-lng)*cosL,dy=ct[0]-lat,mi=Math.sqrt(dx*dx+dy*dy)*69;
      if(mi<bd){bd=mi;best={f,ctr:ct};}}};
    scan(bldFlood);scan(bldView);
    return (best&&bd<=0.06)?best:null;   // within ~100 m of a loaded footprint
  }
  map.on("click",e=>{
    if(pickMode)return;                 // pick-a-location handled above
    if(!show.bldg)return;               // only when Buildings layer is on
    const lat=e.latlng.lat,lng=e.latlng.lng;
    const nb=nearestBuilding(lat,lng); if(!nb)return;
    if(typeof dismissBldgHint==="function")dismissBldgHint();
    const ctr=nb.ctr, dep=(show.flood?buildingFloodDepth(nb.f):0);  // shared strict footprint test
    const pop=L.popup({maxWidth:270}).setLatLng([ctr[0],ctr[1]])
      .setContent("Loading building details\u2026").openOn(map);
    buildingPopupHTML(ctr[0],ctr[1],dep)
      .then(html=>pop.setContent(html))
      .catch(()=>pop.setContent('<b>Building</b><br>Street flood depth: '+(dep*39.3701).toFixed(1)+
        ' in.<br><span style="color:#b45309">Could not load full details (needs internet).</span>'));
  });
  // ----- clear button: address marker, picked point, and any selected area -----
  const clearBtn=document.getElementById("clearBtn");
  if(clearBtn)clearBtn.onclick=()=>{
    if(addrMarker){map.removeLayer(addrMarker);addrMarker=null;}
    if(pickMarker){map.removeLayer(pickMarker);pickMarker=null;}
    if(selLayer&&selReset){try{selLayer.setStyle(selReset);}catch(e){}selLayer=null;selReset=null;}
    document.getElementById("addrInput").value="";
    pickMode=false;if(pickBtn)pickBtn.classList.remove("on");document.getElementById("map").style.cursor="";
    // also clear the forecast focus + animation so results go back to the whole Beltway
    FC.lat=null;FC.lng=null;FC._name=null;FC.animT=1;
    if(typeof fcStopAnim==="function")fcStopAnim();
    const fa=document.getElementById("fcAnim");if(fa)fa.value=100;
    const fan=document.getElementById("fcAnimNote");if(fan)fan.textContent="Showing the modeled maximum (100%).";
    clearFocusView();updateForecastNote();
    if(MODE.cur==="forecast")refresh();
  };
  // Emergency facility panel: show-all toggle
  const facToggle=document.getElementById("facToggle");
  if(facToggle)facToggle.onclick=(e)=>{e.stopPropagation();   // don't collapse the panel
    facShowAll=!facShowAll;
    facToggle.textContent=facShowAll?"Show flooded only ▴":"Show all ▾";
    refresh();};   // always re-render the facility list

  // welcome portal
  (function(){const wa=document.getElementById("wAccept");
    if(wa)wa.onclick=()=>{document.getElementById("welcome").classList.remove("on");};})();

  // welcome close button (in addition to Accept)
  (function(){const wc=document.getElementById("wClose");
    if(wc)wc.onclick=()=>{document.getElementById("welcome").classList.remove("on");};})();

  refresh();
  buildClip();   // clip the data panes to the irregular Beltway boundary
  // NOTE: the full-screen mask was removed so the base map stays visible everywhere,
  // with the Beltway boundary drawn as an overlay and the data shown within it.
  loadFemaZones();   // preload FEMA hazard zones so buildings color by severity
  loadLive();
  loadFloodBuildings();
  loadFloodRoads();
  loadAllBus();   // preload bus stops so the briefing can count flooded ones
  if(typeof updateBldgHint==="function")updateBldgHint();   // show the "click a building" hint
  setTimeout(()=>map.invalidateSize(),200);
  window.addEventListener("resize",()=>map.invalidateSize());
})();
