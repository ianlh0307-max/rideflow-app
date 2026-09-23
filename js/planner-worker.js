// Runs the day planner off the main thread so the page never freezes.
import { loadWalkGraph } from "./walkgraph.js";
import { runPlanRequest } from "./plan-request.js";

let graph = null;

self.onmessage = event => {
  const msg = event.data;
  if(msg.type === "graph"){
    graph = msg.json ? loadWalkGraph(msg.json) : null;
    return;
  }
  if(msg.type === "plan"){
    try{
      self.postMessage({ id: msg.id, ok: true, ...runPlanRequest(graph, msg.request) });
    }catch(err){
      self.postMessage({ id: msg.id, ok: false, error: String(err?.stack || err) });
    }
  }
};
