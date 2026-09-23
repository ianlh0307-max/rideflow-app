// Why the route is empty, so the page never claims "route complete" when it isn't.
export function emptyRouteReason({ planned, anyOpen, openRidesLeft }){
  if(!planned) return "planning";
  if(!anyOpen) return "closed";
  return openRidesLeft > 0 ? "no-time" : "complete";
}
