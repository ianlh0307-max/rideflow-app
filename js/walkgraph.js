// Walkway graph: real walking distances and path shapes between park locations.
// Graph JSON comes from tools/build-walkways.py (data/walkways/<park>.json).

export const DETOUR = 1.35;           // typical walked/straight ratio, used when paths are unknown
const EARTH_RADIUS_M = 6371000;
const TREE_CACHE_LIMIT = 200;

export function metersBetween(a, b){
  const rad = d => d * Math.PI / 180;
  const x = rad(b[1] - a[1]) * Math.cos(rad((a[0] + b[0]) / 2));
  const y = rad(b[0] - a[0]);
  return EARTH_RADIUS_M * Math.hypot(x, y);
}

export function loadWalkGraph(json){
  const adj = Array.from({ length: json.nodes.length }, () => []);
  json.edges.forEach(([a, b, m], edge) => {
    adj[a].push({ to: b, m, edge });
    adj[b].push({ to: a, m, edge });
  });
  return { nodes: json.nodes, edges: json.edges, adj, anchors: json.anchors || {}, bbox: json.bbox || null, trees: new Map() };
}

export function nearestNode(graph, lat, lng){
  let node = -1;
  let snapM = Infinity;
  graph.nodes.forEach((p, i) => {
    const m = metersBetween(p, [lat, lng]);
    if(m < snapM){ snapM = m; node = i; }
  });
  return { node, snapM };
}

class MinHeap{
  constructor(){ this.keys = []; this.vals = []; }
  get size(){ return this.keys.length; }
  push(key, val){
    const K = this.keys, V = this.vals;
    let i = K.length;
    K.push(key); V.push(val);
    while(i > 0){
      const p = (i - 1) >> 1;
      if(K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop(){
    const K = this.keys, V = this.vals;
    const topKey = K[0], topVal = V[0];
    const key = K.pop(), val = V.pop();
    if(K.length){
      let i = 0;
      const n = K.length;
      while(true){
        let c = 2 * i + 1;
        if(c >= n) break;
        if(c + 1 < n && K[c + 1] < K[c]) c++;
        if(K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = val;
    }
    return [topKey, topVal];
  }
}

export function shortestFrom(graph, source){
  const cached = graph.trees.get(source);
  if(cached) return cached;

  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  dist[source] = 0;
  heap.push(0, source);

  while(heap.size){
    const [d, u] = heap.pop();
    if(d > dist[u]) continue;
    for(const { to, m, edge } of graph.adj[u]){
      const nd = d + m;
      if(nd < dist[to]){
        dist[to] = nd;
        prevNode[to] = u;
        prevEdge[to] = edge;
        heap.push(nd, to);
      }
    }
  }

  if(graph.trees.size >= TREE_CACHE_LIMIT) graph.trees.clear();
  const tree = { dist, prevNode, prevEdge };
  graph.trees.set(source, tree);
  return tree;
}

export function walkMatrix(graph, nodes, speedMpm){
  const meters = nodes.map(from => {
    const { dist } = shortestFrom(graph, from);
    return nodes.map(to => Number.isFinite(dist[to])
      ? dist[to]
      : metersBetween(graph.nodes[from], graph.nodes[to]) * DETOUR);
  });
  return { meters, minutes: meters.map(row => row.map(m => m / speedMpm)) };
}

export function straightMatrix(points, speedMpm){
  const meters = points.map(a => points.map(b => metersBetween(a, b) * DETOUR));
  return { meters, minutes: meters.map(row => row.map(m => m / speedMpm)) };
}

export function pathBetween(graph, from, to){
  if(from === to) return [graph.nodes[from]];
  const { prevNode, prevEdge } = shortestFrom(graph, from);
  if(prevNode[to] === -1) return [graph.nodes[from], graph.nodes[to]];

  const hops = [];
  for(let v = to; v !== from; v = prevNode[v]) hops.push([prevNode[v], v, prevEdge[v]]);
  hops.reverse();

  const coords = [graph.nodes[from]];
  for(const [u, v, e] of hops){
    const [a, , , geom = []] = graph.edges[e];
    coords.push(...(a === u ? geom : [...geom].reverse()), graph.nodes[v]);
  }
  return coords;
}
