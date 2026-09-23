import { test, assert, assertEqual } from "./harness.js";
import { saveDay, loadDay, clearDay, isDayOver, SESSION_KEY } from "../js/session.js";

function fakeStorage(initial = {}){
  const data = { ...initial };
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    data
  };
}

const DAY = {
  park: "Magic Kingdom", timeZone: "America/New_York", parkDate: "2026-09-23", closeMin: 22 * 60,
  planStartMin: 9 * 60, prefs: { groupSize: 4, parkHours: 6, thrill: "balanced", walking: "balanced" },
  food: "eat-late", completed: ["a"], mustRideIds: ["b"], selectedFoodId: null, recentPlans: [["c"]], lockedNextId: "d"
};

test("a saved day comes back unchanged the same day", () => {
  const storage = fakeStorage();
  saveDay(storage, DAY);
  assertEqual(loadDay(storage, new Date("2026-09-23T18:00:00Z")), DAY);   // 2 PM in Orlando
});

test("the day is over after the park closes (park time)", () => {
  assert(!isDayOver(DAY, new Date("2026-09-24T01:59:00Z")), "9:59 PM should still be today");
  assert(isDayOver(DAY, new Date("2026-09-24T02:01:00Z")), "10:01 PM is after close");
});

test("an after-midnight close keeps the day alive until it closes", () => {
  const late = { ...DAY, closeMin: 25 * 60 };
  assert(!isDayOver(late, new Date("2026-09-24T04:30:00Z")), "00:30 before a 1 AM close");
  assert(isDayOver(late, new Date("2026-09-24T05:05:00Z")), "01:05 after a 1 AM close");
});

test("without a known close, the day ends at midnight park time", () => {
  const unknown = { ...DAY, closeMin: null };
  assert(!isDayOver(unknown, new Date("2026-09-24T03:30:00Z")), "11:30 PM");
  assert(isDayOver(unknown, new Date("2026-09-24T04:10:00Z")), "12:10 AM next day");
});

test("an expired day is ignored and removed", () => {
  const storage = fakeStorage();
  saveDay(storage, DAY);
  assertEqual(loadDay(storage, new Date("2026-09-25T15:00:00Z")), null);
  assertEqual(storage.getItem(SESSION_KEY), null);
});

test("damaged or foreign saved data is ignored, not thrown", () => {
  assertEqual(loadDay(fakeStorage({ [SESSION_KEY]: "{not json" }), new Date()), null);
  assertEqual(loadDay(fakeStorage({ [SESSION_KEY]: JSON.stringify({ v: 99, park: "x" }) }), new Date()), null);
  assertEqual(loadDay(fakeStorage({ [SESSION_KEY]: JSON.stringify({ v: 1, park: "Nowhere Land" }) }), new Date()), null);
});

test("storage that throws (private mode) doesn't break saving or loading", () => {
  const broken = { getItem(){ throw new Error("denied"); }, setItem(){ throw new Error("denied"); }, removeItem(){ throw new Error("denied"); } };
  saveDay(broken, DAY);
  clearDay(broken);
  assertEqual(loadDay(broken, new Date()), null);
});

test("clearDay forgets the saved day", () => {
  const storage = fakeStorage();
  saveDay(storage, DAY);
  clearDay(storage);
  assertEqual(loadDay(storage, new Date("2026-09-23T18:00:00Z")), null);
});
