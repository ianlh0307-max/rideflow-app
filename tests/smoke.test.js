import { test, assertEqual } from "./harness.js";

test("harness runs a passing test", () => {
  assertEqual(1 + 1, 2);
});
