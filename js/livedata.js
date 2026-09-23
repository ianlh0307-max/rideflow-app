// Park-local time helpers. Every planner time is "minutes since midnight in the
// park's time zone on the park's date"; times after midnight continue past 1440.

export function parkClock(date, timeZone){
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit", hourCycle:"h23"
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return { date:`${parts.year}-${parts.month}-${parts.day}`, minutes:Number(parts.hour) * 60 + Number(parts.minute) };
}

export function isoToParkMinutes(iso, timeZone, parkDate){
  const clock = parkClock(new Date(iso), timeZone);
  const dayOffset = Math.round((Date.parse(clock.date) - Date.parse(parkDate)) / 86400000);
  return clock.minutes + dayOffset * 1440;
}

export function closingMinutes(scheduleJson, timeZone, parkDate){
  const today = (scheduleJson?.schedule || [])
    .filter(s => s.date === parkDate && s.type === "OPERATING" && s.closingTime);
  if(!today.length) return null;
  return Math.max(...today.map(s => isoToParkMinutes(s.closingTime, timeZone, parkDate)));
}

export function showtimeMinutes(showtimes, timeZone, parkDate){
  return (showtimes || [])
    .filter(s => s.startTime)
    .map(s => isoToParkMinutes(s.startTime, timeZone, parkDate))
    .sort((a, b) => a - b);
}

export function minutesToClock(minutes){
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(m / 60);
  const suffix = hour24 >= 12 ? "PM" : "AM";
  return `${hour24 % 12 || 12}:${String(m % 60).padStart(2, "0")} ${suffix}`;
}

export function formatDuration(minutes){
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
}

// Fallback when the schedule endpoint fails, so time never drifts to the phone's zone.
export const PARK_TIMEZONES = {
  "Magic Kingdom": "America/New_York", "EPCOT": "America/New_York", "Hollywood Studios": "America/New_York",
  "Animal Kingdom": "America/New_York", "Disneyland": "America/Los_Angeles",
  "Cedar Point": "America/New_York", "Kings Island": "America/New_York"
};

// The park day we're in: the OPERATING entry whose hours contain now (so 00:20 during a
// 1 AM close still belongs to yesterday), otherwise the park's calendar date.
export function operatingDay(scheduleJson, timeZone, now){
  const t = now.getTime();
  const current = (scheduleJson?.schedule || []).find(s =>
    s.type === "OPERATING" && s.openingTime && s.closingTime &&
    Date.parse(s.openingTime) <= t && t < Date.parse(s.closingTime)
  );
  const parkDate = current ? current.date : parkClock(now, timeZone).date;
  return { parkDate, closeMin: closingMinutes(scheduleJson, timeZone, parkDate) };
}

// Live attractions plus shows that still have a performance ahead. A show whose
// performances are all over is dropped, not treated as a walk-up attraction.
export function liveAttractions(liveData, locations, timeZone, parkDate, nowMin, cleanName = n => n){
  return liveData
    .filter(r => r.entityType === "ATTRACTION" || r.entityType === "SHOW")
    .map(r => {
      const show = r.entityType === "SHOW";
      const upcoming = show ? showtimeMinutes(r.showtimes, timeZone, parkDate).filter(t => t > nowMin) : undefined;
      if(show && !upcoming.length) return null;
      const loc = locations[r.id] || {};
      return {
        id: r.id,
        name: cleanName(r.name),
        type: show ? "show" : "ride",
        is_open: r.status === "OPERATING",
        wait_time: Number(r.queue?.STANDBY?.waitTime ?? 0),
        showtimes: upcoming,
        lat: loc.lat,
        lng: loc.lng
      };
    })
    .filter(Boolean);
}
