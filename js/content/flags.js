export const FLAG_DEFS = {
  metRuna: { ar: "لقاء رونا", en: "Met Runa" },
  heardRumor: { ar: "شائعة الوصية", en: "Heard the rumor" },
  innKey: { ar: "مفتاح السقيفة", en: "Loft key" },
  fragmentHarbor: { ar: "شظية الميناء", en: "Harbor fragment" },
  fragmentMoors: { ar: "شظية المستنقع", en: "Moors fragment" },
  fragmentCourt: { ar: "شظية البلاط", en: "Court fragment" },
  fragmentVault: { ar: "شظية القبو", en: "Vault fragment" },
  moorsOpen: { ar: "فتح المستنقع", en: "Moors unlocked" },
  courtPass: { ar: "تصريح البلاط", en: "Court pass" },
  spokeSerath: { ar: "حديث سيراث", en: "Spoke to Serath" },
  spokePharos: { ar: "حديث فاروس", en: "Spoke to Pharos" },
  archiveOpen: { ar: "فتح الأرشيف", en: "Archives open" },
  vaultOpen: { ar: "فتح القبو", en: "Vault open" },
  trueWill: { ar: "الوصية الأصلية", en: "True will found" },
  forgedWill: { ar: "الوصية المزورة", en: "Forged will found" },
  mercyPharos: { ar: "رحمة فاروس", en: "Spared Pharos" },
  trustWill: { ar: "الثقة بالوصية", en: "Trusted the Will" },
  burnAll: { ar: "حرق الوصايا", en: "Burned the wills" },
  combatHarbor: { ar: "صدام الميناء", en: "Harbor clash" },
  combatVault: { ar: "صدام القبو", en: "Vault clash" },
};

export function emptyFlags() {
  const f = Object.create(null);
  for (const k of Object.keys(FLAG_DEFS)) f[k] = false;
  return f;
}

export function fragmentCount(flags) {
  return ["fragmentHarbor", "fragmentMoors", "fragmentCourt", "fragmentVault"]
    .reduce((n, k) => n + (flags[k] ? 1 : 0), 0);
}
