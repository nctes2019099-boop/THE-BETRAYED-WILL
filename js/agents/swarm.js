import {
  AGENTS_TOTAL,
  AGENTS_PER_DEPT,
  DEPARTMENTS,
  ROLES,
} from "./departments.js";

const GIVEN_AR = [
  "نوح", "ليان", "سدرة", "مازن", "هديل", "رامي", "أسيل", "كرم",
  "تالا", "باسل", "ميساء", "أدهم", "لينا", "فارس", "جود", "سيف",
  "رغد", "يزن", "نور", "عُلا", "زياد", "سلمى", "هشام", "دانا",
];
const GIVEN_EN = [
  "Noor", "Kael", "Sera", "Orin", "Vale", "Rook", "Iris", "Thane",
  "Mira", "Alden", "Nyx", "Bram", "Lira", "Quill", "Ash", "Wren",
];
const HOUSE = [
  "الرماد", "الختم", "الضباب", "الوصية", "ال raven", "الحبر", "السيف", "القبو",
];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSwarm(seed = 2019099) {
  const rand = mulberry32(seed);
  const agents = new Array(AGENTS_TOTAL);
  let n = 0;
  for (let d = 0; d < DEPARTMENTS.length; d++) {
    const dept = DEPARTMENTS[d];
    for (let i = 0; i < AGENTS_PER_DEPT; i++) {
      const idNum = n + 1;
      const role = ROLES[i % ROLES.length];
      const ar = GIVEN_AR[idNum % GIVEN_AR.length];
      const en = GIVEN_EN[idNum % GIVEN_EN.length];
      agents[n] = {
        id: `A-${String(idNum).padStart(5, "0")}`,
        index: n,
        dept: dept.key,
        deptIndex: d,
        role: role.key,
        nameAr: `${ar} · ${dept.ar}`,
        nameEn: `${en}-${dept.key}-${role.key}`,
        house: HOUSE[idNum % HOUSE.length],
        status: "idle",
        task: "",
        quality: 0.72 + rand() * 0.28,
        ticks: 0,
        errors: 0,
        done: 0,
        hue: dept.hue,
      };
      n++;
    }
  }
  if (n !== AGENTS_TOTAL) throw new Error(`Swarm size ${n} != ${AGENTS_TOTAL}`);
  return agents;
}

export function swarmStats(agents) {
  const byStatus = Object.create(null);
  const byDept = Object.create(null);
  let errors = 0;
  let done = 0;
  for (const a of agents) {
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    byDept[a.dept] = (byDept[a.dept] || 0) + 1;
    errors += a.errors;
    done += a.done;
  }
  return { total: agents.length, byStatus, byDept, errors, done };
}
