/** 25 ministries × 400 agents = 10,000. */
export const AGENTS_TOTAL = 10000;
export const AGENTS_PER_DEPT = 400;

export const ROLES = [
  { key: "lead", ar: "قائد", en: "Lead" },
  { key: "senior", ar: "كبير", en: "Senior" },
  { key: "specialist", ar: "أخصائي", en: "Specialist" },
  { key: "analyst", ar: "محلل", en: "Analyst" },
  { key: "builder", ar: "بنّاء", en: "Builder" },
  { key: "reviewer", ar: "مراجع", en: "Reviewer" },
  { key: "integrator", ar: "مدمج", en: "Integrator" },
  { key: "apprentice", ar: "متدرّب", en: "Apprentice" },
];

export const DEPARTMENTS = [
  { key: "build", ar: "البناء", en: "Building", hue: 38, pipeline: "construct" },
  { key: "dev", ar: "التطوير", en: "Development", hue: 200, pipeline: "construct" },
  { key: "process", ar: "المعالجة", en: "Processing", hue: 175, pipeline: "process" },
  { key: "inspect", ar: "الفحص", en: "Inspection", hue: 48, pipeline: "verify" },
  { key: "prepare", ar: "التهيئة", en: "Preparation", hue: 28, pipeline: "prepare" },
  { key: "format", ar: "التنسيق", en: "Coordination", hue: 265, pipeline: "process" },
  { key: "distribute", ar: "التوزيع", en: "Distribution", hue: 145, pipeline: "ship" },
  { key: "test", ar: "الاختبار", en: "Testing", hue: 12, pipeline: "verify" },
  { key: "copy", ar: "كتابة النصوص", en: "Copywriting", hue: 330, pipeline: "narrative" },
  { key: "story", ar: "القصص", en: "Stories", hue: 350, pipeline: "narrative" },
  { key: "plot", ar: "الحبكة", en: "Plot", hue: 0, pipeline: "narrative" },
  { key: "characters", ar: "الشخصيات", en: "Characters", hue: 22, pipeline: "cast" },
  { key: "scenarios", ar: "السيناريوهات", en: "Scenarios", hue: 310, pipeline: "narrative" },
  { key: "sound", ar: "الصوت", en: "Sound", hue: 255, pipeline: "present" },
  { key: "camera", ar: "الكاميرا", en: "Camera", hue: 190, pipeline: "present" },
  { key: "terrain", ar: "التضاريس", en: "Terrain", hue: 95, pipeline: "world" },
  { key: "map", ar: "الخريطة", en: "Map", hue: 85, pipeline: "world" },
  { key: "places", ar: "الأماكن", en: "Places", hue: 70, pipeline: "world" },
  { key: "errors", ar: "معالجة الأخطاء", en: "Error Handling", hue: 8, pipeline: "verify" },
  { key: "layers", ar: "تناسق الطبقات", en: "Layer Consistency", hue: 55, pipeline: "verify" },
  { key: "light", ar: "الإضاءة", en: "Lighting", hue: 45, pipeline: "present" },
  { key: "combat", ar: "القتال", en: "Combat", hue: 5, pipeline: "systems" },
  { key: "ui", ar: "الواجهات", en: "Interfaces", hue: 215, pipeline: "present" },
  { key: "lore", ar: "الموروث", en: "Lore", hue: 32, pipeline: "narrative" },
  { key: "cinema", ar: "الإخراج", en: "Cinematics", hue: 280, pipeline: "present" },
];

if (DEPARTMENTS.length * AGENTS_PER_DEPT !== AGENTS_TOTAL) {
  throw new Error("Department roster must equal 10,000 agents");
}

export const PIPELINE_STAGES = [
  { key: "prepare", ar: "تهيئة", en: "Prepare", depts: ["prepare"] },
  { key: "narrative", ar: "السرد", en: "Narrative", depts: ["copy", "story", "plot", "scenarios", "lore"] },
  { key: "cast", ar: "الشخصيات", en: "Cast", depts: ["characters"] },
  { key: "world", ar: "العالم", en: "World", depts: ["terrain", "map", "places"] },
  { key: "systems", ar: "الأنظمة", en: "Systems", depts: ["combat", "dev"] },
  { key: "present", ar: "الإخراج", en: "Presentation", depts: ["sound", "camera", "light", "ui", "cinema"] },
  { key: "construct", ar: "البناء", en: "Construct", depts: ["build"] },
  { key: "process", ar: "المعالجة", en: "Process", depts: ["process", "format"] },
  { key: "verify", ar: "التحقق", en: "Verify", depts: ["inspect", "test", "errors", "layers"] },
  { key: "ship", ar: "التوزيع", en: "Ship", depts: ["distribute"] },
];

export function deptByKey(key) {
  return DEPARTMENTS.find((d) => d.key === key);
}
