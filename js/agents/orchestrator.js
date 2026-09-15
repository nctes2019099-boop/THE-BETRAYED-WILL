import { DEPARTMENTS, PIPELINE_STAGES, AGENTS_TOTAL } from "./departments.js";
import { createSwarm } from "./swarm.js";
import { compileWorld } from "../game/world.js";
import { runLayerConsistency } from "../qa/layerConsistency.js";
import { createErrorBus } from "../qa/errorHandler.js";

const TASKS = {
  prepare: ["تحميل المواصفات", "ضبط البذرة", "تجهيز الطوابير"],
  narrative: ["كتابة المشهد", "مراجعة الحوار", "ربط الأعلام"],
  cast: ["تعريف الشخصية", "ضبط الحركة", "مواءمة الصورة"],
  world: ["نحت التضاريس", "رسم المسار", "وضع الإضاءة"],
  systems: ["ربط القتال", "ضبط التصادم", "دمج المحرّك"],
  present: ["مسار كاميرا", "طبقة صوت", "إضاءة المشهد"],
  construct: ["تجميع المكان", "بناء الكيانات", "ربط المخارج"],
  process: ["تنسيق البيانات", "تطبيع الطبقات", "ضغط الخرائط"],
  verify: ["فحص التناسق", "اختبار المسارات", "التقاط الأخطاء"],
  ship: ["توزيع الحزمة", "ختم الإصدار", "إطلاق العالم"],
};

export function createOrchestrator(seed = 2019099) {
  const bus = createErrorBus();
  const agents = createSwarm(seed);
  const byDept = Object.create(null);
  for (const d of DEPARTMENTS) byDept[d.key] = [];
  for (const a of agents) byDept[a.dept].push(a);

  const state = {
    seed,
    agents,
    byDept,
    stageIndex: -1,
    started: false,
    finished: false,
    progress: 0,
    world: null,
    qa: null,
    logs: [],
    stageWork: 0,
    stageNeed: 0,
    produced: 0,
  };

  function log(ar, en) {
    const row = { t: performance.now(), ar, en, stage: state.stageIndex };
    state.logs.push(row);
    if (state.logs.length > 80) state.logs.shift();
    bus.info(ar, en);
  }

  function begin() {
    state.started = true;
    state.stageIndex = 0;
    armStage();
    log("إيقاظ عشرة آلاف وكيل.", "Awakening ten thousand agents.");
  }

  function armStage() {
    const st = PIPELINE_STAGES[state.stageIndex];
    if (!st) {
      finish();
      return;
    }
    state.stageWork = 0;
    state.stageNeed = 0;
    const tasks = TASKS[st.key] || ["عمل"];
    for (const dk of st.depts) {
      const list = byDept[dk];
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        a.status = "queued";
        a.task = tasks[i % tasks.length];
        state.stageNeed++;
      }
    }
    log(`مرحلة: ${st.ar}`, `Stage: ${st.en}`);
  }

  function tick(budget = 240) {
    if (!state.started || state.finished) return state;
    const st = PIPELINE_STAGES[state.stageIndex];
    if (!st) return state;
    let n = 0;
    for (const dk of st.depts) {
      const list = byDept[dk];
      for (const a of list) {
        if (n >= budget) break;
        if (a.status === "done") continue;
        if (a.status === "queued") a.status = "working";
        a.ticks++;
        if (a.ticks >= 1 + (a.index % 3)) {
          if (a.quality < 0.74 && a.role === "apprentice" && a.ticks < 3) {
            a.status = "review";
            a.errors++;
          } else {
            a.status = "done";
            a.done++;
            state.stageWork++;
            state.produced++;
          }
        }
        n++;
      }
    }
    const doneRatio = state.stageNeed ? state.stageWork / state.stageNeed : 1;
    const stageFrac = (state.stageIndex + doneRatio) / PIPELINE_STAGES.length;
    state.progress = Math.min(0.999, stageFrac);

    if (state.stageWork >= state.stageNeed) {
      if (st.key === "world" || st.key === "construct") {
        state.world = bus.wrap(() => compileWorld(seed), "فشل تجميع العالم", "World compile failed");
      }
      if (st.key === "verify") {
        if (!state.world) state.world = compileWorld(seed);
state.qa = runLayerConsistency(state.world.maps, state.world.entities);
        log(
          `فحص الطبقات: نجح ${state.qa.pass} / فشل ${state.qa.fail}`,
          `Layer QA: ${state.qa.pass} passed / ${state.qa.fail} failed`
        );
      }
      state.stageIndex++;
      if (state.stageIndex >= PIPELINE_STAGES.length) finish();
      else armStage();
    }
    return state;
  }

  function finish() {
    if (!state.world) state.world = compileWorld(seed);
    if (!state.qa) state.qa = runLayerConsistency(state.world.maps, state.world.entities);
    for (const a of agents) {
      if (a.status !== "done") {
        a.status = "done";
        a.done++;
      }
    }
    state.finished = true;
    state.progress = 1;
    log("اكتمل التوزيع. العالم جاهز.", "Distribution complete. World ready.");
  }

  function fastForward() {
    if (!state.started) begin();
    let guard = 0;
    while (!state.finished && guard++ < 4000) tick(800);
    return state;
  }

  return {
    state,
    begin,
    tick,
    fastForward,
    bus,
    total: AGENTS_TOTAL,
  };
}
