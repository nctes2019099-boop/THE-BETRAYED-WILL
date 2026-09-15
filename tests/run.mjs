import { createOrchestrator } from "../js/agents/orchestrator.js";
import { AGENTS_TOTAL, DEPARTMENTS, AGENTS_PER_DEPT } from "../js/agents/departments.js";
import { createSwarm } from "../js/agents/swarm.js";
import { LAYER_STACK } from "../js/game/layers.js";
import { compileWorld } from "../js/game/world.js";
import { runLayerConsistency } from "../js/qa/layerConsistency.js";
import { CAST } from "../js/content/cast.js";
import { SCENES, ENDINGS } from "../js/content/story.js";
import { ENTITIES } from "../js/content/entities.js";
import { PLACE_DEFS } from "../js/content/places.js";

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

assert(DEPARTMENTS.length * AGENTS_PER_DEPT === AGENTS_TOTAL, "roster math");
assert(AGENTS_TOTAL === 10000, "exactly 10000");
const swarm = createSwarm(1);
assert(swarm.length === 10000, "swarm length");
assert(new Set(swarm.map((a) => a.id)).size === 10000, "unique ids");
assert(LAYER_STACK.length === 16, "16 layers");
assert(Object.keys(CAST).length >= 8, "cast size");
assert(Object.keys(ENDINGS).length === 4, "four endings");
assert(PLACE_DEFS.length === 8, "eight places");
assert(ENTITIES.length > 20, "entities");
assert(Object.keys(SCENES).length > 10, "scenes");

const world = compileWorld(2019099);
const qa = runLayerConsistency(world.maps, world.entities);
assert(qa.ok, "layer consistency\n" + qa.findings.filter((f) => !f.pass).map((f) => f.en).join("\n"));

const orch = createOrchestrator(2019099);
orch.fastForward();
assert(orch.state.finished, "pipeline finished");
assert(orch.state.agents.every((a) => a.status === "done"), "all agents done");
assert(orch.state.world && orch.state.qa, "world+qa shipped");
assert(orch.state.qa.ok, "shipped QA clean");

if (failures.length) {
  console.error("FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("PASS");
console.log(" agents", AGENTS_TOTAL);
console.log(" layers", LAYER_STACK.length);
console.log(" QA", qa.pass, "passed", qa.fail, "failed");
console.log(" places", PLACE_DEFS.map((p) => p.id).join(","));
