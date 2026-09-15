/** Placed actors, exits, inspectables. Coordinates are tile centers. */
export const ENTITIES = [
  // Harbor
  { id: "ex-harbor-inn", type: "exit", place: "harbor", x: 33, y: 14, to: "inn", tx: 14, ty: 16, need: null, label: { ar: "الفانوس الأخير", en: "The Last Lantern" } },
  { id: "ex-harbor-moors", type: "exit", place: "harbor", x: 40, y: 20, to: "moors", tx: 8, ty: 30, need: "moorsOpen", label: { ar: "طريق المستنقعات", en: "Moors road" } },
  { id: "npc-runa", type: "npc", place: "harbor", x: 16, y: 19, who: "runa", wander: 1.5 },
  { id: "look-docks", type: "inspect", place: "harbor", x: 20, y: 25, scene: "docksLook" },
  { id: "item-frag-h", type: "item", place: "harbor", x: 12, y: 12, flag: "fragmentHarbor", item: "fragment", scene: "fragHarbor" },
  { id: "fight-h", type: "combat", place: "harbor", x: 38, y: 18, scene: "harborClash", flag: "combatHarbor", need: "heardRumor" },

  // Inn
  { id: "ex-inn-harbor", type: "exit", place: "inn", x: 14, y: 18, to: "harbor", tx: 33, ty: 15, need: null, label: { ar: "إلى الميناء", en: "To the harbor" } },
  { id: "npc-maia", type: "npc", place: "inn", x: 13, y: 8, who: "maia", wander: 0.6 },
  { id: "look-hearth", type: "inspect", place: "inn", x: 14, y: 7, scene: "hearthLook" },
  { id: "item-loft", type: "item", place: "inn", x: 22, y: 5, flag: "innKey", item: "letter", scene: "loftLetter" },

  // Moors
  { id: "ex-moors-harbor", type: "exit", place: "moors", x: 8, y: 31, to: "harbor", tx: 39, ty: 20, need: null, label: { ar: "إلى الميناء", en: "To the harbor" } },
  { id: "ex-moors-watch", type: "exit", place: "moors", x: 28, y: 15, to: "watch", tx: 12, ty: 18, need: null, label: { ar: "المرقب", en: "The Watch" } },
  { id: "ex-moors-court", type: "exit", place: "moors", x: 48, y: 10, to: "court", tx: 22, ty: 26, need: "courtPass", label: { ar: "بوابة البلاط", en: "Court gate" } },
  { id: "npc-aldric-moors", type: "npc", place: "moors", x: 27, y: 13, who: "aldric", wander: 0 },
  { id: "look-stones", type: "inspect", place: "moors", x: 26, y: 12, scene: "standingStones" },
  { id: "item-frag-m", type: "item", place: "moors", x: 16, y: 20, flag: "fragmentMoors", item: "fragment", scene: "fragMoors" },

  // Watch
  { id: "ex-watch-moors", type: "exit", place: "watch", x: 12, y: 20, to: "moors", tx: 28, ty: 16, need: null, label: { ar: "إلى المستنقع", en: "To the moors" } },
  { id: "npc-orlen-watch", type: "npc", place: "watch", x: 12, y: 8, who: "orlen", wander: 0.4 },
  { id: "look-map", type: "inspect", place: "watch", x: 10, y: 6, scene: "watchMap" },

  // Court
  { id: "ex-court-moors", type: "exit", place: "court", x: 22, y: 28, to: "moors", tx: 47, ty: 10, need: null, label: { ar: "إلى المستنقع", en: "To the moors" } },
  { id: "ex-court-arch", type: "exit", place: "court", x: 35, y: 13, to: "archives", tx: 16, ty: 20, need: "archiveOpen", label: { ar: "الأرشيف", en: "Archives" } },
  { id: "npc-serath", type: "npc", place: "court", x: 22, y: 8, who: "serath", wander: 0 },
  { id: "npc-pharos", type: "npc", place: "court", x: 26, y: 12, who: "pharos", wander: 0.3 },
  { id: "look-throne", type: "inspect", place: "court", x: 22, y: 5, scene: "falseThrone" },
  { id: "item-frag-c", type: "item", place: "court", x: 10, y: 16, flag: "fragmentCourt", item: "fragment", scene: "fragCourt" },

  // Archives
  { id: "ex-arch-court", type: "exit", place: "archives", x: 16, y: 22, to: "court", tx: 34, ty: 13, need: null, label: { ar: "إلى البلاط", en: "To the court" } },
  { id: "ex-arch-vault", type: "exit", place: "archives", x: 16, y: 4, to: "vault", tx: 6, ty: 24, need: "vaultOpen", label: { ar: "قبو الوصايا", en: "Vault of Wills" } },
  { id: "npc-orlen-arch", type: "npc", place: "archives", x: 8, y: 10, who: "orlen", wander: 0.8 },
  { id: "look-forged", type: "inspect", place: "archives", x: 24, y: 10, scene: "forgedCopy" },

  // Vault
  { id: "ex-vault-arch", type: "exit", place: "vault", x: 6, y: 25, to: "archives", tx: 16, ty: 5, need: null, label: { ar: "إلى الأرشيف", en: "To the archives" } },
  { id: "ex-vault-throne", type: "exit", place: "vault", x: 21, y: 10, to: "throne", tx: 18, ty: 22, need: "trueWill", label: { ar: "العرش الأجوف", en: "Hollow Throne" } },
  { id: "npc-will", type: "npc", place: "vault", x: 21, y: 12, who: "theWill", wander: 0.2 },
  { id: "fight-v", type: "combat", place: "vault", x: 18, y: 16, scene: "vaultClash", flag: "combatVault", need: null },
  { id: "item-frag-v", type: "item", place: "vault", x: 32, y: 16, flag: "fragmentVault", item: "fragment", scene: "fragVault" },
  { id: "look-true", type: "inspect", place: "vault", x: 21, y: 11, scene: "trueWillLook" },

  // Throne
  { id: "ex-throne-vault", type: "exit", place: "throne", x: 18, y: 24, to: "vault", tx: 21, ty: 11, need: null, label: { ar: "إلى القبو", en: "To the vault" } },
  { id: "npc-pharos-end", type: "npc", place: "throne", x: 16, y: 10, who: "pharos", wander: 0 },
  { id: "npc-will-end", type: "npc", place: "throne", x: 20, y: 8, who: "theWill", wander: 0 },
  { id: "npc-serath-end", type: "npc", place: "throne", x: 20, y: 12, who: "serath", wander: 0 },
  { id: "look-end", type: "inspect", place: "throne", x: 18, y: 7, scene: "endingChoice" },
];
