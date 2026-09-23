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
