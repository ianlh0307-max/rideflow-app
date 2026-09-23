import { test, assertEqual } from "./harness.js";
import { emptyRouteReason } from "../js/status.js";

test("empty route: still planning before the first plan arrives (review #11)", () => {
  assertEqual(emptyRouteReason({ planned:false, anyOpen:true, openRidesLeft:20 }), "planning");
});

test("empty route: park closed", () => {
  assertEqual(emptyRouteReason({ planned:true, anyOpen:false, openRidesLeft:0 }), "closed");
});

test("empty route with open rides left means nothing fits, not 'complete' (review #2)", () => {
  assertEqual(emptyRouteReason({ planned:true, anyOpen:true, openRidesLeft:12 }), "no-time");
});

test("empty route with every open ride done is complete", () => {
  assertEqual(emptyRouteReason({ planned:true, anyOpen:true, openRidesLeft:0 }), "complete");
});
