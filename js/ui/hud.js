import { CAST } from "../content/cast.js";

export function t(lang, obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  return obj[lang] || obj.en || obj.ar || "";
}

export function bindHud(root) {
  return {
    boot: root.querySelector("#boot"),
    title: root.querySelector("#title-screen"),
    hud: root.querySelector("#hud"),
    dialogue: root.querySelector("#dialogue"),
    combat: root.querySelector("#combat"),
    map: root.querySelector("#map-overlay"),
    ending: root.querySelector("#ending"),
    studio: root.querySelector("#studio"),
    prompt: root.querySelector("#prompt"),
    place: root.querySelector("#place-name"),
    frags: root.querySelector("#frags"),
    portrait: root.querySelector("#portrait"),
    speaker: root.querySelector("#speaker"),
    line: root.querySelector("#line"),
    choices: root.querySelector("#choices"),
    bootBar: root.querySelector("#boot-bar"),
    bootLog: root.querySelector("#boot-log"),
    bootPct: root.querySelector("#boot-pct"),
    studioMeta: root.querySelector("#studio-meta"),
    studioDepts: root.querySelector("#studio-depts"),
    studioLog: root.querySelector("#studio-log"),
    qaBox: root.querySelector("#qa-box"),
    combatFill: root.querySelector("#combat-window"),
    combatHp: root.querySelector("#combat-hp"),
    mapInner: root.querySelector("#map-inner"),
    endTitle: root.querySelector("#end-title"),
    endBody: root.querySelector("#end-body"),
    hoverName: root.querySelector("#hover-name"),
  };
}

export function renderDialogue(ui, game, lang) {
  const st = game.state;
  if (st.mode !== "dialogue" || !st.scene) {
    ui.dialogue.classList.add("hidden");
    return;
  }
  ui.dialogue.classList.remove("hidden");
  const beat = st.scene.beats[st.beat];
  if (!beat) return;
  const who = beat.who ? CAST[beat.who] : null;
  ui.speaker.textContent = who ? `${t(lang, who.name)} — ${t(lang, who.title)}` : (lang === "ar" ? "السرد" : "Narration");
  ui.line.textContent = t(lang, beat);
  if (who?.portrait) {
    ui.portrait.style.backgroundImage = `url("${who.portrait}")`;
    ui.portrait.style.backgroundSize = who.portrait.startsWith("data:") ? "contain" : "cover";
    ui.portrait.classList.remove("empty");
  } else {
    ui.portrait.style.backgroundImage = "none";
    ui.portrait.classList.add("empty");
    ui.portrait.style.background = who?.color || "#222";
  }
  const key = `${st.sceneId}-${st.beat}-${st.choice}-${lang}-${beat.choices ? beat.choices.length : 0}`;
  if (ui.choices.dataset.key === key) return;
  ui.choices.dataset.key = key;
  ui.choices.innerHTML = "";
  if (beat.choices) {
    beat.choices.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "choice" + (i === st.choice ? " on" : "");
      b.textContent = `${i + 1}. ${t(lang, c)}`;
      b.addEventListener("click", () => game.choose(i));
      ui.choices.appendChild(b);
    });
  } else {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = lang === "ar" ? "E / مسافة — متابعة" : "E / Space — continue";
    ui.choices.appendChild(hint);
  }
}

export function renderHud(ui, game, lang) {
  const st = game.state;
  ui.place.textContent = t(lang, st.place.name);
  ui.frags.textContent = `${game.fragments()} / 4`;
  if (st.hover && st.mode === "play") {
    const label = hoverLabel(st.hover, lang);
    ui.hoverName.textContent = label;
    ui.hoverName.classList.remove("hidden");
  } else ui.hoverName.classList.add("hidden");

  if (st.prompt) {
    ui.prompt.textContent = t(lang, st.prompt);
    ui.prompt.classList.remove("hidden");
  } else ui.prompt.classList.add("hidden");
}

function hoverLabel(e, lang) {
  if (e.type === "exit") return (lang === "ar" ? "دخول: " : "Enter: ") + t(lang, e.label);
  if (e.type === "npc") return (lang === "ar" ? "حديث: " : "Talk: ") + t(lang, CAST[e.who].name);
  if (e.type === "inspect") return lang === "ar" ? "فحص" : "Inspect";
  if (e.type === "item") return lang === "ar" ? "التقاط" : "Take";
  if (e.type === "combat") return lang === "ar" ? "صدام" : "Clash";
  return "";
}

export function renderCombat(ui, game, lang) {
  const c = game.state.combat;
  if (game.state.mode !== "combat" || !c) {
    ui.combat.classList.add("hidden");
    return;
  }
  ui.combat.classList.remove("hidden");
  ui.combatHp.textContent = lang === "ar" ? `نبضك ${c.hp} — الختم ${c.foe}` : `Your pulse ${c.hp} — Seal ${c.foe}`;
  const p = Math.max(0, Math.min(1, c.window / 0.7));
  ui.combatFill.style.transform = `scaleX(${p})`;
  ui.combatFill.classList.toggle("hot", p > 0.15);
}

export function renderMap(ui, game, lang) {
  if (game.state.mode !== "map") {
    ui.map.classList.add("hidden");
    return;
  }
  ui.map.classList.remove("hidden");
  const st = game.state;
  const m = st.map;
  const scale = 8;
  const canvas = ui.mapInner;
  canvas.width = m.w * scale;
  canvas.height = m.h * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0a090e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const solid = m.collision[y * m.w + x];
      ctx.fillStyle = solid ? "#1a1820" : "#3a342c";
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  ctx.fillStyle = "#e8c060";
  ctx.fillRect(st.player.x * scale - 2, st.player.y * scale - 2, 4, 4);
  ui.map.querySelector("h2").textContent = t(lang, st.place.name);
}

export function renderEnding(ui, game, lang) {
  if (game.state.mode !== "ending") {
    ui.ending.classList.add("hidden");
    return;
  }
  ui.ending.classList.remove("hidden");
  ui.endTitle.textContent = t(lang, game.state.ending.title);
  ui.endBody.textContent = t(lang, game.state.ending);
}
