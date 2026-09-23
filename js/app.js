let selectedPark = null;
let parkMap;
let rideMarkers = [];
let routeLayers = [];
let userPrefs = { groupSize: 4, parkHours: 6, thrill: "balanced", walking: "balanced" };
let completedRideKeys = [];
let latestRides = [];
let frozenRoute = [];
let previousWaits = {};
let mustRideNames = [];
let selectedFoodName = null;
let userFoodPlan = "eat-late";

const PARK_ENTITY_IDS = {
  "Magic Kingdom": "75ea578a-adc8-4116-a54d-dccb60765ef9",
  "EPCOT": "47f90d2c-e191-4239-a466-5892ef59a88b",
  "Hollywood Studios": "288747d1-8b4f-4a64-867e-ea7c9b27bad8",
  "Animal Kingdom": "1c84a229-8862-4648-9c71-378ddd2c7693",
  "Disneyland": "7340550b-c14d-4def-80bb-acdb51d49a66",
  "Cedar Point": "c8299e1a-0098-4677-8ead-dd0da204f8dc",
  "Kings Island": "694e1f6e-d6a2-4c86-9749-5da1a9cb8924"
};

const PARK_CENTERS = {
  "Magic Kingdom":[28.4177,-81.5812],
  "EPCOT":[28.3747,-81.5494],
  "Hollywood Studios":[28.3575,-81.5583],
  "Animal Kingdom":[28.3557,-81.5900],
  "Disneyland":[33.8121,-117.9190],
  "Cedar Point":[41.4822,-82.6835],
  "Kings Island":[39.3430,-84.2675]
};

const PREF_LABELS = {
  thrill: { balanced:"Balanced", easy:"Family friendly", extreme:"Big thrills" },
  walking: { balanced:"Balanced route", low:"Minimize walking", max:"Max rides" },
  food: { "eat-late":"Eat later", "eat-early":"Eat early", "skip-food":"Not eating in the park" }
};

const GROUP_LABELS = { Thrill:"Thrill rides", Kids:"Kids and family", Shows:"Shows", Food:"Dining", Other:"Other rides" };

const CHECK_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const STAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

function esc(value){
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------- Onboarding ---------- */
const obSteps = [...document.querySelectorAll("#onboarding .step")];
let obStep = 0;

function renderStep(){
  obSteps.forEach((step,i) => step.classList.toggle("hidden", i !== obStep));
  document.getElementById("obProgress").style.width = ((obStep + 1) / obSteps.length * 100) + "%";
  document.getElementById("obCount").textContent = `Step ${obStep + 1} of ${obSteps.length}`;
  document.getElementById("obBack").classList.toggle("invisible", obStep === 0);

  const next = document.getElementById("obNext");
  next.textContent = obStep === obSteps.length - 1 ? "Build my route" : "Continue";
  next.disabled = obStep === 0 && !selectedPark;
}

document.getElementById("obNext").addEventListener("click", () => {
  if(obStep === obSteps.length - 1) return launchApp();
  obStep++;
  renderStep();
});

document.getElementById("obBack").addEventListener("click", () => {
  if(obStep > 0){
    obStep--;
    renderStep();
  }
});

document.querySelectorAll("#onboarding .options").forEach(group => {
  group.addEventListener("click", e => {
    const option = e.target.closest(".option");
    if(!option) return;

    group.querySelectorAll(".option").forEach(o => {
      o.classList.remove("selected");
      o.setAttribute("aria-checked", "false");
    });
    option.classList.add("selected");
    option.setAttribute("aria-checked", "true");

    if(group.dataset.field === "park") selectedPark = option.dataset.value;
    else document.getElementById(group.dataset.field).value = option.dataset.value;

    renderStep();
  });
});

document.querySelectorAll("#onboarding input[type=range]").forEach(input => {
  const output = document.getElementById(input.dataset.output);
  const unit = input.dataset.unit && document.getElementById(input.dataset.unit);

  const paint = () => {
    output.textContent = input.value;
    if(unit) unit.textContent = input.value === "1" ? input.dataset.one : input.dataset.many;
    const fill = (input.value - input.min) / (input.max - input.min) * 100;
    input.style.setProperty("--fill", fill + "%");
  };

  input.addEventListener("input", paint);
  paint();
});

renderStep();

function launchApp(){
  userPrefs = {
    groupSize: Number(document.getElementById("groupSizeVal").textContent),
    parkHours: Number(document.getElementById("parkTimeVal").textContent),
    thrill: document.getElementById("thrillPref").value,
    walking: document.getElementById("walkingPref").value
  };

  userFoodPlan = document.getElementById("foodPref").value;

  document.getElementById("onboarding").classList.add("hidden");
  document.getElementById("parkName").textContent = selectedPark;
  renderSettings();

  fetchLiveWaitTimes();
  setInterval(fetchLiveWaitTimes, 300000);
}

function renderSettings(){
  document.getElementById("settingsPark").textContent = selectedPark;
  document.getElementById("settingsGroup").textContent = userPrefs.groupSize === 1 ? "1 person" : `${userPrefs.groupSize} people`;
  document.getElementById("settingsHours").textContent = `${userPrefs.parkHours} hours`;
  document.getElementById("settingsThrill").textContent = PREF_LABELS.thrill[userPrefs.thrill];
  document.getElementById("settingsWalk").textContent = PREF_LABELS.walking[userPrefs.walking];
  document.getElementById("settingsFood").textContent = PREF_LABELS.food[userFoodPlan];
}

/* ---------- Navigation ---------- */
function toggleMobileMenu(){
  const nav = document.querySelector(".nav");
  const btn = document.getElementById("mobileMenuBtn");
  const open = nav.classList.toggle("mobile-open");

  btn.textContent = open ? "✕" : "☰";
  btn.setAttribute("aria-expanded", String(open));
  btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

function showScreen(name, btn){
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  document.getElementById("screen-" + name).classList.remove("hidden");

  document.querySelectorAll(".nav button").forEach(b => b.classList.remove("active"));
  if(btn) btn.classList.add("active");

  if(document.querySelector(".nav").classList.contains("mobile-open")) toggleMobileMenu();

  if(name === "map" && parkMap) setTimeout(() => parkMap.invalidateSize(), 0);
}

document.addEventListener("click", e => {
  const btn = e.target.closest("[data-action]");
  if(!btn) return;

  if(btn.dataset.action === "complete" && btn.dataset.key) completeRide(btn.dataset.key);
  if(btn.dataset.action === "star") togglePriorityItem(btn.dataset.name);
});

/* ---------- Scoring ---------- */
function waitClass(wait){ if(wait <= 15) return "low"; if(wait <= 35) return "med"; return "high"; }

// Longest wait among rides the guest hasn't starred, so we never say "avoid" a must-ride.
function longestWait(rides){
  return rides
    .filter(r => !mustRideNames.includes(r.name))
    .sort((a,b) => b.wait_time - a.wait_time)[0] || null;
}

function waitText(wait){ return wait > 0 ? `${wait} min` : "No wait"; }

function rideKey(ride){
  return ride.id || ride.name;
}

function currentStops(){
  return frozenRoute.filter(r => !completedRideKeys.includes(rideKey(r)));
}

function detectLineSpike(openRides){
  const rising = openRides
    .filter(r => r.type !== "food")
    .map(r => {
      const oldWait = previousWaits[r.name];
      const currentWait = r.wait_time;

      if(oldWait === undefined) return null;

      const jump = currentWait - oldWait;

      return {
        ...r,
        jump,
        spikeRisk: jump * 3 + currentWait * 0.35 + calculateRideScore(r) * 0.25
      };
    })
    .filter(r => r && r.jump >= 5)
    .sort((a,b) => b.spikeRisk - a.spikeRisk);

  return rising[0] || null;
}

function generateInsiderTip(openRides){
  const ride = openRides.find(r => r.type !== "food" && r.wait_time >= 35) || openRides.find(r => r.type !== "food");

  if(!ride) return "Keep following your optimized route.";

  const name = ride.name.toLowerCase();

  if(name.includes("mountain") || name.includes("coaster")){
    return `${ride.name} may move faster than it looks because coaster lines usually load continuously.`;
  }

  if(name.includes("pirates") || name.includes("small world") || name.includes("haunted")){
    return `${ride.name} is a strong pick because high-capacity rides often absorb crowds well.`;
  }

  if(name.includes("splash") || name.includes("water")){
    return `${ride.name} often gets busier when temperatures rise, so earlier is usually smarter.`;
  }

  if(ride.wait_time <= 15){
    return `${ride.name} is in a low-wait window right now. Good time to grab it.`;
  }

  return `${ride.name} is worth watching. If it drops by 10+ minutes, it becomes a strong move.`;
}

function estimateFoodDelay(restaurant){
  const hour = new Date().getHours();
  const name = restaurant.name.toLowerCase();

  let delay = 10;

  if(hour >= 11 && hour <= 13) delay += 12;
  if(hour >= 17 && hour <= 19) delay += 15;

  if(name.includes("grill") || name.includes("barbecue") || name.includes("pizza")) delay += 8;
  if(name.includes("cafe") || name.includes("market") || name.includes("snack")) delay += 3;
  if(name.includes("ice cream") || name.includes("funnel") || name.includes("popcorn")) delay -= 5;
  if(name.includes("stand") || name.includes("cart")) delay -= 7;

  const variation = restaurant.name.length % 4;
  delay += variation * 3;

  return Math.round(Math.max(5, delay) / 5) * 5;
}

function calculateRideScore(ride){
  const wait = Number(ride.wait_time || 0);
  const name = ride.name.toLowerCase();
  let score = 100 - wait * 0.6;

  const isThrill = name.includes("mountain") || name.includes("coaster") || name.includes("thunder");
  const isFamily = name.includes("dumbo") || name.includes("small world") || name.includes("carousel") || name.includes("princess");
  const isClassic = name.includes("pirates") || name.includes("haunted") || name.includes("jungle");

  if(userPrefs.thrill === "extreme" && isThrill) score += 50;
  if(userPrefs.thrill === "easy" && isFamily) score += 50;
  if(userPrefs.thrill === "balanced" && (isClassic || isFamily)) score += 20;

  if(userPrefs.groupSize >= 6 && isFamily) score += 12;
  if(wait >= 60) score -= 20;
  if(mustRideNames.includes(ride.name)) score += 28;

  return Math.max(1, Math.round(score));
}

function distanceBetween(a,b){
  if(!a.lat || !a.lng || !b.lat || !b.lng) return 999;
  const dx = a.lat - b.lat;
  const dy = a.lng - b.lng;
  return Math.sqrt(dx*dx + dy*dy);
}

function pickFoodStop(rides){
  if(userFoodPlan === "skip-food") return null;

  const restaurants = rides.filter(r =>
    r.type === "food" &&
    r.is_open &&
    r.lat &&
    r.lng &&
    !completedRideKeys.includes(rideKey(r)) &&
    !(userPrefs.thrill === "easy" && r.servesAlcohol)
  );

  if(!restaurants.length) return null;

  if(selectedFoodName){
    return restaurants.find(r => r.name === selectedFoodName) || null;
  }

  const rideRoute = rides
    .filter(r => r.type !== "food" && r.is_open && r.lat && r.lng && !completedRideKeys.includes(rideKey(r)))
    .map(r => ({...r, score: calculateRideScore(r)}))
    .sort((a,b) => b.score - a.score)
    .slice(0,6);

  return restaurants
    .map(food => {
      const nearbyBonus = rideRoute.reduce((best, ride) => {
        const dist = distanceBetween(food, ride);
        return Math.max(best, 40 - dist * 120000);
      }, 0);

      return {
        ...food,
        score: 80 - estimateFoodDelay(food) * 0.8 + nearbyBonus
      };
    })
    .sort((a,b) => b.score - a.score)[0];
}

function buildOptimizedRoute(rides){
  let candidates = rides
    .filter(r => r.type !== "food" && r.is_open && r.lat && r.lng && !completedRideKeys.includes(rideKey(r)))
    .map(r => ({
      ...r,
      score: calculateRideScore(r) + Math.random() * 6
    }));

  if(!candidates.length) return [];

  const walkPenalty =
    userPrefs.walking === "low" ? 26000 :
    userPrefs.walking === "max" ? 8000 :
    15000;

  const start = {
    lat:PARK_CENTERS[selectedPark][0],
    lng:PARK_CENTERS[selectedPark][1]
  };

  candidates = candidates
    .map(r => ({
      ...r,
      routeScore:r.score - distanceBetween(start,r) * walkPenalty
    }))
    .sort((a,b) => b.routeScore - a.routeScore);

  const route = [candidates.shift()];

  while(route.length < 8 && candidates.length){
    const current = route[route.length - 1];

    candidates = candidates
      .map(r => ({
        ...r,
        routeScore:
          r.score
          + (mustRideNames.includes(r.name) ? 35 : 0)
          - distanceBetween(current,r) * walkPenalty
      }))
      .sort((a,b) => b.routeScore - a.routeScore);

    route.push(candidates.shift());
  }

  const foodStop = pickFoodStop(rides);

  if(foodStop){
    const insertIndex = userFoodPlan === "eat-early" ? 2 : 4;
    route.splice(Math.min(insertIndex, route.length), 0, {
      ...foodStop,
      score:90,
      food_time:userFoodPlan === "eat-early" ? "Early meal stop" : "Later meal stop"
    });
  }

  return route;
}

function calculateTimeSaved(openRides){
  if(!openRides.length) return "0.0";

  const allAvgWait = latestRides
    .filter(r => r.name && !completedRideKeys.includes(rideKey(r)))
    .reduce((sum,r)=>sum+r.wait_time,0) / Math.max(1, latestRides.filter(r => r.is_open).length);

  const routeAvgWait = openRides
    .slice(0,8)
    .reduce((sum,r)=>sum+r.wait_time,0) / Math.max(1, openRides.slice(0,8).length);

  const savedMinutes = Math.max(0, (allAvgWait - routeAvgWait) * userPrefs.parkHours * 1.8);

  return Math.max(0.3, savedMinutes / 60).toFixed(1);
}

function calculateRouteQuality(openRides){
  if(!openRides.length) return 0;

  const avgScore = openRides
    .slice(0,8)
    .reduce((sum,r)=>sum+r.score,0) / Math.max(1, openRides.slice(0,8).length);

  return Math.min(99, Math.max(55, Math.round(avgScore)));
}

function calculateLineAvoidance(openRides){
  if(!openRides.length) return 0;

  const badWaits = openRides.filter(r => r.wait_time >= 45).length;
  const score = 100 - badWaits * 12;

  return Math.max(50, Math.min(98, score));
}

function calculateWalkEfficiency(openRides){
  if(!openRides.length) return 0;

  let base = 82;

  if(userPrefs.walking === "low") base += 12;
  if(userPrefs.walking === "balanced") base += 5;
  if(userPrefs.walking === "max") base -= 5;

  return Math.max(55, Math.min(98, base));
}

/* ---------- Route actions ---------- */
function renderRoute(){
  updateUI();
  refreshMapMarkers();
  drawOptimizedRoute();
}

function reevaluateRoute(){
  frozenRoute = buildOptimizedRoute(latestRides);
  renderRoute();

  const btn = document.getElementById("reevaluateBtn");
  btn.textContent = "Route updated";
  setTimeout(() => btn.textContent = "Reevaluate route", 1000);
}

function completeRide(key){
  if(!completedRideKeys.includes(key)){
    completedRideKeys.push(key);
  }

  document.querySelectorAll(`[data-ride="${CSS.escape(key)}"]`).forEach(row => {
    row.querySelector(".check")?.classList.add("done");
    row.classList.add("leaving");
  });

  const goNow = document.getElementById("goNowCheck");
  if(goNow.dataset.key === key) goNow.classList.add("done");

  setTimeout(() => {
    goNow.classList.remove("done");
    frozenRoute = buildOptimizedRoute(latestRides);
    renderRoute();
  }, 400);
}

function togglePriorityItem(name){
  const item = latestRides.find(r => r.name === name);

  if(item && item.type === "food"){
    selectedFoodName = selectedFoodName === name ? null : name;
  } else if(mustRideNames.includes(name)){
    mustRideNames = mustRideNames.filter(r => r !== name);
  } else {
    mustRideNames.push(name);
  }

  frozenRoute = buildOptimizedRoute(latestRides);
  renderRoute();
}

/* ---------- Map ---------- */
function initParkMap(){
  if(typeof L === "undefined"){
    setMapStatus("The map couldn’t load. Check your connection, then reload the page.");
    return;
  }

  parkMap = L.map("liveParkMap", { zoomControl:false })
    .setView(PARK_CENTERS[selectedPark], 16);

  L.control.zoom({ position:"topright" }).addTo(parkMap);

  // OpenStreetMap tiles need no API key; CSS darkens them to match the app.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom:19,
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(parkMap);
}

function setMapStatus(message){
  const el = document.getElementById("mapStatus");
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

function clearMarkers(){
  rideMarkers.forEach(m => parkMap.removeLayer(m));
  rideMarkers = [];
}

function refreshMapMarkers(){
  if(!parkMap) return;
  clearMarkers();

  const stops = currentStops();
  const stopKeys = new Set(stops.map(rideKey));

  latestRides
    .filter(r => r.type !== "food" && !stopKeys.has(rideKey(r)))
    .forEach(r => addMarker(r, dotIcon(r), 0));

  stops.forEach((r,i) => addMarker(r, pinIcon(r,i), 1000 - i));
}

function dotIcon(ride){
  const cls = ride.is_open ? waitClass(ride.wait_time) : "closed";
  return L.divIcon({ className:"", html:`<div class="dot ${cls}"></div>`, iconSize:[12,12], iconAnchor:[6,6] });
}

function pinIcon(ride, index){
  const size = index === 0 ? 34 : 28;
  const cls = ["pin", ride.type === "food" ? "food" : "", index === 0 ? "first" : ""].join(" ").trim();
  return L.divIcon({ className:"", html:`<div class="${cls}">${index + 1}</div>`, iconSize:[size,size], iconAnchor:[size/2,size/2] });
}

function addMarker(ride, icon, zIndexOffset){
  if(!ride.lat || !ride.lng) return;

  const status =
    ride.type === "food" ? "Meal stop" :
    !ride.is_open ? "Closed" :
    ride.wait_time > 0 ? `${ride.wait_time} min wait` : "No wait";

  const marker = L.marker([ride.lat, ride.lng], { icon, zIndexOffset, title:ride.name }).addTo(parkMap);
  marker.bindPopup(`<strong>${esc(ride.name)}</strong><br>${status}`);
  rideMarkers.push(marker);
}

function drawOptimizedRoute(){
  if(!parkMap) return;

  routeLayers.forEach(layer => parkMap.removeLayer(layer));
  routeLayers = [];

  const coords = currentStops()
    .filter(r => r.lat && r.lng)
    .map(r => [r.lat, r.lng]);

  parkMap.invalidateSize();

  if(coords.length < 2){
    fitToRides();
    return;
  }

  // Stacked strokes make a neon tube: wide soft haze, tighter glow, bright core, white-hot center.
  const style = { color:"#aeff00", lineCap:"round", lineJoin:"round", interactive:false };
  const haze = L.polyline(coords, { ...style, weight:22, opacity:.08 }).addTo(parkMap);
  const glow = L.polyline(coords, { ...style, weight:12, opacity:.2 }).addTo(parkMap);
  const line = L.polyline(coords, { ...style, weight:4, opacity:1 }).addTo(parkMap);
  const core = L.polyline(coords, { ...style, color:"#f4ffd6", weight:1.5, opacity:.85 }).addTo(parkMap);
  routeLayers = [haze, glow, line, core];

  parkMap.fitBounds(line.getBounds(), { padding:[56,56] });
}

function fitToRides(){
  const points = latestRides.filter(r => r.type !== "food" && r.lat && r.lng).map(r => [r.lat, r.lng]);
  if(points.length) parkMap.fitBounds(points, { padding:[32,32] });
}

/* ---------- Data ---------- */
function cleanRideName(name){
  return String(name || "")
    .replace(/^"+|"+$/g, "")
    .replace(/[“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getJSON(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`ThemeParks.wiki returned ${res.status}`);
  return res.json();
}

async function fetchLiveWaitTimes(){
  const entityId = PARK_ENTITY_IDS[selectedPark];
  const refreshBtn = document.getElementById("refreshBtn");
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Refreshing…";

  try{
    if(!parkMap) initParkMap();

    const [data, childrenData] = await Promise.all([
      getJSON(`https://api.themeparks.wiki/v1/entity/${entityId}/live`),
      getJSON(`https://api.themeparks.wiki/v1/entity/${entityId}/children`)
    ]);

    const locationMap = {};
    childrenData.children.forEach(c => {
      if(c.location){
        locationMap[c.id] = {
          lat:c.location.latitude,
          lng:c.location.longitude
        };
      }
    });

    const attractions = data.liveData
      .filter(r => r.entityType === "ATTRACTION")
      .map(r => {
        const loc = locationMap[r.id] || {};
        return {
          id:r.id,
          name:cleanRideName(r.name),
          type:"ride",
          is_open:r.status === "OPERATING",
          wait_time:Number(r.queue?.STANDBY?.waitTime ?? 0),
          lat:loc.lat,
          lng:loc.lng
        };
      });

    const restaurants = childrenData.children
      .filter(r =>
        r.entityType === "RESTAURANT" &&
        !r.name.toLowerCase().includes("refill") &&
        !r.name.toLowerCase().includes("drink station") &&
        !r.name.toLowerCase().includes("coca-cola")
      )
      .map(r => {
        const name = r.name.toLowerCase();

        return {
          id:r.id,
          name:cleanRideName(r.name),
          type:"food",
          is_open:true,
          wait_time:0,
          lat:r.location?.latitude,
          lng:r.location?.longitude,
          servesAlcohol:
            name.includes("bar") ||
            name.includes("brew") ||
            name.includes("pub") ||
            name.includes("saloon") ||
            name.includes("tavern") ||
            name.includes("cantina")
        };
      })
      .filter(r => r.lat && r.lng);

    latestRides = [...attractions, ...restaurants];
    frozenRoute = buildOptimizedRoute(latestRides);

    document.getElementById("nextRetry").classList.add("hidden");
    renderRoute();

    previousWaits = Object.fromEntries(latestRides.map(r => [r.name, r.wait_time]));

  }catch(err){
    console.error(err);
    showLoadError();
  }finally{
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh";
  }
}

function showLoadError(){
  const lastUpdated = document.getElementById("lastUpdated");

  if(latestRides.length){
    lastUpdated.textContent = "Couldn’t refresh. Showing the last live data.";
    return;
  }

  lastUpdated.textContent = "Live data didn’t load";
  document.getElementById("liveBadge").classList.add("off");
  document.getElementById("liveBadge").textContent = "Offline";
  document.getElementById("nextLabel").textContent = "Something went wrong";
  document.getElementById("navMain").textContent = "Couldn’t load live wait times";
  document.getElementById("navSub").textContent = "ThemeParks.wiki didn’t respond. Check your connection, then try again.";
  document.getElementById("nextWait").textContent = "";
  document.getElementById("goNowCheck").classList.add("hidden");
  document.getElementById("routeConfidence").classList.add("hidden");
  document.getElementById("nextRetry").classList.remove("hidden");
  document.getElementById("rideList").innerHTML = `<p class="empty">Your route will appear here once live data loads.</p>`;
}

/* ---------- Rendering ---------- */
function updateUI(){
  const stops = currentStops();
  const anyOpen = latestRides.some(r => r.type !== "food" && r.is_open);

  document.getElementById("lastUpdated").textContent =
    "Updated " + new Date().toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});

  const badge = document.getElementById("liveBadge");
  badge.classList.toggle("off", !anyOpen);
  badge.textContent = anyOpen ? "Live" : "Closed";

  setMapStatus(anyOpen ? "" : `${selectedPark} is closed right now. The map shows where every ride is.`);

  updateNavigationMode(stops, anyOpen);
  updateRouteConfidence(stops);
  updateTrustLayer(stops, anyOpen);
  renderRouteList(stops, anyOpen);
  renderMustRideList(latestRides);
  updateAI(stops, anyOpen);
  updateMetrics(stops);
  updateWarRoom(stops);
}

function updateNavigationMode(stops, anyOpen){
  const label = document.getElementById("nextLabel");
  const main = document.getElementById("navMain");
  const sub = document.getElementById("navSub");
  const wait = document.getElementById("nextWait");
  const check = document.getElementById("goNowCheck");
  const current = stops[0];
  const next = stops[1];

  if(!current){
    check.classList.add("hidden");
    wait.textContent = "";

    if(!anyOpen){
      label.textContent = "Park closed";
      main.textContent = `${selectedPark} is closed right now`;
      sub.textContent = "No rides are reporting live waits. Your route builds automatically once rides open, or you can pick another park in Settings.";
    } else {
      label.textContent = "Route complete";
      main.textContent = "You’ve cleared your route";
      sub.textContent = "Every open ride on your list is done. Star more rides below to keep going.";
    }
    return;
  }

  label.textContent = current.type === "food" ? "Next up: meal stop" : "Next up";
  check.classList.remove("hidden");
  check.dataset.key = rideKey(current);
  check.setAttribute("aria-label", `Mark ${current.name} as done`);

  main.textContent = current.name;
  sub.textContent = next ? `Then ${next.name}` : "Last stop on your route";

  if(current.type === "food"){
    wait.className = "next-wait meal";
    wait.textContent = "Meal";
  } else {
    wait.className = "next-wait " + waitClass(current.wait_time);
    wait.innerHTML = current.wait_time > 0 ? `${current.wait_time}<span class="unit">min</span>` : `<span class="no-wait">No wait</span>`;
  }
}

function updateRouteConfidence(stops){
  const el = document.getElementById("routeConfidence");
  const routeRides = stops.filter(r => r.type !== "food").slice(0,3);

  el.classList.toggle("hidden", routeRides.length < 2);
  if(routeRides.length < 2) return;

  const avgWait = Math.round(routeRides.reduce((sum,r)=>sum + r.wait_time, 0) / routeRides.length);

  const mode =
    userPrefs.walking === "low" ? "minimal walking" :
    userPrefs.walking === "max" ? "maximum rides" :
    "low waits and smart walking";

  el.textContent = `Optimized for ${mode}. Your next 3 rides average ${avgWait} min.`;
}

function updateTrustLayer(stops, anyOpen){
  const el = document.getElementById("trustInline");
  const allOpen = latestRides.filter(r => r.is_open && r.type !== "food");
  const routeRides = stops.filter(r => r.type !== "food").slice(0,6);

  let message;

  if(!anyOpen){
    message = "No rides are running right now";
  } else if(!routeRides.length){
    message = "Route complete";
  } else {
    const parkAvg = allOpen.reduce((sum,r)=>sum+r.wait_time,0) / allOpen.length;
    const routeAvg = routeRides.reduce((sum,r)=>sum+r.wait_time,0) / routeRides.length;

    const savedMinutes = Math.max(0, Math.round((parkAvg - routeAvg) * routeRides.length));
    const skippedHigh = allOpen.filter(r =>
      r.wait_time >= 45 && !routeRides.some(x => x.name === r.name)
    ).length;

    if(savedMinutes > 25) message = `Beating the park average by about ${savedMinutes} min`;
    else if(skippedHigh >= 2) message = `Skipping ${skippedHigh} long waits`;
    else message = "Optimized for low waits and smooth walking";
  }

  el.style.opacity = 0;
  setTimeout(() => {
    el.textContent = message;
    el.style.opacity = 1;
  }, 120);
}

function renderRouteList(stops, anyOpen){
  const el = document.getElementById("rideList");

  if(!stops.length){
    el.innerHTML = `<p class="empty">${anyOpen ? "Nothing left on your route." : "Your route will appear here when rides open."}</p>`;
    return;
  }

  el.innerHTML = stops.slice(0,10).map((r,i) => {
    const key = esc(rideKey(r));
    const food = r.type === "food";

    return `
      <div class="row" data-ride="${key}">
        <button class="check" data-action="complete" data-key="${key}" aria-label="Mark ${esc(r.name)} as done">${CHECK_SVG}</button>
        <span class="stop-num${food ? " food" : ""}">${i + 1}</span>
        <span class="row-name">${esc(r.name)}${food ? `<span class="row-sub">${esc(r.food_time)}</span>` : ""}</span>
        <span class="wait ${food ? "meal" : waitClass(r.wait_time)}">${food ? "Meal" : waitText(r.wait_time)}</span>
      </div>
    `;
  }).join("");
}

function rideCategory(name){
  const n = String(name || "").toLowerCase();
  const item = latestRides.find(r => r.name === name);
  if(item && item.type === "food") return "Food";

  if(n.includes("mountain") || n.includes("coaster") || n.includes("tower") || n.includes("thunder") || n.includes("flight") || n.includes("rise") || n.includes("guardians") || n.includes("test track") || n.includes("millennium") || n.includes("slinky dog")) return "Thrill";

  if(n.includes("dumbo") || n.includes("carousel") || n.includes("small world") || n.includes("princess") || n.includes("winnie") || n.includes("peter pan") || n.includes("little mermaid") || n.includes("mickey") || n.includes("mania")) return "Kids";

  if(n.includes("show") || n.includes("theater") || n.includes("philharmagic") || n.includes("country bear") || n.includes("hall") || n.includes("tiki") || n.includes("carousel of progress") || n.includes("presents")) return "Shows";

  return "Other";
}

function popularityScore(name){
  const n = name.toLowerCase();

  if(n.includes("rise") || n.includes("flight") || n.includes("guardians")) return 100;
  if(n.includes("space") || n.includes("slinky") || n.includes("tower")) return 95;
  if(n.includes("thunder") || n.includes("pirates") || n.includes("haunted")) return 90;
  if(n.includes("jungle") || n.includes("peter pan")) return 85;

  return 60;
}

function renderMustRideList(rides){
  const el = document.getElementById("mustRideList");
  const groups = { Thrill:[], Kids:[], Shows:[], Food:[], Other:[] };
  const openGroups = [...el.querySelectorAll("details[open]")].map(d => d.dataset.group);

  rides
    .filter(r => r && r.name && !completedRideKeys.includes(rideKey(r)))
    .sort((a,b) => popularityScore(b.name) - popularityScore(a.name))
    .forEach(r => groups[rideCategory(r.name)].push(r));

  el.innerHTML = Object.keys(groups).filter(g => groups[g].length).map(group => `
    <details class="group" data-group="${group}"${openGroups.includes(group) ? " open" : ""}>
      <summary>${GROUP_LABELS[group]}<span class="count">${groups[group].length}</span></summary>
      <div class="list">
        ${groups[group].map(r => {
          const food = r.type === "food";
          const on = mustRideNames.includes(r.name) || selectedFoodName === r.name;
          const status = food ? `~${estimateFoodDelay(r)} min` : r.is_open ? waitText(r.wait_time) : "Closed";
          const cls = food ? "meal" : r.is_open ? waitClass(r.wait_time) : "closed";
          const action = on ? "Remove" : "Add";
          const target = food ? "as your meal stop" : "as a must-ride";

          return `
            <div class="row">
              <button class="star${on ? " on" : ""}" data-action="star" data-name="${esc(r.name)}" aria-pressed="${on}" aria-label="${action} ${esc(r.name)} ${target}">${STAR_SVG}</button>
              <span class="row-name">${esc(r.name)}</span>
              <span class="wait ${cls}">${status}</span>
            </div>
          `;
        }).join("")}
      </div>
    </details>
  `).join("");
}

function updateAI(stops, anyOpen){
  const ids = ["aiNext","aiAlert","spikeAlert","aiProjection","insiderTip"];
  const rides = stops.filter(r => r.type !== "food");
  const best = stops[0];

  if(!best){
    const message = anyOpen ? "Your route is complete." : "No live route while the park is closed.";
    ids.forEach(id => document.getElementById(id).textContent = message);
    return;
  }

  const worst = longestWait(rides);

  const droppedRide = latestRides.find(r => {
    const oldWait = previousWaits[r.name];
    return oldWait && oldWait >= 45 && oldWait - r.wait_time >= 20;
  });

  const avgRouteWait = rides.slice(0,6)
    .reduce((sum,r)=>sum+r.wait_time,0) / Math.max(1, rides.slice(0,6).length);
  const projectedRides = Math.max(1, Math.floor((userPrefs.parkHours * 60) / (avgRouteWait + 12)));

  document.getElementById("aiNext").innerHTML = best.type === "food"
    ? `Head to <strong>${esc(best.name)}</strong> for your meal stop.`
    : `Head to <strong>${esc(best.name)}</strong> (${best.wait_time > 0 ? best.wait_time + " min wait" : "no wait"}).`;

  document.getElementById("aiAlertTitle").textContent = droppedRide ? "Wait drop" : "Crowd alert";
  document.getElementById("aiAlert").innerHTML = droppedRide
    ? `<strong>${esc(droppedRide.name)}</strong> fell from ${previousWaits[droppedRide.name]} to ${droppedRide.wait_time} min.`
    : worst ? `Avoid <strong>${esc(worst.name)}</strong> for now (${worst.wait_time} min wait).` : "No long waits on your route.";

  document.getElementById("aiProjection").innerHTML =
    `About <strong>${projectedRides} rides</strong> at your current pace.`;

  const spikeRide = detectLineSpike(stops);
  document.getElementById("spikeAlert").innerHTML = spikeRide
    ? `Ride <strong>${esc(spikeRide.name)}</strong> now. Its wait jumped ${spikeRide.jump} min and may keep climbing.`
    : "No spikes detected. Your route looks stable.";

  document.getElementById("insiderTip").textContent = generateInsiderTip(stops);
}

function updateMetrics(stops){
  const meters = [
    ["routeQuality","barRoute",calculateRouteQuality],
    ["crowdAvoid","barAvoid",calculateLineAvoidance],
    ["walkEff","barWalk",calculateWalkEfficiency]
  ];

  if(!stops.length){
    document.getElementById("sessionTime").textContent = "--";
    meters.forEach(([valueId, barId]) => {
      document.getElementById(valueId).textContent = "--";
      document.getElementById(barId).style.width = "0%";
    });
  } else {
    document.getElementById("sessionTime").innerHTML = `${calculateTimeSaved(stops)}<span class="unit">hours</span>`;
    meters.forEach(([valueId, barId, calc]) => {
      const value = calc(stops);
      document.getElementById(valueId).textContent = value + "%";
      document.getElementById(barId).style.width = value + "%";
    });
  }

  updateDayStatus(stops);
  updateFoodTiming();
}

function updateFoodTiming(){
  const banner = document.getElementById("foodTimingBanner");

  if(userFoodPlan === "skip-food"){
    banner.className = "banner info";
    banner.textContent = "Food skipped. Your route focuses fully on rides.";
    return;
  }

  const hour = new Date().getHours();
  const currentFood = frozenRoute.find(r => r.type === "food");
  const waitEstimate = currentFood ? estimateFoodDelay(currentFood) : 25;

  let bestHour;

  if(hour < 11) bestHour = 11;
  else if(hour >= 11 && hour <= 13) bestHour = 14;
  else if(hour < 17) bestHour = 16;
  else if(hour >= 17 && hour <= 19) bestHour = 20;
  else bestHour = hour;

  const bestTime = new Date();
  bestTime.setHours(bestHour, 40, 0, 0);
  const timeText = bestTime.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" });

  const peakRush = (hour >= 11 && hour <= 13) || (hour >= 17 && hour <= 19);

  if(peakRush){
    banner.className = "banner warn";
    banner.innerHTML = `Food lines are about ${waitEstimate} min right now. Eat around <strong>${timeText}</strong> instead.`;
  } else {
    banner.className = "banner info";
    banner.textContent = `Good time to eat. Expect about ${waitEstimate} min near your route.`;
  }
}

function updateDayStatus(stops){
  const banner = document.getElementById("dayStatusBanner");
  const allOpen = latestRides.filter(r => r.is_open && r.type !== "food");
  const routeRides = stops.filter(r => r.type !== "food").slice(0,6);

  if(!allOpen.length){
    banner.className = "banner";
    banner.textContent = "No rides are running right now.";
    return;
  }

  if(!routeRides.length){
    banner.className = "banner good";
    banner.textContent = "Your route is complete.";
    return;
  }

  const parkAvg = allOpen.reduce((sum,r)=>sum+r.wait_time,0) / allOpen.length;
  const routeAvg = routeRides.reduce((sum,r)=>sum+r.wait_time,0) / routeRides.length;
  const advantage = Math.round(((parkAvg - routeAvg) / Math.max(1, parkAvg)) * 100);

  if(advantage >= 15){
    banner.className = "banner good";
    banner.innerHTML = `Your route beats the park’s average wait by <strong>${advantage}%</strong>.`;
  } else {
    banner.className = "banner warn";
    banner.textContent = "Your route is close to the park average. Try Reevaluate route on the Live Map.";
  }
}

function updateWarRoom(stops){
  const rides = stops.filter(r => r.type !== "food");
  const best = rides[0];
  const second = rides[1];
  const worst = longestWait(rides);

  if(!best){
    ["routeMove","forecastWait","walkScore"].forEach(id => document.getElementById(id).textContent = "--");
    ["routeText","forecastText","walkText"].forEach(id => document.getElementById(id).textContent = "No live route right now.");
    return;
  }

  document.getElementById("routeMove").innerHTML = best.wait_time > 0 ? `${best.wait_time}<span class="unit">min</span>` : "No wait";
  document.getElementById("routeText").textContent = `Go to ${best.name} now. It has the best route score.`;

  document.getElementById("forecastWait").innerHTML = worst ? `${worst.wait_time}<span class="unit">min</span>` : "--";
  document.getElementById("forecastText").textContent = worst ? `Avoid ${worst.name} for now.` : "Your must-rides are the only long waits left.";

  document.getElementById("walkScore").textContent = second ? "Excellent" : "--";
  document.getElementById("walkText").textContent = second ? `Pair ${best.name} with ${second.name}`.replace(/\.?$/, ".") : "Add more rides to pair nearby stops.";
}

// index.html's inline onclick handlers call these; module scope isn't global.
Object.assign(window, { showScreen, toggleMobileMenu, fetchLiveWaitTimes, reevaluateRoute, launchApp });
