// Curated ride details (data/rides/<park>.json) with a name-based fallback for
// attractions the file doesn't know about yet.

const warned = new Set();

export function rideDetailsFor(details, ride){
  const curated = details?.[ride.id];
  if(curated) return curated;
  if(!warned.has(ride.id)){
    warned.add(ride.id);
    console.warn(`[RideFlow] missing ride details: ${ride.name} ${ride.id}`);
  }
  return fallbackDetails(ride.name, ride.type);
}

export function fallbackDetails(name, type){
  const n = String(name || "").toLowerCase();
  const has = (...words) => words.some(w => n.includes(w));

  if(type === "show" || has("show", "theater", "theatre", "philharmagic", "presents", "jamboree", "hall of", "musical")){
    return { type:"show", thrill:1, popularity:1, kidFriendly:true, minHeightIn:null, durationMin:15 };
  }
  if(has("coaster", "mountain", "tower", "thunder", "dragster", "force", "drop")){
    return { type:"coaster", thrill:4, popularity:1, kidFriendly:false, minHeightIn:44, durationMin:3 };
  }
  if(has("dumbo", "carousel", "carrousel", "small world", "teacup", "tea cup", "kiddie", "junior", "jr.")){
    return { type:"spinner", thrill:1, popularity:1, kidFriendly:true, minHeightIn:null, durationMin:3 };
  }
  return { type:"dark-ride", thrill:3, popularity:1, kidFriendly:true, minHeightIn:null, durationMin:5 };
}
