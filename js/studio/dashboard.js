import { DEPARTMENTS, PIPELINE_STAGES } from "../agents/departments.js";

export function createStudio(canvas) {
  const ctx = canvas.getContext("2d");

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 400;
    const h = canvas.clientHeight || 400;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function draw(orch) {
    const { w, h } = resize();
    ctx.fillStyle = "#08070c";
    ctx.fillRect(0, 0, w, h);
    const agents = orch.state.agents;
    const cols = 100;
    const rows = 100;
    const pad = 8;
    const gw = w - pad * 2;
    const gh = h - pad * 2;
    const cw = gw / cols;
    const ch = gh / rows;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const x = pad + (i % cols) * cw;
      const y = pad + Math.floor(i / cols) * ch;
      const sat = a.status === "done" ? 55 : a.status === "working" ? 70 : 30;
      const lit = a.status === "working" ? 58 : a.status === "done" ? 38 : 18;
      ctx.fillStyle = `hsl(${a.hue} ${sat}% ${lit}%)`;
      ctx.fillRect(x, y, Math.max(1, cw - 0.3), Math.max(1, ch - 0.3));
    }
  }

  function deptRows(orch, lang) {
    const { byDept, agents } = orch.state;
    return DEPARTMENTS.map((d) => {
      const list = byDept[d.key];
      const done = list.reduce((n, a) => n + (a.status === "done" ? 1 : 0), 0);
      const work = list.reduce((n, a) => n + (a.status === "working" ? 1 : 0), 0);
      return {
        key: d.key,
        name: lang === "ar" ? d.ar : d.en,
        hue: d.hue,
        done,
        work,
        total: list.length,
        pct: done / list.length,
      };
    });
  }

  function stageLabel(orch, lang) {
    const i = orch.state.stageIndex;
    const st = PIPELINE_STAGES[Math.min(Math.max(i, 0), PIPELINE_STAGES.length - 1)];
    if (orch.state.finished) return lang === "ar" ? "مكتمل" : "Complete";
    if (!orch.state.started) return lang === "ar" ? "في الانتظار" : "Idle";
    return lang === "ar" ? st.ar : st.en;
  }

  return { draw, deptRows, stageLabel, DEPARTMENTS, PIPELINE_STAGES };
}
