import { createOrchestrator } from "./agents/orchestrator.js";
import { createAudio } from "./game/audio.js";
import { createInput } from "./game/input.js";
import { createRenderer } from "./game/renderer.js";
import { createGame } from "./game/engine.js";
import { createStudio } from "./studio/dashboard.js";
import {
  bindHud,
  renderHud,
  renderDialogue,
  renderCombat,
  renderMap,
  renderEnding,
} from "./ui/hud.js";
import { AGENTS_TOTAL } from "./agents/departments.js";
import { emptyFlags } from "./content/flags.js";

const langState = { lang: "ar" };
const screen = { id: "boot" }; // boot | title | game
let showStudio = false;

const canvas = document.getElementById("game");
const swarmCanvas = document.getElementById("swarm");
const ui = bindHud(document);
const audio = createAudio();
const input = createInput();
const renderer = createRenderer(canvas);
const studio = createStudio(swarmCanvas);
const orch = createOrchestrator(2019099);

input.bind(window);
orch.begin();

let game = null;
let last = performance.now();
let bootLogCursor = 0;

function setLang(lang) {
  langState.lang = lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.getElementById("lang-btn").textContent = lang === "ar" ? "EN" : "ع";
}

document.getElementById("lang-btn").addEventListener("click", () => {
  setLang(langState.lang === "ar" ? "en" : "ar");
  audio.ui();
});

document.getElementById("skip-boot").addEventListener("click", () => {
  orch.fastForward();
});

document.getElementById("btn-play").addEventListener("click", startGame);
document.getElementById("btn-studio").addEventListener("click", () => {
  showStudio = true;
  ui.studio.classList.remove("hidden");
  audio.unlock();
  audio.ui();
});
document.getElementById("studio-close").addEventListener("click", () => {
  showStudio = false;
  if (screen.id !== "boot") ui.studio.classList.add("hidden");
});
document.getElementById("btn-again").addEventListener("click", () => {
  if (game) {
    game.state.flags = emptyFlags();
    game.state.ending = null;
    game.state.combat = null;
    game.loadPlace("harbor");
    game.startScene("intro");
  }
  ui.ending.classList.add("hidden");
});

function startGame() {
  audio.unlock();
  if (!orch.state.finished) orch.fastForward();
  if (!orch.state.world) orch.fastForward();
  game = createGame(orch.state.world, audio);
  screen.id = "game";
  ui.title.classList.add("hidden");
  ui.boot.classList.add("hidden");
  ui.hud.classList.remove("hidden");
  showStudio = false;
  ui.studio.classList.add("hidden");
  game.startScene("intro");
  canvas.focus();
  audio.ui();
}

function renderBoot() {
  const p = orch.state.progress;
  ui.bootBar.style.transform = `scaleX(${p})`;
  ui.bootPct.textContent = `${Math.floor(p * 100)}% · ${AGENTS_TOTAL.toLocaleString()} agents`;
  const logs = orch.state.logs;
  if (logs.length !== bootLogCursor) {
    bootLogCursor = logs.length;
    ui.bootLog.innerHTML = logs
      .slice(-8)
      .map((l) => `<div>${langState.lang === "ar" ? l.ar : l.en}</div>`)
      .join("");
  }
  if (orch.state.finished && screen.id === "boot") {
    screen.id = "title";
    ui.boot.classList.add("fadeout");
    setTimeout(() => {
      ui.boot.classList.add("hidden");
      ui.title.classList.remove("hidden");
    }, 700);
  }
}

function renderStudio() {
  studio.draw(orch);
  const lang = langState.lang;
  const st = orch.state;
  const qa = st.qa;
  ui.studioMeta.textContent =
    lang === "ar"
      ? `المرحلة: ${studio.stageLabel(orch, lang)} — ${Math.floor(st.progress * 100)}٪ — وكلاء ${st.agents.length}`
      : `Stage: ${studio.stageLabel(orch, lang)} — ${Math.floor(st.progress * 100)}% — ${st.agents.length} agents`;
  const rows = studio.deptRows(orch, lang);
  ui.studioDepts.innerHTML = rows
    .map(
      (d) => `<div class="dept">
        <span class="swatch" style="background:hsl(${d.hue} 60% 45%)"></span>
        <span class="dn">${d.name}</span>
        <span class="dp">${Math.floor(d.pct * 100)}%</span>
        <div class="bar"><i style="width:${d.pct * 100}%;background:hsl(${d.hue} 60% 45%)"></i></div>
      </div>`
    )
    .join("");
  ui.studioLog.innerHTML = st.logs
    .slice(-10)
    .map((l) => `<div>${lang === "ar" ? l.ar : l.en}</div>`)
    .join("");
  if (qa) {
    ui.qaBox.innerHTML =
      `<strong>${lang === "ar" ? "تناسق الطبقات" : "Layer consistency"}</strong>
       <p>${qa.pass} ✓ · ${qa.fail} ✗</p>
       <ul>${qa.findings
         .filter((f) => !f.pass)
         .slice(0, 12)
         .map((f) => `<li>${lang === "ar" ? f.ar : f.en}</li>`)
         .join("")}</ul>`;
  }
}

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!orch.state.finished) orch.tick(screen.id === "boot" ? 420 : 180);
  if (screen.id === "boot" || !orch.state.finished) renderBoot();
  if (showStudio || screen.id === "boot") renderStudio();

  if (input.pressed("lang")) setLang(langState.lang === "ar" ? "en" : "ar");
  if (input.pressed("studio")) {
    showStudio = !showStudio;
    ui.studio.classList.toggle("hidden", !showStudio);
    audio.ui();
  }

  if (game && screen.id === "game") {
    if (input.pressed("menu") && game.state.mode === "play") {
      game.state.mode = "paused";
    } else if (input.pressed("menu") && game.state.mode === "paused") {
      game.state.mode = "play";
    }
    game.update(dt, input);
    renderer.frame(game.state, dt);
    const lang = langState.lang;
    renderHud(ui, game, lang);
    renderDialogue(ui, game, lang);
    renderCombat(ui, game, lang);
    renderMap(ui, game, lang);
    renderEnding(ui, game, lang);
  } else {
    renderer.resize();
    const ctx = canvas.getContext("2d");
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = "#07060a";
    ctx.fillRect(0, 0, w, h);
  }
  requestAnimationFrame(loop);
}

setLang("ar");
requestAnimationFrame(loop);

window.__TBW = { orch, audio, startGame };
