/* FloodLens Baltimore — FORECAST PROTOTYPE (demo).
   Standalone; does not touch the production app.js. Reuses the real CityCAT
   design-storm depth grids in data/flood.js. All depths shown in INCHES. */
(function(){
  "use strict";
  const M_TO_IN = 39.3701;
  // ----- study area + depth grid (from data/flood.js) -----
  const FB = (typeof FLOOD_BOUNDS!=="undefined")?FLOOD_BOUNDS:[[39.106,-76.905],[39.510,-76.274]];
  const latBot=FB[0][0], lngL=FB[0][1], latTop=FB[1][0], lngR=FB[1][1];
  const GW=(typeof FLOOD_GW!=="undefined")?FLOOD_GW:1, GH=(typeof FLOOD_GH!=="undefined")?FLOOD_GH:1;
  const MERC=(typeof FLOOD_MERC!=="undefined")?FLOOD_MERC:null;
  const RAIN={10:{1:2.1,24:4.9},100:{1:3.3,24:8.3}}; // NOAA Atlas 14 inches for the 4 CityCAT runs
  function projY(lat){return 6378137*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));}
  function cellAt(lat,lng){
    let nx,ny;
    if(MERC){const mx=6378137*lng*Math.PI/180,my=projY(lat);
      nx=(mx-MERC[0])/(MERC[2]-MERC[0]); ny=(MERC[3]-my)/(MERC[3]-MERC[1]);}
    else {nx=(lng-lngL)/(lngR-lngL); ny=(latTop-lat)/(latTop-latBot);}
    if(nx<0||nx>1||ny<0||ny>1)return null;
    let cx=Math.round(nx*(GW-1)), cy=Math.round(ny*(GH-1));
    if(cx<0)cx=0; if(cx>=GW)cx=GW-1; if(cy<0)cy=0; if(cy>=GH)cy=GH-1;
    return {cx,cy};
  }
  function depthM(grid,lat,lng){           // metres at lat/lng for a given grid
    const c=cellAt(lat,lng); if(!c)return 0;
    return (grid[c.cy*GW+c.cx]||0)/100;    // grid stores cm
  }
  // like cellAt but CLAMPS to the grid edge instead of returning null, so the exact
  // study-area corners (used by the "Beltway" focus) always resolve to a valid cell
  function cellClamp(lat,lng){
    let nx,ny;
    if(MERC){const mx=6378137*lng*Math.PI/180,my=projY(lat);
      nx=(mx-MERC[0])/(MERC[2]-MERC[0]); ny=(MERC[3]-my)/(MERC[3]-MERC[1]);}
    else {nx=(lng-lngL)/(lngR-lngL); ny=(latTop-lat)/(latTop-latBot);}
    nx=Math.min(1,Math.max(0,nx)); ny=Math.min(1,Math.max(0,ny));
    return {cx:Math.round(nx*(GW-1)), cy:Math.round(ny*(GH-1))};
  }

  // ----- state -----
  const state={lat:39.2866,lng:-76.6130,rain:2.0,dur:1,rad:1,scale:1,animT:1};
  let loc=null;        // {rp,dur,grid,label,scale}

  // ----- map -----
  const map=L.map("map",{preferCanvas:true}).setView([39.30,-76.61],12);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    {maxZoom:19,maxNativeZoom:16,attribution:"Esri, HERE, Garmin"}).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
    {maxZoom:19,maxNativeZoom:19,pane:"overlayPane"}).addTo(map);
  const floodCanvas=L.canvas({padding:0.5});
  const floodLayer=L.layerGroup().addTo(map);
  let marker=null, ring=null, picking=false;

  // ----- rainfall -> nearest CityCAT scenario (with linear scale factor) -----
  function matchScenario(rainIn,dur){
    // choose the two runs for this duration (10-yr and 100-yr), pick nearest, scale depth
    const r10=RAIN[10][dur], r100=RAIN[100][dur];
    const g10=FLOOD_DEPTH["10_"+dur], g100=FLOOD_DEPTH["100_"+dur];
    // nearest by rainfall amount
    let rp,grid,baseRain;
    if(Math.abs(rainIn-r10)<=Math.abs(rainIn-r100)){rp=10;grid=g10;baseRain=r10;}
    else {rp=100;grid=g100;baseRain=r100;}
    // illustrative depth scale: how the entered rainfall compares to that run's rainfall
    // (clamped; this is a DEMO approximation, not a new CityCAT run)
    let scale=rainIn/baseRain; if(scale<0)scale=0; if(scale>2.5)scale=2.5;
    return {rp,dur,grid,baseRain,scale,
      label:rainIn.toFixed(1)+" in / "+dur+" h \u2192 nearest CityCAT run: "+rp+"-yr "+dur+"-h ("+baseRain+" in)"};
  }

  // ----- depth -> color (inches) -----
  function depthColor(inch){
    if(inch<1.5)return null;               // essentially dry
    if(inch<4)return "#c6dbef";
    if(inch<12)return "#4292c6";
    if(inch<36)return "#08519c";
    return "#08306b";
  }

  // ----- render flooded cells as small rectangles within the focus area -----
  function miToDeg(mi){return mi/69;}      // ~69 miles per degree lat
  function renderFlood(){
    floodLayer.clearLayers();
    if(!loc)return;
    const grid=loc.grid; if(!grid)return;
    const scale=loc.scale*state.animT;     // animation scales toward max
    // focus window
    let w,s,e,n;
    if(state.rad>0){
      const dLat=miToDeg(state.rad), dLng=dLat/Math.cos(state.lat*Math.PI/180);
      w=state.lng-dLng; e=state.lng+dLng; s=state.lat-dLat; n=state.lat+dLat;
    } else { w=lngL; e=lngR; s=latBot; n=latTop; }
    // iterate grid cells overlapping the window (coarsen for speed)
    // use the edge-clamping lookup so the exact study-area corners (Beltway focus)
    // never fall just outside [0,1] and abort the whole render
    const c0=cellClamp(n,w), c1=cellClamp(s,e);
    const xMin=Math.max(0,Math.min(c0.cx,c1.cx)), xMax=Math.min(GW-1,Math.max(c0.cx,c1.cx));
    const yMin=Math.max(0,Math.min(c0.cy,c1.cy)), yMax=Math.min(GH-1,Math.max(c0.cy,c1.cy));
    // adaptive coarsening: cap total drawn cells (~18k) so the whole Beltway renders fast
    const span=Math.max(1,(xMax-xMin));
    const step=Math.max(1,Math.ceil(span/170));
    const cellW=(lngR-lngL)/(GW-1), cellH=(latTop-latBot)/(GH-1);
    let wet=0, maxIn=0;
    for(let y=yMin;y<=yMax;y+=step)for(let x=xMin;x<=xMax;x+=step){
      const raw=(grid[y*GW+x]||0)/100; if(raw<=0)continue;
      const inch=raw*M_TO_IN*scale;
      const col=depthColor(inch); if(!col)continue;
      // cell center back to lat/lng (approx; linear mapping is fine at this zoom)
      let clat,clng;
      if(MERC){
        const mx=MERC[0]+(x/(GW-1))*(MERC[2]-MERC[0]);
        const my=MERC[3]-(y/(GH-1))*(MERC[3]-MERC[1]);
        clng=mx/6378137*180/Math.PI;
        clat=(2*Math.atan(Math.exp(my/6378137))-Math.PI/2)*180/Math.PI;
      } else { clng=lngL+x*cellW; clat=latTop-y*cellH; }
      if(state.rad>0){ // circular focus
        const dx=(clng-state.lng)*Math.cos(state.lat*Math.PI/180), dy=clat-state.lat;
        if(Math.sqrt(dx*dx+dy*dy)>miToDeg(state.rad))continue;
      }
      wet++; if(inch>maxIn)maxIn=inch;
      L.rectangle([[clat-cellH*step/2,clng-cellW*step/2],[clat+cellH*step/2,clng+cellW*step/2]],
        {renderer:floodCanvas,stroke:false,fillColor:col,fillOpacity:0.62,interactive:false}).addTo(floodLayer);
    }
    return {wet,maxIn};
  }

  // ----- geocode (Nominatim) -----
  async function geocode(q){
    const url="https://nominatim.openstreetmap.org/search?format=json&limit=1&q="+encodeURIComponent(q+", Baltimore, Maryland");
    try{const a=await fetch(url,{headers:{"Accept":"application/json"}}).then(r=>r.json());
      if(a&&a.length)return {lat:+a[0].lat,lng:+a[0].lon,name:a[0].display_name.split(",").slice(0,2).join(",")};
    }catch(e){}
    return null;
  }

  // ----- building info from MD iMAP PropertyData (stories, year, use) -----
  async function buildingInfo(lat,lng){
    const d=0.00035, env=[lng-d,lat-d,lng+d,lat+d].join(",");
    const u="https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertyData/MapServer/0/query?"+
      "geometry="+encodeURIComponent(env)+"&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326"+
      "&spatialRel=esriSpatialRelIntersects&outFields=RESITYP,DESCLU,YEARBLT,SQFTSTRC,BLDG_STORY,BLDG_UNITS,STRUCNST"+
      "&returnGeometry=false&f=json&resultRecordCount=1";
    try{
      const j=await fetch(u).then(r=>r.json());
      const f=(j.features&&j.features[0])?j.features[0].attributes:null;
      return f;
    }catch(e){return null;}
  }
  // Infer basement presence (no public basement field): Baltimore rowhouses & older
  // homes very commonly have basements. This is an INDICATIVE guess, clearly labeled.
  function basementGuess(a){
    if(!a)return {likely:null,txt:"unknown (no record)"};
    const yr=+a.YEARBLT||0, use=String(a.DESCLU||"").toLowerCase(), typ=String(a.RESITYP||"").toUpperCase();
    const resid=/resid|apart|dwell|townhouse|row/.test(use)||["SF","TH","AP","DU","CN"].includes(typ);
    if(resid && yr>0 && yr<1980)return {likely:true,txt:"likely YES (older residential \u2014 typical for Baltimore)"};
    if(resid)return {likely:"maybe",txt:"possible (residential)"};
    return {likely:"maybe",txt:"unknown (non-residential or no data)"};
  }

  // ----- distance to nearest stream (USGS NHD) for buried/stream basement risk -----
  let streamCache=null;
  async function nearestStreamMi(lat,lng){
    if(!streamCache){
      const d=0.02, env=[lng-d,lat-d,lng+d,lat+d].join(",");
      const u="https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query?"+
        "geometry="+encodeURIComponent(env)+"&geometryType=esriGeometryEnvelope&inSR=4326&outFields=GNIS_NAME"+
        "&outSR=4326&geometryPrecision=6&where=1%3D1&resultRecordCount=2000&f=geojson";
      try{streamCache=await fetch(u).then(r=>r.json());}catch(e){streamCache={features:[]};}
    }
    let best=1e9, nm="";
    (streamCache.features||[]).forEach(f=>{
      if(!f.geometry)return;
      const lines=f.geometry.type==="MultiLineString"?f.geometry.coordinates:[f.geometry.coordinates];
      lines.forEach(line=>line.forEach(pt=>{
        const dx=(pt[0]-lng)*Math.cos(lat*Math.PI/180), dy=pt[1]-lat;
        const miDist=Math.sqrt(dx*dx+dy*dy)*69;
        if(miDist<best){best=miDist;nm=(f.properties&&(f.properties.GNIS_NAME||f.properties.gnis_name))||"";}
      }));
    });
    return {mi:best,name:nm};
  }

  // ----- compose the location report popup -----
  async function locationReport(lat,lng){
    const depthMnow=depthM(loc.grid,lat,lng)*loc.scale; // metres at point, scaled
    const inch=depthMnow*M_TO_IN;
    const [bi,stream]=await Promise.all([buildingInfo(lat,lng),nearestStreamMi(lat,lng)]);
    const bg=basementGuess(bi);
    // basement-flood risk heuristic: surface depth + stream proximity
    let risk="Low", rcol="#16a34a";
    const nearStream = stream.mi<0.1;        // within ~500 ft of a mapped stream
    if(inch>=12 || (nearStream && inch>=4)){risk="High";rcol="#dc2626";}
    else if(inch>=4 || nearStream || bg.likely===true){risk="Moderate";rcol="#d4a017";}
    // doorway vs window rule-of-thumb
    let entry="";
    if(inch>=36)entry="Water deeper than ~3 ft could reach first-floor windows.";
    else if(inch>=6)entry="Water above ~6 in can enter through doorways/thresholds.";
    else if(inch>0)entry="Shallow water; may seep in at doorways in low spots.";

    let html='<div style="min-width:220px">';
    html+='<b>Location report</b><br>';
    html+='<div style="margin:3px 0"><b>Expected flood depth here: </b>'+
      (inch>=1? '<span style="color:#08519c;font-weight:700">'+inch.toFixed(1)+' in</span>'
              : '<span style="color:#16a34a">essentially dry</span>')+'</div>';
    // building block
    html+='<div style="margin-top:5px;padding-top:5px;border-top:1px solid #e2e8f0">';
    if(bi){
      const st=bi.BLDG_STORY!=null&&bi.BLDG_STORY!==""?bi.BLDG_STORY:"\u2014";
      html+='<b>Building</b><br>';
      html+='Stories: <b>'+st+'</b>'+(bi.BLDG_UNITS?(" \u00b7 units: "+bi.BLDG_UNITS):"")+'<br>';
      if(bi.YEARBLT&&+bi.YEARBLT>0)html+='Year built: '+bi.YEARBLT+'<br>';
      if(bi.DESCLU)html+='Use: '+bi.DESCLU+'<br>';
    }else{
      html+='<b>Building</b><br>No parcel record found at this point.<br>';
    }
    html+='Basement: <b>'+bg.txt+'</b>';
    html+='</div>';
    // risk block
    html+='<div style="margin-top:5px;padding-top:5px;border-top:1px solid #e2e8f0">';
    html+='<b>Basement-flood risk: </b><span class="pill" style="background:'+rcol+'">'+risk+'</span><br>';
    html+='Nearest mapped stream: '+(stream.mi<9999?(stream.mi.toFixed(2)+' mi'+(stream.name?(" ("+stream.name+")"):"")):"\u2014")+
          (nearStream?' \u2014 <span style="color:#dc2626">on/near a stream or buried stream channel</span>':'')+'<br>';
    if(entry)html+='<span style="color:#5d6b78">'+entry+'</span>';
    html+='</div>';
    html+='<div style="margin-top:5px;font-size:10px;color:#94a3b8">Building &amp; basement notes are indicative estimates from public parcel + stream data, not engineering-grade.</div>';
    html+='</div>';
    return html;
  }

  // ----- set location + run -----
  function setLocation(lat,lng,name){
    state.lat=lat; state.lng=lng;
    if(marker)map.removeLayer(marker);
    marker=L.marker([lat,lng]).addTo(map);
    if(name)document.getElementById("addr").value=name;
  }
  async function run(){
    state.rain=parseFloat(document.getElementById("rain").value)||0;
    loc=matchScenario(state.rain,state.dur);
    document.getElementById("rainNote").textContent=loc.label;
    if(ring)map.removeLayer(ring);
    if(state.rad>0){
      ring=L.circle([state.lat,state.lng],{radius:state.rad*1609,color:"#1c6ea4",weight:1.5,dashArray:"5 4",fill:false}).addTo(map);
      map.fitBounds(ring.getBounds().pad(0.15));
    } else {
      // whole Beltway: fit to the study-area extent
      map.fitBounds([[latBot,lngL],[latTop,lngR]],{padding:[10,10]});
    }
    const stats=renderFlood();
    const snap=document.getElementById("snap"); snap.style.display="block";
    const area=state.rad>0?("within "+state.rad+" mile"+(state.rad==1?"":"s")):"across the Beltway";
    snap.innerHTML="<b>"+state.rain.toFixed(1)+" in over "+state.dur+" h</b> "+area+": about <b>"+
      (stats?stats.wet:0).toLocaleString()+"</b> flooded grid cells; deepest \u2248 <b>"+
      (stats?stats.maxIn:0).toFixed(0)+" in</b>.";
    if(marker){
      marker.bindPopup("Loading location report\u2026").openPopup();
      locationReport(state.lat,state.lng).then(h=>{if(marker)marker.setPopupContent(h);});
    }
    document.getElementById("animWrap").style.display="block";
    document.getElementById("animRange").value=100; state.animT=1;
  }
  // ----- animation -----
  let animTimer=null;
  function setAnim(pct){
    state.animT=Math.max(0.02,pct/100); renderFlood();
    document.getElementById("animNote").textContent=
      "Showing \u2248 "+Math.round(pct)+"% of the way to the modeled maximum (illustrative build-up over the "+state.dur+"-h storm).";
  }
  function playAnim(){
    const rng=document.getElementById("animRange"), btn=document.getElementById("playBtn");
    if(animTimer){clearInterval(animTimer);animTimer=null;btn.innerHTML="&#9654; Play";return;}
    btn.innerHTML="&#10073;&#10073; Pause"; let v=0; rng.value=0; setAnim(0);
    animTimer=setInterval(()=>{v+=5; if(v>=100){v=100;clearInterval(animTimer);animTimer=null;btn.innerHTML="&#9654; Play";}
      rng.value=v; setAnim(v);},160);
  }
  // ----- wire UI -----
  document.getElementById("durSeg").onclick=e=>{if(e.target.dataset.dur){
    document.querySelectorAll("#durSeg button").forEach(b=>b.classList.remove("on"));
    e.target.classList.add("on"); state.dur=+e.target.dataset.dur;}};
  document.getElementById("radSeg").onclick=e=>{if(e.target.dataset.rad!=null){
    document.querySelectorAll("#radSeg button").forEach(b=>b.classList.remove("on"));
    e.target.classList.add("on"); state.rad=+e.target.dataset.rad;}};
  document.getElementById("findBtn").onclick=async()=>{
    const q=document.getElementById("addr").value.trim(); if(!q)return;
    const g=await geocode(q); if(!g){alert("Address not found. Try adding the street + Baltimore.");return;}
    setLocation(g.lat,g.lng,g.name); map.setView([g.lat,g.lng],14);
  };
  document.getElementById("addr").addEventListener("keydown",e=>{if(e.key==="Enter")document.getElementById("findBtn").click();});
  document.getElementById("pickBtn").onclick=()=>{picking=true;document.getElementById("pickBtn").textContent="Click the map\u2026";};
  map.on("click",e=>{ if(!picking)return; picking=false;
    document.getElementById("pickBtn").textContent="Pick on map";
    setLocation(e.latlng.lat,e.latlng.lng,null); });
  document.getElementById("runBtn").onclick=run;
  document.getElementById("animRange").oninput=e=>setAnim(+e.target.value);
  document.getElementById("playBtn").onclick=playAnim;
  // initial marker
  setLocation(state.lat,state.lng,"Inner Harbor");
})();


