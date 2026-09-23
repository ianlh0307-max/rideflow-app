import { loadWalkGraph } from "./walkgraph.js";
import { runPlanRequest } from "./plan-request.js";
import { hashSeed } from "./planner.js";
import { isoToParkMinutes, minutesToClock, formatDuration, liveAttractions, operatingDay, PARK_TIMEZONES } from "./livedata.js";
import { emptyRouteReason } from "./status.js";
import { rideDetailsFor } from "./ridedata.js";
import { saveDay, loadDay, clearDay } from "./session.js";

let selectedPark = null;
let parkMap;
let rideMarkers = [];
let routeLayers = [];
let userPrefs = { groupSize: 4, parkHours: 6, thrill: "balanced", walking: "balanced" };
let completedRideKeys = [];
let latestRides = [];
let previousWaits = {};
let mustRideIds = [];
let selectedFoodId = null;
let parkTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let parkDate = null;          // "YYYY-MM-DD" in park time
let parkCloseMin = null;      // park-local minutes; may exceed 1440 after midnight
let parkMetaReady = null;     // Promise from loadParkMeta()
let planStartMin = null;
let walkData = null;          // data/walkways JSON, or null when unavailable
let rideDetails = {};
let gps = null;               // { lat, lng, accuracy }
let lockedNextId = null;
let lastNextKey = null;       // Next up card cross-fades when this changes
let fitRouteNext = true;       // re-fit the map to the route on the next draw (first plan, Reevaluate, settings)
let shownRideIds = new Set();   // rides "Reevaluate" is steering away from; kept until settings change
let recentPlans = [];           // optional rides of the last two plans Reevaluate replaced
let planRequestId = 0;
let planState = emptyPlanState();
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

const PARK_SLUGS = {
  "Magic Kingdom":"magic-kingdom", "EPCOT":"epcot", "Hollywood Studios":"hollywood-studios",
  "Animal Kingdom":"animal-kingdom", "Disneyland":"disneyland", "Cedar Point":"cedar-point", "Kings Island":"kings-island"
};
const MEAL_CANDIDATES = 12;
const STADIA_API_KEY = "";   // optional; leave empty when the domain is registered with Stadia
const MAP_STOPS = 6;          // next stops highlighted on the map

function emptyPlanState(){
  return { ids:[], timeline:[], legs:[], baseline:null, estimated:false, warnings:[], reason:null,
           lockDropped:null, mealStatus:null, startSource:null, gpsOutside:false, summary:null, moved:[] };
}

const planner = createPlannerClient();

const GROUP_LABELS = { Thrill:"Thrill rides", Kids:"Kids and family", Shows:"Shows", Food:"Dining", Other:"Other rides" };

const CHECK_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const STAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

function esc(value){
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------- Onboarding ---------- */
const obSteps = [...document.querySelectorAll("#onboarding .step")];
let obStep = 0;
let obDirection = null;       // "forward" | "back": which way the next step slides in

function renderStep(){
  obSteps.forEach((step,i) => step.classList.toggle("hidden", i !== obStep));
  const current = obSteps[obStep];
  current.classList.remove("enter-forward", "enter-back");
  if(obDirection){
    void current.offsetWidth;   // restart the slide animation
    current.classList.add(`enter-${obDirection}`);
  }
  document.querySelector("#onboarding .ob-body").scrollTop = 0;
  document.getElementById("obProgress").style.width = ((obStep + 1) / obSteps.length * 100) + "%";
  document.getElementById("obCount").textContent = `${obStep + 1}/${obSteps.length}`;
  document.getElementById("obBack").classList.toggle("invisible", obStep === 0);

  const next = document.getElementById("obNext");
  next.textContent = obStep === obSteps.length - 1 ? "Build my route" : "Continue";
  next.disabled = obStep === 0 && !selectedPark;

  document.getElementById("locationNote").classList.toggle("hidden", obStep !== obSteps.length - 1);
  if(obStep === 2) updateEndTimeNote();
}

function updateEndTimeNote(){
  const note = document.getElementById("endTimeNote");
  if(!parkDate){
    note.textContent = "";
    parkMetaReady?.then(updateEndTimeNote);
    return;
  }
  const hours = Number(document.getElementById("parkTimeVal").textContent);
  const end = parkNow() + hours * 60;
  note.textContent = parkCloseMin !== null && end > parkCloseMin
    ? `${selectedPark} closes at ${minutesToClock(parkCloseMin)}, so your plan ends then.`
    : `Until about ${minutesToClock(end)}`;
}

document.getElementById("obNext").addEventListener("click", () => {
  if(obStep === obSteps.length - 1) return launchApp();
  obStep++;
  obDirection = "forward";
  renderStep();
});

document.getElementById("obBack").addEventListener("click", () => {
  if(obStep > 0){
    obStep--;
    obDirection = "back";
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

    if(group.dataset.field === "park"){
      selectedPark = option.dataset.value;
      parkMetaReady = loadParkMeta(selectedPark);
    }
    else document.getElementById(group.dataset.field).value = option.dataset.value;

    obDirection = null;   // selecting an answer shouldn't replay this step's slide-in
    renderStep();

    // Picking an answer moves on by itself, except on the last step, which builds the route.
    const step = obStep;
    if(step < obSteps.length - 1){
      setTimeout(() => {
        if(obStep !== step) return;
        obStep++;
        obDirection = "forward";
        renderStep();
      }, 280);
    }
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
    if(input.dataset.output === "parkTimeVal") updateEndTimeNote();
  };

  input.addEventListener("input", paint);
  paint();
});

renderStep();

async function launchApp(){
  userPrefs = {
    groupSize: Number(document.getElementById("groupSizeVal").textContent),
    parkHours: Number(document.getElementById("parkTimeVal").textContent),
    thrill: document.getElementById("thrillPref").value,
    walking: document.getElementById("walkingPref").value
  };
  userFoodPlan = document.getElementById("foodPref").value;

  document.getElementById("onboarding").classList.add("hidden");
  await (parkMetaReady ??= loadParkMeta(selectedPark));
  planStartMin = parkNow();
  startDay();
}

async function startDay(){
  document.getElementById("onboarding").classList.add("hidden");
  document.getElementById("parkName").textContent = selectedPark;
  renderSettings();
  persistDay();
  await loadParkData();
  requestLocation();

  fetchLiveWaitTimes();
  setInterval(fetchLiveWaitTimes, 300000);
}

/* ---------- Remembering the day across refreshes ---------- */
function deviceStorage(){
  try{ return window.localStorage; }catch(err){ return null; }
}

function persistDay(){
  if(!selectedPark || planStartMin === null) return;
  saveDay(deviceStorage(), {
    park: selectedPark, timeZone: parkTimeZone, parkDate, closeMin: parkCloseMin, planStartMin,
    prefs: userPrefs, food: userFoodPlan, completed: completedRideKeys, mustRideIds, selectedFoodId,
    recentPlans, lockedNextId
  });
}

function resumeDay(day){
  selectedPark = day.park;
  userPrefs = { ...day.prefs };
  userFoodPlan = day.food;
  parkTimeZone = day.timeZone;
  parkDate = day.parkDate;
  parkCloseMin = day.closeMin;
  planStartMin = day.planStartMin;
  completedRideKeys = [...day.completed];
  mustRideIds = [...(day.mustRideIds || [])];
  selectedFoodId = day.selectedFoodId ?? null;
  recentPlans = day.recentPlans || [];
  shownRideIds = new Set(recentPlans.flat());
  lockedNextId = day.lockedNextId ?? null;
  parkMetaReady = Promise.resolve();
  startDay();
}

function startOver(){
  clearDay(deviceStorage());
  location.reload();
}

let youMarker = null;
let youAccuracy = null;

function requestLocation(){
  if(!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    pos => {
      const before = gpsState();
      gps = { lat:pos.coords.latitude, lng:pos.coords.longitude, accuracy:pos.coords.accuracy };
      drawYouAreHere();
      // The first fix often lands after the first plan; re-plan when usable GPS appears
      // or moves in/out of the park, but not on every small movement.
      if(gpsState() !== before) requestPlan();
    },
    () => {
      gps = null;
      drawYouAreHere();
    },
    { enableHighAccuracy:true, maximumAge:30000, timeout:20000 }
  );
}

function gpsState(){
  if(!gps || gps.accuracy > 50) return "none";
  return insideBbox(gps) ? "inside" : "outside";
}

function drawYouAreHere(){
  if(!parkMap) return;
  youMarker?.remove();
  youAccuracy?.remove();
  youMarker = youAccuracy = null;

  const show = gps && insideBbox(gps);
  document.getElementById("locateBtn").classList.toggle("hidden", !show);
  if(!show) return;

  if(gps.accuracy > 20){
    youAccuracy = L.circle([gps.lat, gps.lng], {
      radius:gps.accuracy, color:"#00c6ff", weight:1, opacity:.5, fillOpacity:.08, interactive:false
    }).addTo(parkMap);
  }
  youMarker = L.marker([gps.lat, gps.lng], {
    icon: L.divIcon({ className:"", html:'<div class="you-dot"></div>', iconSize:[18,18], iconAnchor:[9,9] }),
    zIndexOffset:2000,
    title:"You are here"
  }).addTo(parkMap);
}

function centerOnMe(){
  if(gps && parkMap) parkMap.setView([gps.lat, gps.lng], 18);
}

function renderSettings(){
  document.getElementById("settingsPark").textContent = selectedPark;
  document.getElementById("settingsGroup").textContent = userPrefs.groupSize === 1 ? "1 person" : `${userPrefs.groupSize} people`;

  const hours = document.getElementById("settingsHours");
  hours.value = userPrefs.parkHours;
  hours.style.setProperty("--fill", ((hours.value - hours.min) / (hours.max - hours.min) * 100) + "%");
  const endText = planStartMin !== null ? ` · until ${minutesToClock(budgetEndMin())}` : "";
  document.getElementById("settingsHoursOut").textContent = `${userPrefs.parkHours} hours${endText}`;

  document.querySelectorAll(".segmented").forEach(group => {
    const value = group.dataset.setting === "food" ? userFoodPlan : userPrefs[group.dataset.setting];
    group.querySelectorAll("button").forEach(b => b.classList.toggle("selected", b.dataset.value === value));
  });
}

document.querySelectorAll(".segmented").forEach(group => {
  group.addEventListener("click", e => {
    const button = e.target.closest("button[data-value]");
    if(!button) return;
    if(group.dataset.setting === "food") userFoodPlan = button.dataset.value;
    else userPrefs[group.dataset.setting] = button.dataset.value;
    renderSettings();
    requestPlan({ prefsChanged:true });
  });
});

const settingsHours = document.getElementById("settingsHours");
settingsHours.addEventListener("input", () => {
  userPrefs.parkHours = Number(settingsHours.value);
  renderSettings();
});
settingsHours.addEventListener("change", () => requestPlan({ prefsChanged:true }));

/* ---------- Park time and data ---------- */
function parkNow(){
  return isoToParkMinutes(new Date().toISOString(), parkTimeZone, parkDate);
}

function budgetEndMin(){
  return Math.min(planStartMin + userPrefs.parkHours * 60, parkCloseMin ?? Infinity);
}

async function loadParkMeta(park){
  let json = null;
  try{
    const res = await fetch(`https://api.themeparks.wiki/v1/entity/${PARK_ENTITY_IDS[park]}/schedule`);
    if(res.ok) json = await res.json();
  }catch(err){
    console.warn("[RideFlow] park schedule unavailable", err);
  }
  if(park !== selectedPark) return;   // the guest picked another park while this loaded
  parkTimeZone = json?.timezone || PARK_TIMEZONES[park];
  ({ parkDate, closeMin: parkCloseMin } = operatingDay(json, parkTimeZone, new Date()));
}

async function loadParkData(){
  const slug = PARK_SLUGS[selectedPark];
  const load = path => fetch(path).then(r => r.ok ? r.json() : null).catch(() => null);
  const [walkways, rides] = await Promise.all([load(`data/walkways/${slug}.json`), load(`data/rides/${slug}.json`)]);
  walkData = walkways;
  rideDetails = rides || {};
  planner.setGraph(walkData);
}

function createPlannerClient(){
  let worker = null;
  let graphJson = null;
  let fallbackGraph;
  const pending = new Map();

  try{
    worker = new Worker(new URL("./planner-worker.js", import.meta.url), { type:"module" });
    worker.onmessage = e => {
      const resolve = pending.get(e.data.id);
      if(resolve){ pending.delete(e.data.id); resolve(e.data); }
    };
    worker.onerror = err => {
      console.error("[RideFlow] planner worker failed; planning on the main thread", err);
      worker = null;
      pending.forEach(resolve => resolve(null));
      pending.clear();
    };
  }catch(err){
    worker = null;
  }

  return {
    setGraph(json){
      graphJson = json;
      fallbackGraph = undefined;
      worker?.postMessage({ type:"graph", json });
    },
    run(request, id){
      if(worker) return new Promise(resolve => { pending.set(id, resolve); worker.postMessage({ type:"plan", id, request }); });
      if(fallbackGraph === undefined) fallbackGraph = graphJson ? loadWalkGraph(graphJson) : null;
      const quick = { ...request, plannerInput:{ ...request.plannerInput, timeLimitMs:150, beamWidth:60 } };
      try{ return Promise.resolve({ id, ok:true, ...runPlanRequest(fallbackGraph, quick) }); }
      catch(err){ return Promise.resolve({ id, ok:false, error:String(err) }); }
    }
  };
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
  if(btn.dataset.action === "star") togglePriorityItem(btn.dataset.key);
});

/* ---------- Scoring ---------- */
function waitClass(wait){ if(wait <= 15) return "low"; if(wait <= 35) return "med"; return "high"; }

// Longest wait among rides the guest hasn't starred, so we never say "avoid" a must-ride.
function longestWait(rides){
  return rides
    .filter(r => !mustRideIds.includes(rideKey(r)))
    .sort((a,b) => b.wait_time - a.wait_time)[0] || null;
}

function waitText(wait){ return wait > 0 ? `${wait} min` : "No wait"; }

function rideKey(ride){
  return ride.id || ride.name;
}

function currentStops(){
  const byId = new Map(latestRides.map(r => [rideKey(r), r]));
  return planState.timeline
    .filter(t => !completedRideKeys.includes(t.id) && byId.has(t.id))
    .map(t => {
      const r = byId.get(t.id);
      return {
        ...r, arrive:t.arrive, start:t.start, walkMin:t.walkMin, waitMin:t.waitMin, score:t.points,
        food_time: r.type === "food" ? `Meal stop around ${minutesToClock(t.start)}` : undefined
      };
    });
}

function mealCandidates(){
  const open = latestRides.filter(r =>
    r.type === "food" && r.lat && r.lng &&
    !completedRideKeys.includes(rideKey(r)) &&
    !(userPrefs.thrill === "easy" && r.servesAlcohol)
  );
  if(selectedFoodId) return open.filter(r => rideKey(r) === selectedFoodId);
  return open.sort((a, b) => estimateFoodDelay(a) - estimateFoodDelay(b)).slice(0, MEAL_CANDIDATES);
}

function insideBbox(p){
  const b = walkData?.bbox;
  return !!b && p.lat >= b[0] && p.lat <= b[2] && p.lng >= b[1] && p.lng <= b[3];
}

function startPoint(){
  const gpsUsable = gps && gps.accuracy <= 50;
  if(gpsUsable && insideBbox(gps)) return { lat:gps.lat, lng:gps.lng, source:"gps" };

  const last = [...completedRideKeys].reverse()
    .map(key => latestRides.find(r => rideKey(r) === key))
    .find(r => r?.lat && r?.lng);
  if(last) return { lat:last.lat, lng:last.lng, node:walkData?.anchors?.[last.id]?.node, source:"last", gpsOutside:!!gpsUsable };

  const entrance = walkData?.anchors?.entrance;
  if(entrance){
    const [lat, lng] = walkData.nodes[entrance.node];
    return { lat, lng, node:entrance.node, source:"entrance", gpsOutside:!!gpsUsable };
  }
  const [lat, lng] = PARK_CENTERS[selectedPark];
  return { lat, lng, source:"entrance", gpsOutside:!!gpsUsable };
}

function buildPlanRequest({ force, prefsChanged, unlock }){
  // Restaurants have no live status, so when no ride is running the park is closed: no meal either.
  const parkOpen = latestRides.some(r => r.type !== "food" && r.is_open);
  const mealDone = !parkOpen || latestRides.some(r => r.type === "food" && completedRideKeys.includes(rideKey(r)));
  const rides = latestRides.filter(r => r.type !== "food" && r.is_open && r.lat && r.lng && !completedRideKeys.includes(rideKey(r)));
  const node = r => walkData?.anchors?.[r.id]?.node;

  const stops = [
    ...rides.map(r => {
      const d = rideDetailsFor(rideDetails, r);
      return {
        id:rideKey(r), name:r.name, kind: r.type === "show" && r.showtimes?.length ? "show" : "ride",
        lat:r.lat, lng:r.lng, node:node(r), wait:r.wait_time, duration:d.durationMin,
        thrill:d.thrill, popularity:d.popularity, kidFriendly:d.kidFriendly, minHeightIn:d.minHeightIn,
        showtimes:r.showtimes
      };
    }),
    ...(mealDone ? [] : mealCandidates()).map(f => ({
      id:rideKey(f), name:f.name, kind:"meal", lat:f.lat, lng:f.lng, node:node(f), mealDelay:estimateFoodDelay(f)
    }))
  ];

  const remainingPlan = planState.ids.filter(id => !completedRideKeys.includes(id));
  const names = Object.fromEntries(latestRides.map(r => [rideKey(r), r.name]));

  return {
    start: startPoint(),
    stops,
    plannerInput: {
      prefs: { ...userPrefs, food: mealDone ? "skip-food" : userFoodPlan },
      now: parkNow(),
      planStart: planStartMin,
      budgetEnd: budgetEndMin(),
      mustRideIds: mustRideIds.filter(id => !completedRideKeys.includes(id)),
      lockedNextId: unlock ? null : lockedNextId,
      avoidIds: [...shownRideIds],
      previousPlan: remainingPlan.length ? { ids:remainingPlan, names, closed:remainingPlan.filter(id => latestRides.some(r => rideKey(r) === id && r.type !== "food" && !r.is_open)) } : null,
      previousWaits,
      prefsChanged,
      force,
      seed: hashSeed(`${PARK_SLUGS[selectedPark]}|${parkDate}|${planStartMin}`),
      maxIterations: 40000,
      timeLimitMs: 300,
      beamWidth: 200
    }
  };
}

async function requestPlan({ force = false, prefsChanged = false, unlock = false } = {}){
  if(!latestRides.length || planStartMin === null) return null;
  if(prefsChanged){ shownRideIds.clear(); recentPlans = []; fitRouteNext = true; }   // new settings, fresh recommendations
  const request = buildPlanRequest({ force, prefsChanged, unlock });
  const id = ++planRequestId;
  let reply = await planner.run(request, id);
  if(!reply) reply = await planner.run(request, id);   // worker died; client now plans on the main thread
  if(id !== planRequestId) return null;                // a newer request superseded this one
  if(!reply?.ok){
    console.error("[RideFlow] planner failed:", reply?.error);
    return null;
  }
  applyPlan(reply, request);
  renderRoute();
  return planState;
}

function applyPlan(reply, request){
  const { result, legs, baseline, estimated } = reply;
  const prior = planState.ids.filter(id => !completedRideKeys.includes(id));
  planState = {
    ids: result.plan.ids,
    timeline: result.plan.timeline,
    legs, baseline, estimated,
    warnings: result.warnings,
    reason: result.reason,
    lockDropped: result.lockDropped,
    mealStatus: result.mealStatus,
    startSource: request.start.source,
    gpsOutside: !!request.start.gpsOutside,
    summary: { rides:result.plan.rides, end:result.plan.end, walkMeters:result.plan.walkMeters, walkMin:result.plan.walkMin, waitMin:result.plan.waitMin },
    moved: prior.length ? result.plan.ids.filter((id, i) => prior.indexOf(id) !== i) : []
  };
  lockedNextId = result.plan.ids[0] ?? null;
  persistDay();
}

function detectLineSpike(openRides){
  const rising = openRides
    .filter(r => r.type !== "food")
    .map(r => {
      const oldWait = previousWaits[rideKey(r)];
      const currentWait = r.wait_time;

      if(oldWait === undefined) return null;

      const jump = currentWait - oldWait;

      return {
        ...r,
        jump,
        spikeRisk: jump * 3 + currentWait * 0.35
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

// Wait + walk per ride vs a "nearest ride next" day, times the rides you'll do.
function calculateTimeSaved(){
  const s = planState.summary, b = planState.baseline;
  if(!s?.rides || !b?.rides) return "0.0";
  const planPerRide = (s.waitMin + s.walkMin) / s.rides;
  const basePerRide = b.waitWalkMin / b.rides;
  return (Math.max(0, (basePerRide - planPerRide) * s.rides) / 60).toFixed(1);
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

// "Reevaluate" asks for different rides: the rides of the last two plans count for less
// (must-rides and the meal stay), so headliners come back after a couple of presses.
async function reevaluateRoute(){
  const btn = document.getElementById("reevaluateBtn");
  const optionalRides = ids => ids.filter(id =>
    !mustRideIds.includes(id) && latestRides.some(r => rideKey(r) === id && r.type !== "food"));
  const current = optionalRides(currentStops().map(rideKey));
  const bringsNew = plan => !!plan && optionalRides(plan.ids).some(id => !current.includes(id));

  recentPlans = [current, ...recentPlans].slice(0, 2);
  fitRouteNext = true;
  shownRideIds = new Set(recentPlans.flat());
  btn.disabled = true;
  let plan = await requestPlan({ force:true, unlock:true });
  if(plan && !bringsNew(plan)){
    shownRideIds = new Set(current);
    plan = await requestPlan({ force:true, unlock:true });
  }
  btn.disabled = false;
  btn.textContent = bringsNew(plan) ? "New rides picked" : "No other rides fit right now";
  setTimeout(() => btn.textContent = "Reevaluate route", 1500);
}

function completeRide(key){
  if(!completedRideKeys.includes(key)){
    completedRideKeys.push(key);
  }
  persistDay();

  // Checking off the next stop locks the one after it (spec §6.5).
  if(planState.ids[0] === key) lockedNextId = planState.ids[1] ?? null;

  document.querySelectorAll(`[data-ride="${CSS.escape(key)}"]`).forEach(row => {
    row.querySelector(".check")?.classList.add("done");
    row.classList.add("leaving");
  });

  const goNow = document.getElementById("goNowCheck");
  if(goNow.dataset.key === key) goNow.classList.add("done");

  setTimeout(() => {
    goNow.classList.remove("done");
    renderRoute();
    requestPlan();
  }, 400);
}

function togglePriorityItem(key){
  const item = latestRides.find(r => rideKey(r) === key);
  if(item?.type === "food") selectedFoodId = selectedFoodId === key ? null : key;
  else if(mustRideIds.includes(key)) mustRideIds = mustRideIds.filter(id => id !== key);
  else mustRideIds.push(key);
  renderMustRideList(latestRides);
  requestPlan({ prefsChanged:true });
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

  // Stadia Maps dark tiles. Localhost needs no key; a live site registers its domain in the
  // Stadia dashboard (no key in code), or sets STADIA_API_KEY for other setups.
  const key = STADIA_API_KEY ? `?api_key=${encodeURIComponent(STADIA_API_KEY)}` : "";
  L.tileLayer(`https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png${key}`, {
    maxZoom:20,
    attribution:'&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
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

  // Only the next few stops get numbered pins; later ones are plain dots like any other ride.
  const stops = currentStops().slice(0, MAP_STOPS);
  const stopKeys = new Set(stops.map(rideKey));

  latestRides
    .filter(r => r.type !== "food" && !stopKeys.has(rideKey(r)))
    .forEach(r => addMarker(r, dotIcon(r), 0));

  stops.forEach((r,i) => addMarker(r, pinIcon(r,i), 1000 - i));

  drawYouAreHere();
}

function dotIcon(ride){
  const cls = ride.is_open ? waitClass(ride.wait_time) : "closed";
  return L.divIcon({ className:"", html:`<div class="dot ${cls}"></div>`, iconSize:[12,12], iconAnchor:[6,6] });
}

function pinIcon(ride, index){
  const size = index === 0 ? 34 : 28;
  const moved = planState.moved.includes(rideKey(ride));
  const cls = ["pin", ride.type === "food" ? "food" : "", index === 0 ? "first" : "", moved ? "moved" : ""].join(" ").trim();
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

  const legs = planState.ids
    .map((id, i) => ({ id, coords: planState.legs[i] }))
    .filter(leg => !completedRideKeys.includes(leg.id) && leg.coords?.length >= 2)
    .slice(0, MAP_STOPS);

  parkMap.invalidateSize();

  if(!legs.length){
    // Before the first plan arrives, show the park but keep the pending fit for the real route.
    if(fitRouteNext){ fitToRides(); if(planState.summary) fitRouteNext = false; }
    return;
  }

  // Next leg: neon tube (haze, glow, core, white-hot centre). Later legs: dim.
  const style = { color:"#aeff00", lineCap:"round", lineJoin:"round", interactive:false };
  const nextLeg = [
    { weight:22, opacity:.08 }, { weight:12, opacity:.2 }, { weight:4, opacity:1 }, { weight:1.5, opacity:.85, color:"#f4ffd6" }
  ];
  const laterLeg = [{ weight:10, opacity:.07 }, { weight:3, opacity:.45 }];

  legs.slice().reverse().forEach((leg, r) => {
    const isNext = r === legs.length - 1;
    (isNext ? nextLeg : laterLeg).forEach(o => routeLayers.push(L.polyline(leg.coords, { ...style, ...o }).addTo(parkMap)));
  });

  // Re-fit only when asked; routine refreshes and check-offs keep the guest's view,
  // gliding just enough to keep the next stop on screen.
  if(fitRouteNext){
    const bounds = L.latLngBounds(legs.flatMap(leg => leg.coords));
    if(routeDrawnOnce && !prefersReducedMotion()) parkMap.flyToBounds(bounds, { padding:[56,56], duration:.8 });
    else parkMap.fitBounds(bounds, { padding:[56,56], animate:false });
    fitRouteNext = false;
    routeDrawnOnce = true;
  }else{
    const nextStop = legs[0].coords.at(-1);
    if(!parkMap.getBounds().pad(-0.1).contains(nextStop)) parkMap.panTo(nextStop, { animate:!prefersReducedMotion(), duration:.6 });
  }
}

let routeDrawnOnce = false;

function prefersReducedMotion(){
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
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

    if(data.timezone) parkTimeZone = data.timezone;
    const nowMin = parkNow();

    const locationMap = {};
    childrenData.children.forEach(c => {
      if(c.location){
        locationMap[c.id] = {
          lat:c.location.latitude,
          lng:c.location.longitude
        };
      }
    });

    const attractions = liveAttractions(data.liveData, locationMap, parkTimeZone, parkDate, nowMin, cleanRideName);

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

    document.getElementById("nextRetry").classList.add("hidden");
    renderRoute();

    const planned = requestPlan();   // reads the old previousWaits synchronously
    previousWaits = Object.fromEntries(latestRides.map(r => [rideKey(r), r.wait_time]));
    await planned;

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

  setMapStatus(
    !anyOpen ? `${selectedPark} is closed right now. The map shows where every ride is.`
    : planState.estimated ? "Walking times are estimates."
    : planState.gpsOutside ? "Planning from the park entrance."
    : ""
  );

  updateNavigationMode(stops, anyOpen);
  updateRouteConfidence(stops);
  updateTrustLayer(stops, anyOpen);
  renderRouteList(stops, anyOpen);
  renderMustRideList(latestRides);
  updateAI(stops, anyOpen);
  updateMetrics(stops);
  updateWarRoom(stops);
}

function emptyReason(anyOpen){
  const openRidesLeft = latestRides.filter(r => r.type !== "food" && r.is_open && !completedRideKeys.includes(rideKey(r))).length;
  return emptyRouteReason({ planned: planState.summary !== null, anyOpen, openRidesLeft });
}

function updateNavigationMode(stops, anyOpen){
  const label = document.getElementById("nextLabel");
  const main = document.getElementById("navMain");
  const sub = document.getElementById("navSub");
  const wait = document.getElementById("nextWait");
  const check = document.getElementById("goNowCheck");
  const current = stops[0];
  const next = stops[1];

  const meta = document.getElementById("nextMeta");
  const reasonEl = document.getElementById("planReason");
  const lockedName = planState.lockDropped && latestRides.find(r => rideKey(r) === planState.lockDropped)?.name;
  const reasonText = lockedName ? `${lockedName} is temporarily closed.` : planState.reason;
  reasonEl.textContent = reasonText || "";
  reasonEl.classList.toggle("hidden", !reasonText);
  renderWarnings();

  if(!current){
    check.classList.add("hidden");
    wait.textContent = "";
    meta.textContent = "";
    const why = emptyReason(anyOpen);

    if(why === "planning"){
      label.textContent = "Next up";
      main.textContent = "Calculating your best move…";
      sub.textContent = "RideFlow is building your route.";
    }else if(why === "closed"){
      label.textContent = "Park closed";
      main.textContent = `${selectedPark} is closed right now`;
      sub.textContent = "No rides are reporting live waits. Your route builds automatically once rides open, or you can pick another park in Settings.";
    }else if(why === "no-time"){
      label.textContent = "Time's up";
      main.textContent = "Not enough time left for another ride";
      sub.textContent = "Nothing open fits in your remaining time. Add time in Settings, or check back when waits drop.";
    }else{
      label.textContent = "Route complete";
      main.textContent = "You’ve cleared your route";
      sub.textContent = "Every open ride on your list is done. Star more rides below to keep going.";
    }
    return;
  }

  if(current && rideKey(current) !== lastNextKey){
    lastNextKey = rideKey(current);
    if(!prefersReducedMotion()){
      document.querySelector(".next-row").animate(
        [{ opacity:0, transform:"translateY(6px)" }, { opacity:1, transform:"none" }],
        { duration:320, easing:"cubic-bezier(.2,.8,.2,1)" });
    }
  }

  label.textContent = current.type === "food" ? "Next up: meal stop" : "Next up";
  check.classList.remove("hidden");
  check.dataset.key = rideKey(current);
  check.setAttribute("aria-label", `Mark ${current.name} as done`);

  main.textContent = current.name;
  sub.textContent = next ? `Then ${next.name}` : "Last stop on your route";

  if(current.type === "food"){
    // The label already says "meal stop"; leave the title the full width.
    wait.className = "next-wait meal";
    wait.textContent = "";
  } else {
    wait.className = "next-wait " + waitClass(current.wait_time);
    wait.innerHTML = current.wait_time > 0 ? `${current.wait_time}<span class="unit">min</span>` : `<span class="no-wait">No wait</span>`;
  }

  const walk = Math.max(1, Math.round(current.walkMin || 0));
  const waitPart = current.type === "food"
    ? `about ${estimateFoodDelay(current)} min in line`
    : current.type === "show" ? `starts ${minutesToClock(current.start)}`
    : current.wait_time > 0 ? `${current.wait_time} min wait` : "no wait";
  meta.textContent = `${walk} min walk · ${waitPart}`;
}

function renderWarnings(){
  const el = document.getElementById("planWarnings");
  const nameOf = id => latestRides.find(r => rideKey(r) === id)?.name || "A must-ride";
  const remaining = formatDuration(Math.max(0, budgetEndMin() - parkNow()));
  el.innerHTML = planState.warnings.map(w => w.type === "must-ride-no-fit"
    ? `<p class="plan-warning">${esc(nameOf(w.id))} doesn’t fit in your remaining ${remaining}.<button type="button" onclick="showScreen('settings', document.querySelectorAll('.nav button')[2])">Add time</button></p>`
    : `<p class="plan-warning">${esc(nameOf(w.id))} is closed right now.</p>`
  ).join("");
  el.classList.toggle("hidden", !planState.warnings.length);
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
    message = { planning:"Building your route…", "no-time":"No time left for another ride" }[emptyReason(anyOpen)] || "Route complete";
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

function routeRowHtml(r, i){
  const key = esc(rideKey(r));
  const food = r.type === "food";
  return `
    <button class="check" data-action="complete" data-key="${key}" aria-label="Mark ${esc(r.name)} as done">${CHECK_SVG}</button>
    <span class="stop-num${food ? " food" : ""}">${i + 1}</span>
    <span class="row-name">${esc(r.name)}${food ? `<span class="row-sub">${esc(r.food_time)}</span>` : ""}</span>
    <span class="eta">~${minutesToClock(r.arrive)}</span>
    <span class="wait ${food ? "meal" : waitClass(r.wait_time)}">${food ? "Meal" : waitText(r.wait_time)}</span>
  `;
}

// Rows are updated in place instead of rebuilt: kept rows glide to their new position,
// new rows fade in, and dropped rows leave without making the list jump.
function renderRouteList(stops, anyOpen){
  const el = document.getElementById("rideList");

  if(!stops.length){
    el.innerHTML = `<p class="empty">${anyOpen ? "Nothing left on your route." : "Your route will appear here when rides open."}</p>`;
    document.getElementById("routeSummary").textContent = "";
    return;
  }
  el.querySelector(".empty")?.remove();

  const wanted = stops.slice(0, 10);
  const keep = new Set(wanted.map(rideKey));
  const rows = new Map([...el.querySelectorAll(".row[data-ride]")].map(row => [row.dataset.ride, row]));
  const before = new Map([...rows].map(([key, row]) => [key, row.getBoundingClientRect().top]));

  rows.forEach((row, key) => { if(!keep.has(key)) row.remove(); });

  wanted.forEach((r, i) => {
    const key = rideKey(r);
    let row = rows.get(key);
    if(!row){
      row = document.createElement("div");
      row.className = "row row-enter";
      row.dataset.ride = key;
      row.addEventListener("animationend", () => row.classList.remove("row-enter"), { once:true });
    }
    const html = routeRowHtml(r, i);
    if(row.dataset.sig !== html){ row.innerHTML = html; row.dataset.sig = html; }
    el.appendChild(row);
  });

  if(!prefersReducedMotion()){
    el.querySelectorAll(".row[data-ride]").forEach(row => {
      const top = before.get(row.dataset.ride);
      if(top === undefined) return;
      const dy = top - row.getBoundingClientRect().top;
      if(Math.abs(dy) > 1) row.animate([{ transform:`translateY(${dy}px)` }, { transform:"none" }], { duration:320, easing:"cubic-bezier(.2,.8,.2,1)" });
    });
  }

  const s = planState.summary;
  document.getElementById("routeSummary").textContent = s && s.rides
    ? `${s.rides} ride${s.rides === 1 ? "" : "s"} planned · ends ~${minutesToClock(s.end)} · ${(s.walkMeters / 1609.34).toFixed(1)} mi walking`
    : "";
}

function rideCategory(ride){
  if(ride.type === "food") return "Food";
  const d = rideDetailsFor(rideDetails, ride);
  if(ride.type === "show" || d.type === "show") return "Shows";
  if(d.thrill >= 4) return "Thrill";
  if(d.kidFriendly && d.thrill <= 2) return "Kids";
  return "Other";
}

// Restaurants have no ride details; skip the lookup so they don't log as missing.
function popularityOf(ride){
  return ride.type === "food" ? 0 : rideDetailsFor(rideDetails, ride).popularity || 0;
}

function renderMustRideList(rides){
  const el = document.getElementById("mustRideList");
  const groups = { Thrill:[], Kids:[], Shows:[], Food:[], Other:[] };
  const openGroups = [...el.querySelectorAll("details[open]")].map(d => d.dataset.group);

  rides
    .filter(r => r && r.name && !completedRideKeys.includes(rideKey(r)))
    .sort((a, b) => popularityOf(b) - popularityOf(a) || a.name.localeCompare(b.name))
    .forEach(r => groups[rideCategory(r)].push(r));

  el.innerHTML = Object.keys(groups).filter(g => groups[g].length).map(group => `
    <details class="group" data-group="${group}"${openGroups.includes(group) ? " open" : ""}>
      <summary>${GROUP_LABELS[group]}<span class="count">${groups[group].length}</span></summary>
      <div class="list">
        ${groups[group].map(r => {
          const food = r.type === "food";
          const key = rideKey(r);
          const on = mustRideIds.includes(key) || selectedFoodId === key;
          const status = food ? `~${estimateFoodDelay(r)} min` : r.is_open ? waitText(r.wait_time) : "Closed";
          const cls = food ? "meal" : r.is_open ? waitClass(r.wait_time) : "closed";
          const action = on ? "Remove" : "Add";
          const target = food ? "as your meal stop" : "as a must-ride";

          return `
            <div class="row">
              <button class="star${on ? " on" : ""}" data-action="star" data-key="${esc(key)}" aria-pressed="${on}" aria-label="${action} ${esc(r.name)} ${target}">${STAR_SVG}</button>
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
    const oldWait = previousWaits[rideKey(r)];
    return oldWait && oldWait >= 45 && oldWait - r.wait_time >= 20;
  });

  document.getElementById("aiNext").innerHTML = best.type === "food"
    ? `Head to <strong>${esc(best.name)}</strong> for your meal stop.`
    : `Head to <strong>${esc(best.name)}</strong> (${best.wait_time > 0 ? best.wait_time + " min wait" : "no wait"}).`;

  document.getElementById("aiAlertTitle").textContent = droppedRide ? "Wait drop" : "Crowd alert";
  document.getElementById("aiAlert").innerHTML = droppedRide
    ? `<strong>${esc(droppedRide.name)}</strong> fell from ${previousWaits[rideKey(droppedRide)]} to ${droppedRide.wait_time} min.`
    : worst ? `Avoid <strong>${esc(worst.name)}</strong> for now (${worst.wait_time} min wait).` : "No long waits on your route.";

  const s = planState.summary;
  document.getElementById("aiProjection").innerHTML = s?.rides
    ? `<strong>${s.rides} rides</strong> planned before ${minutesToClock(s.end)}.`
    : "No more rides fit in your remaining time.";

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
    document.getElementById("sessionTime").innerHTML = `${calculateTimeSaved()}<span class="unit">hours</span>`;
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
    banner.textContent = "No meal planned. Your route focuses fully on rides.";
    return;
  }
  if(latestRides.length && !latestRides.some(r => r.type !== "food" && r.is_open)){
    banner.className = "banner info";
    banner.textContent = "No meal planned while the park is closed.";
    return;
  }
  const meal = currentStops().find(r => r.type === "food");
  if(meal){
    banner.className = "banner info";
    banner.innerHTML = `Meal stop at <strong>${esc(meal.name)}</strong> around ${minutesToClock(meal.start)}. Expect about ${estimateFoodDelay(meal)} min in line.`;
    return;
  }
  if(latestRides.some(r => r.type === "food" && completedRideKeys.includes(rideKey(r)))){
    banner.className = "banner good";
    banner.textContent = "Meal done. The rest of your day is rides.";
    return;
  }
  const text = {
    "window-passed": "Your meal window has passed, so your plan is rides only.",
    "no-time": "There isn’t time for a meal stop in your remaining plan.",
    "no-restaurant": "No restaurants near your route are available right now."
  }[planState.mealStatus] || "Finding the best meal window…";
  banner.className = "banner warn";
  banner.textContent = text;
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
    const why = emptyReason(true);
    banner.className = why === "complete" ? "banner good" : "banner";
    banner.textContent = { planning:"Building your route…", "no-time":"No open ride fits in your remaining time." }[why] || "Your route is complete.";
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

  const s = planState.summary;
  document.getElementById("walkScore").innerHTML = s ? `${(s.walkMeters / 1609.34).toFixed(1)}<span class="unit">mi</span>` : "--";
  document.getElementById("walkText").textContent = s ? `${Math.round(s.walkMin)} min of walking across your plan.` : "Add more rides to see your walking.";
}

// index.html's inline onclick handlers call these; module scope isn't global.
Object.assign(window, { showScreen, toggleMobileMenu, fetchLiveWaitTimes, reevaluateRoute, launchApp, centerOnMe, startOver });

// A refresh during the same park day goes straight back to the map.
const savedDay = loadDay(deviceStorage(), new Date());
if(savedDay) resumeDay(savedDay);
