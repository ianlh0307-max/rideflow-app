// Saves the guest's day on the device so a refresh drops them back into it.
// The saved day lasts until that park day is over (after closing, in park time).
import { isoToParkMinutes, PARK_TIMEZONES } from "./livedata.js";

export const SESSION_KEY = "rideflow.day.v1";
const VERSION = 1;

export function saveDay(storage, day){
  try{
    storage.setItem(SESSION_KEY, JSON.stringify({ v: VERSION, ...day }));
  }catch(err){
    // Private browsing or full storage: the day just won't survive a refresh.
  }
}

export function clearDay(storage){
  try{ storage.removeItem(SESSION_KEY); }catch(err){ /* nothing saved to clear */ }
}

export function isDayOver(day, now){
  const minutes = isoToParkMinutes(now.toISOString(), day.timeZone, day.parkDate);
  return minutes > (day.closeMin ?? 24 * 60);
}

export function loadDay(storage, now){
  let day;
  try{
    day = JSON.parse(storage.getItem(SESSION_KEY));
  }catch(err){
    return null;
  }
  if(!isValid(day)) return null;
  if(isDayOver(day, now)){
    clearDay(storage);
    return null;
  }
  const { v, ...rest } = day;
  return rest;
}

function isValid(day){
  return !!day && day.v === VERSION && day.park in PARK_TIMEZONES &&
    typeof day.timeZone === "string" && typeof day.parkDate === "string" &&
    Number.isFinite(day.planStartMin) && !!day.prefs && Array.isArray(day.completed);
}
