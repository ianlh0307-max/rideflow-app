import { test, assertEqual } from "./harness.js";
import { parkClock, isoToParkMinutes, closingMinutes, showtimeMinutes, minutesToClock, formatDuration } from "../js/livedata.js";

test("parkClock uses the park's time zone, not the phone's (Disneyland from Florida)", () => {
  const noonInAnaheim = new Date("2026-09-23T19:00:00Z");
  assertEqual(parkClock(noonInAnaheim, "America/Los_Angeles"), { date:"2026-09-23", minutes:720 });
  assertEqual(parkClock(noonInAnaheim, "America/New_York"), { date:"2026-09-23", minutes:900 });
});

test("isoToParkMinutes handles offsets and the next day", () => {
  assertEqual(isoToParkMinutes("2026-09-23T14:30:00-04:00", "America/New_York", "2026-09-23"), 870);
  assertEqual(isoToParkMinutes("2026-09-24T00:30:00-04:00", "America/New_York", "2026-09-23"), 1470);
});

test("closingMinutes: a 1 AM close is 25:00, not 1:00 (after-midnight close)", () => {
  const schedule = { schedule: [
    { date:"2026-09-23", type:"OPERATING", openingTime:"2026-09-23T09:00:00-04:00", closingTime:"2026-09-24T01:00:00-04:00" },
    { date:"2026-09-24", type:"OPERATING", openingTime:"2026-09-24T09:00:00-04:00", closingTime:"2026-09-24T22:00:00-04:00" }
  ]};
  assertEqual(closingMinutes(schedule, "America/New_York", "2026-09-23"), 1500);
});

test("closingMinutes picks the latest OPERATING close and ignores ticketed events", () => {
  const schedule = { schedule: [
    { date:"2026-09-23", type:"OPERATING", closingTime:"2026-09-23T18:00:00-04:00" },
    { date:"2026-09-23", type:"TICKETED_EVENT", closingTime:"2026-09-23T23:59:00-04:00" }
  ]};
  assertEqual(closingMinutes(schedule, "America/New_York", "2026-09-23"), 1080);
});

test("closingMinutes returns null when there is no schedule for today", () => {
  assertEqual(closingMinutes({ schedule: [] }, "America/New_York", "2026-09-23"), null);
  assertEqual(closingMinutes(null, "America/New_York", "2026-09-23"), null);
});

test("showtimeMinutes converts and sorts start times", () => {
  const showtimes = [
    { type:"Performance Time", startTime:"2026-09-23T15:00:00-04:00" },
    { type:"Performance Time", startTime:"2026-09-23T11:30:00-04:00" },
    { type:"Performance Time" }
  ];
  assertEqual(showtimeMinutes(showtimes, "America/New_York", "2026-09-23"), [690, 900]);
});

test("minutesToClock formats park minutes, wrapping past midnight", () => {
  assertEqual(minutesToClock(0), "12:00 AM");
  assertEqual(minutesToClock(615), "10:15 AM");
  assertEqual(minutesToClock(735), "12:15 PM");
  assertEqual(minutesToClock(1500), "1:00 AM");
});

test("formatDuration", () => {
  assertEqual(formatDuration(25), "25 min");
  assertEqual(formatDuration(100), "1h 40m");
  assertEqual(formatDuration(120), "2h 00m");
});

import { liveAttractions, operatingDay, PARK_TIMEZONES } from "../js/livedata.js";

test("liveAttractions drops shows whose performances are all over (review #1)", () => {
  const live = [
    { id:"parade", name:"Parade", entityType:"SHOW", status:"OPERATING", showtimes:[{ startTime:"2026-09-23T14:00:00-04:00" }] },
    { id:"fireworks", name:"Fireworks", entityType:"SHOW", status:"OPERATING", showtimes:[{ startTime:"2026-09-23T14:00:00-04:00" }, { startTime:"2026-09-23T21:00:00-04:00" }] },
    { id:"ride", name:"Ride", entityType:"ATTRACTION", status:"OPERATING", queue:{ STANDBY:{ waitTime:null } } }
  ];
  const out = liveAttractions(live, { ride:{ lat:1, lng:2 } }, "America/New_York", "2026-09-23", 16 * 60);
  assertEqual(out.map(r => r.id), ["fireworks", "ride"]);
  assertEqual(out[0].type, "show");
  assertEqual(out[0].showtimes, [1260]);
  assertEqual(out[1], { id:"ride", name:"Ride", type:"ride", is_open:true, wait_time:0, showtimes:undefined, lat:1, lng:2 });
});

test("operatingDay: at 00:20 during a 1 AM close, the day is still yesterday's (review #3)", () => {
  const schedule = { schedule: [
    { date:"2026-09-23", type:"OPERATING", openingTime:"2026-09-23T09:00:00-04:00", closingTime:"2026-09-24T01:00:00-04:00" },
    { date:"2026-09-24", type:"OPERATING", openingTime:"2026-09-24T09:00:00-04:00", closingTime:"2026-09-24T23:00:00-04:00" }
  ]};
  assertEqual(operatingDay(schedule, "America/New_York", new Date("2026-09-24T04:20:00Z")), { parkDate:"2026-09-23", closeMin:1500 });
  assertEqual(operatingDay(schedule, "America/New_York", new Date("2026-09-24T15:00:00Z")), { parkDate:"2026-09-24", closeMin:1380 });
});

test("operatingDay without a schedule uses the park's own date and no close (review #4)", () => {
  const noonInAnaheim = new Date("2026-09-23T19:00:00Z");
  assertEqual(PARK_TIMEZONES["Disneyland"], "America/Los_Angeles");
  assertEqual(operatingDay(null, PARK_TIMEZONES["Disneyland"], noonInAnaheim), { parkDate:"2026-09-23", closeMin:null });
});
