import { test, assert, assertEqual } from "./harness.js";
import { rideDetailsFor, fallbackDetails } from "../js/ridedata.js";

const SLUGS = ["magic-kingdom", "epcot", "hollywood-studios", "animal-kingdom", "disneyland", "cedar-point", "kings-island"];
const TYPES = ["coaster", "dark-ride", "water", "show", "spinner", "transport", "walkthrough", "play-area", "simulator"];

test("rideDetailsFor returns curated details when present", () => {
  const details = { "abc": { name:"Space Mountain", type:"coaster", thrill:4, popularity:3, kidFriendly:false, minHeightIn:44, durationMin:3 } };
  assertEqual(rideDetailsFor(details, { id:"abc", name:"Space Mountain", type:"ride" }).thrill, 4);
});

test("rideDetailsFor falls back for unknown rides", () => {
  const d = rideDetailsFor({}, { id:"new-1", name:"Brand New Coaster", type:"ride" });
  assertEqual(d.type, "coaster");
  assertEqual(d.popularity, 1);
});

test("fallbackDetails defaults to thrill 3, popularity 1, 5 min", () => {
  assertEqual(fallbackDetails("Mystery Ride", "ride"), { type:"dark-ride", thrill:3, popularity:1, kidFriendly:true, minHeightIn:null, durationMin:5 });
});

test("fallbackDetails recognises shows and kiddie rides", () => {
  assertEqual(fallbackDetails("Country Bear Musical Jamboree", "ride").type, "show");
  assertEqual(fallbackDetails("Dumbo the Flying Elephant", "ride").thrill, 1);
  assertEqual(fallbackDetails("Street Party", "show").type, "show");
});

for(const slug of SLUGS){
  const json = await fetch(`../data/rides/${slug}.json`).then(r => r.ok ? r.json() : null);
  test(`${slug}: ride details are complete and in range`, () => {
    assert(json, "file missing");
    const entries = Object.entries(json);
    assert(entries.length >= 8, "suspiciously few rides");
    for(const [id, d] of entries){
      const where = `${d.name} (${id})`;
      assert(!d.needsReview, `${where} still needs review`);
      assert(TYPES.includes(d.type), `${where} bad type ${d.type}`);
      assert(Number.isInteger(d.thrill) && d.thrill >= 1 && d.thrill <= 5, `${where} bad thrill`);
      assert([1, 2, 3].includes(d.popularity), `${where} bad popularity`);
      assert(typeof d.kidFriendly === "boolean", `${where} bad kidFriendly`);
      assert(d.minHeightIn === null || (d.minHeightIn >= 32 && d.minHeightIn <= 60), `${where} bad height`);
      assert(d.durationMin > 0 && d.durationMin <= 60, `${where} bad duration`);
    }
  });
}
