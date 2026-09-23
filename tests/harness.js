// Minimal browser test harness: register tests, run them, report to tests/run.html.
const tests = [];

// Headless Chrome with a virtual time budget freezes performance.now() during sync code.
export const realClock = (() => {
  const t = performance.now();
  let x = 0;
  for(let i = 0; i < 3e6; i++) x += i;
  return performance.now() - t > 0 && x > 0;
})();

export function test(name, fn, { perf = false } = {}){
  tests.push({ name, fn, perf });
}

export function assert(cond, msg = "assertion failed"){
  if(!cond) throw new Error(msg);
}

export function assertEqual(actual, expected, msg = "values differ"){
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if(a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

export function assertClose(actual, expected, tol, msg = "values not close"){
  if(!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg}: expected ${expected} ± ${tol}, got ${actual}`);
}

export async function run(){
  const results = [];
  for(const t of tests){
    if(t.perf && !realClock){
      results.push({ name:t.name, status:"skip", note:"timing test; open tests/run.html in Chrome to run it" });
      continue;
    }
    try{
      await t.fn();
      results.push({ name:t.name, status:"pass" });
    }catch(err){
      results.push({ name:t.name, status:"fail", note:err.message });
    }
  }
  const count = status => results.filter(r => r.status === status).length;
  return { results, passed:count("pass"), failed:count("fail"), skipped:count("skip") };
}
