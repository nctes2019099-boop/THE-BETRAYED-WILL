// THE BETRAYED WILL — world data
// PURE MODULE. Regions, landmarks, layouts and the Babylonian material palette.
// §26 HISTORICAL GATE: mud brick, baked brick, plaster, wood, reed, courtyards,
// gates, flat roofs, storage, alleys. No European medieval silhouettes, no
// pointed-arch church vocabulary, no modern props. The banned list itself lives
// in ./vocabulary.js — it is not repeated here, because repeating it would trip
// the very gate that enforces it. Every entry is checked by Reviewer E.
//
// The allow/reject lists themselves live in ./vocabulary.js, which is also what
// lint.sh scans against, so the gate cannot drift between the linter and the
// runtime validator.

import { ARCHITECTURE_ALLOWED, ARCHITECTURE_REJECTED } from './vocabulary.js';

/**
 * Canonical material palette. Colours are drawn from alluvial Mesopotamian
 * building materials: sun-dried mud brick (pale warm brown), kiln-fired baked
 * brick (deeper red-brown, used for drains, gates and temple faces), gypsum
 * plaster (near-white render), bitumen (black waterproofing), palm and poplar
 * timber, and woven reed.
 */
export const MATERIALS = Object.freeze({
  mudBrick:     { id: 'mudBrick',     en: 'mud brick',     ar: 'لبن',        color: 0xb09a76, roughness: 0.94, metalness: 0.0 },
  mudBrickDark: { id: 'mudBrickDark', en: 'mud brick',     ar: 'لبن',        color: 0x96815f, roughness: 0.96, metalness: 0.0 },
  bakedBrick:   { id: 'bakedBrick',   en: 'baked brick',   ar: 'آجر مفخور',  color: 0x8e5b41, roughness: 0.78, metalness: 0.0 },
  bakedBrickGl: { id: 'bakedBrickGl', en: 'glazed brick',  ar: 'آجر مزجج',   color: 0x2f5f74, roughness: 0.34, metalness: 0.05 },
  plaster:      { id: 'plaster',      en: 'gypsum plaster',ar: 'جص',         color: 0xd8cbb2, roughness: 0.88, metalness: 0.0 },
  bitumen:      { id: 'bitumen',      en: 'bitumen',       ar: 'قير',        color: 0x241f1c, roughness: 0.55, metalness: 0.02 },
  palmWood:     { id: 'palmWood',     en: 'palm timber',   ar: 'خشب النخيل', color: 0x7a5c39, roughness: 0.86, metalness: 0.0 },
  poplarWood:   { id: 'poplarWood',   en: 'poplar timber', ar: 'خشب الحور',  color: 0x8d6b45, roughness: 0.82, metalness: 0.0 },
  reed:         { id: 'reed',         en: 'woven reed',    ar: 'قصب',        color: 0xa89259, roughness: 0.97, metalness: 0.0 },
  limestone:    { id: 'limestone',    en: 'limestone',     ar: 'حجر جيري',   color: 0xc3b89c, roughness: 0.8,  metalness: 0.0 },
  basalt:       { id: 'basalt',       en: 'basalt',        ar: 'بازلت',      color: 0x4a4741, roughness: 0.72, metalness: 0.0 },
  bronze:       { id: 'bronze',       en: 'bronze',        ar: 'برونز',      color: 0x9c7a3c, roughness: 0.38, metalness: 0.86 },
  copper:       { id: 'copper',       en: 'copper',        ar: 'نحاس',       color: 0xa8673f, roughness: 0.42, metalness: 0.82 },
  iron:         { id: 'iron',         en: 'iron',          ar: 'حديد',       color: 0x5b5751, roughness: 0.56, metalness: 0.74 },
  clay:         { id: 'clay',         en: 'fired clay',    ar: 'طين مفخور',  color: 0xa8703f, roughness: 0.83, metalness: 0.0 },
  terracotta:   { id: 'terracotta',   en: 'terracotta',    ar: 'خزف',        color: 0xb0603c, roughness: 0.79, metalness: 0.0 },
  linen:        { id: 'linen',        en: 'linen',         ar: 'كتان',       color: 0xd9cdb4, roughness: 0.95, metalness: 0.0 },
  wool:         { id: 'wool',         en: 'wool',          ar: 'صوف',        color: 0xbfae90, roughness: 0.99, metalness: 0.0 },
  leather:      { id: 'leather',      en: 'leather',       ar: 'جلد',        color: 0x6b4a30, roughness: 0.76, metalness: 0.0 },
  sand:         { id: 'sand',         en: 'sand',          ar: 'رمل',        color: 0xcbb287, roughness: 0.98, metalness: 0.0 },
  silt:         { id: 'silt',         en: 'river silt',    ar: 'طمي',        color: 0x8a7554, roughness: 0.95, metalness: 0.0 },
  water:        { id: 'water',        en: 'canal water',   ar: 'ماء',        color: 0x4a6b62, roughness: 0.12, metalness: 0.1 },
  lapis:        { id: 'lapis',        en: 'lapis lazuli',  ar: 'لازورد',     color: 0x27408b, roughness: 0.3,  metalness: 0.05 },
  gold:         { id: 'gold',         en: 'gold',          ar: 'ذهب',        color: 0xc9a227, roughness: 0.28, metalness: 0.94 },
  ash:          { id: 'ash',          en: 'ash',           ar: 'رماد',       color: 0x6e665c, roughness: 0.99, metalness: 0.0 },
  blood:        { id: 'blood',        en: 'blood',         ar: 'دم',         color: 0x5a1414, roughness: 0.5,  metalness: 0.0 },
});

/** Architectural vocabulary — what may and may not be built. */
export const ARCHITECTURE = Object.freeze({
  allowed: ARCHITECTURE_ALLOWED,
  rejected: ARCHITECTURE_REJECTED,
});

/* ------------------------------------------------------------------ regions */

/**
 * Region graph. `connects` defines traversable links; the playthrough test
 * walks this graph to prove every chapter space is reachable (§36 World gate).
 * `indoor` regions use the interior camera profile and reduced light.
 */
export const REGIONS = Object.freeze([
  {
    id: 'palace-court', en: 'Palace Courtyard', ar: 'فناء القصر',
    chapter: 'prologue', indoor: false, bounds: { x: [-46, 46], z: [-46, 46] },
    ground: 'limestone', connects: ['palace-hall', 'servant-passage'],
    timeOfDay: 'dusk', landmarkCount: 12,
  },
  {
    id: 'palace-hall', en: 'Hall of Orin', ar: 'قاعة أورين',
    chapter: 'ch1', indoor: true, bounds: { x: [-16, 16], z: [-22, 22] },
    ground: 'bakedBrick', connects: ['palace-court', 'brothers-wing', 'feast-hall'],
    timeOfDay: 'night', landmarkCount: 11,
  },
  {
    id: 'feast-hall', en: 'Feast Hall', ar: 'قاعة الوليمة',
    chapter: 'ch2', indoor: true, bounds: { x: [-13, 13], z: [-18, 18] },
    ground: 'plaster', connects: ['palace-hall'],
    timeOfDay: 'night', landmarkCount: 7,
  },
  {
    id: 'brothers-wing', en: "Brothers' Wing", ar: 'جناح الإخوة',
    chapter: 'ch3', indoor: true, bounds: { x: [-20, 20], z: [-14, 14] },
    ground: 'plaster', connects: ['palace-hall', 'kitchen', 'storage'],
    timeOfDay: 'morning', landmarkCount: 8,
  },
  {
    id: 'kitchen', en: 'Kitchen', ar: 'المطبخ',
    chapter: 'ch3', indoor: true, bounds: { x: [-9, 9], z: [-11, 11] },
    ground: 'bakedBrick', connects: ['brothers-wing', 'storage'],
    timeOfDay: 'morning', landmarkCount: 5,
  },
  {
    id: 'storage', en: 'Store Rooms', ar: 'المخازن',
    chapter: 'ch3', indoor: true, bounds: { x: [-11, 11], z: [-13, 13] },
    ground: 'mudBrick', connects: ['brothers-wing', 'kitchen', 'cellar-stair'],
    timeOfDay: 'morning', landmarkCount: 6,
  },
  {
    id: 'cellar-stair', en: 'Cellar Stair', ar: 'درج القبو',
    chapter: 'ch3', indoor: true, bounds: { x: [-4, 4], z: [-9, 9] },
    ground: 'bakedBrick', connects: ['storage', 'cellar'], vertical: true,
    timeOfDay: 'morning', landmarkCount: 3,
    // The floor itself is the staircase: vertical traversal lives in the height
    // field rather than in floating step boxes that disagree with the ground
    // beneath them. A smooth ramp was rejected — a cellar stair in a mud-brick
    // palace is stepped, and a 12 degree slope reads as a ramp, not a stair.
    //   flight  z +3.5 -> -4.5  (8.0 m run)
    //   18 steps x 0.172 m rise x 0.444 m going  = 3.1 m total drop
    // A 0.172 m rise over a 0.444 m going is ~21 degrees, within the 0.40 m
    // per-cell limit the nav grid follows at 0.25 m interior resolution.
    // Landings: z +3.5..+9 at palace level, z -9..-4.5 at cellar level (-3.1 m).
    descent: { fromZ: 3.5, toZ: -4.5, depth: 3.1, steps: 18 },
  },
  {
    id: 'cellar', en: 'The Cellar', ar: 'القبو',
    chapter: 'ch4', indoor: true, bounds: { x: [-14, 14], z: [-16, 16] },
    ground: 'silt', connects: ['cellar-stair', 'tunnel'],
    timeOfDay: 'night', landmarkCount: 7,
    // The cellar floor sits below palace level, matching the stair descent.
    elevation: -3.1,
  },
  {
    id: 'servant-passage', en: 'Servant Passage', ar: 'ممر الخدم',
    chapter: 'ch5', indoor: true, bounds: { x: [-3.5, 3.5], z: [-30, 30] },
    ground: 'mudBrick', connects: ['palace-court', 'tunnel'],
    timeOfDay: 'night', landmarkCount: 4,
  },
  {
    id: 'tunnel', en: 'Drain Tunnel', ar: 'نفق التصريف',
    chapter: 'ch5', indoor: true, bounds: { x: [-4, 4], z: [-52, 52] },
    ground: 'bitumen', connects: ['cellar', 'servant-passage', 'palace-exterior'],
    timeOfDay: 'night', landmarkCount: 5,
  },
  {
    id: 'palace-exterior', en: 'Palace Exterior', ar: 'خارج القصر',
    chapter: 'ch5', indoor: false, bounds: { x: [-34, 34], z: [-30, 44] },
    ground: 'sand', connects: ['tunnel', 'gate-road', 'poor-quarter'],
    timeOfDay: 'night', landmarkCount: 8,
  },
  {
    id: 'gate-road', en: 'Processional Way', ar: 'طريق الموكب',
    chapter: 'ch6', indoor: false, bounds: { x: [-12, 12], z: [-70, 70] },
    ground: 'bakedBrick', connects: ['palace-exterior', 'market', 'temple-precinct'],
    timeOfDay: 'day', landmarkCount: 9,
  },
  {
    id: 'poor-quarter', en: 'Poor Quarter', ar: 'الحي الفقير',
    chapter: 'ch6', indoor: false, bounds: { x: [-52, 22], z: [-34, 40] },
    ground: 'silt', connects: ['palace-exterior', 'market', 'canal-bank', 'layla-house'],
    timeOfDay: 'day', landmarkCount: 11,
  },
  {
    id: 'market', en: 'The Market', ar: 'السوق',
    chapter: 'ch6', indoor: false, bounds: { x: [-30, 30], z: [-30, 34] },
    ground: 'sand', connects: ['gate-road', 'poor-quarter', 'temple-precinct', 'canal-bank'],
    timeOfDay: 'day', landmarkCount: 12,
  },
  {
    id: 'temple-precinct', en: 'Temple Precinct', ar: 'حرم المعبد',
    chapter: 'ch6', indoor: false, bounds: { x: [-26, 26], z: [-38, 26] },
    ground: 'bakedBrick', connects: ['gate-road', 'market', 'ziggurat-terrace'],
    timeOfDay: 'day', landmarkCount: 8,
  },
  {
    id: 'ziggurat-terrace', en: 'Ziggurat Terrace', ar: 'شرفة الزقورة',
    chapter: 'ch6', indoor: false, bounds: { x: [-18, 18], z: [-18, 18] },
    ground: 'bakedBrick', connects: ['temple-precinct'], vertical: true,
    timeOfDay: 'day', landmarkCount: 4, elevation: 7.5,
  },
  {
    id: 'canal-bank', en: 'Canal Bank', ar: 'ضفة القناة',
    chapter: 'ch6', indoor: false, bounds: { x: [-44, 20], z: [-16, 46] },
    ground: 'silt', connects: ['market', 'poor-quarter', 'ruins'],
    timeOfDay: 'day', landmarkCount: 6,
  },
  {
    id: 'ruins', en: 'The Ruins', ar: 'الأطلال',
    chapter: 'ch6', indoor: false, bounds: { x: [-40, 40], z: [-40, 40] },
    ground: 'sand', connects: ['canal-bank', 'desert-edge'],
    timeOfDay: 'day', landmarkCount: 7,
  },
  {
    id: 'desert-edge', en: 'Desert Edge', ar: 'حافة الصحراء',
    chapter: 'epilogue', indoor: false, bounds: { x: [-60, 60], z: [-60, 60] },
    ground: 'sand', connects: ['ruins'],
    timeOfDay: 'day', landmarkCount: 5,
  },
  {
    id: 'layla-house', en: "Layla's House", ar: 'بيت ليلى',
    chapter: 'epilogue', indoor: true, bounds: { x: [-6, 6], z: [-8, 8] },
    ground: 'plaster', connects: ['poor-quarter'],
    timeOfDay: 'day', landmarkCount: 4,
  },
]);

export const REGION_MAP = Object.freeze(
  Object.fromEntries(REGIONS.map((r) => [r.id, r])),
);

/**
 * Landmarks (~50, §9). Each is an interactable or navigational anchor.
 * `kind` drives which procedural asset generator builds it.
 * Interactables declare the system they feed (clue, dialogue, mission, shop…).
 */
export const LANDMARKS = Object.freeze([
  // --- palace court (12)
  { id: 'lm-gate-main',    region: 'palace-court', kind: 'gatehouse',   en: 'Main Gate',          ar: 'البوابة الرئيسية', pos: [0, 0, -40], interact: 'door' },
  { id: 'lm-court-fountain', region: 'palace-court', kind: 'basin',     en: 'Stone Basin',        ar: 'الحوض الحجري',     pos: [0, 0, 4],   interact: 'examine' },
  { id: 'lm-court-palms',  region: 'palace-court', kind: 'palmGrove',   en: 'Palm Court',         ar: 'باحة النخيل',    pos: [-18, 0, 12], interact: null },
  { id: 'lm-court-stele',  region: 'palace-court', kind: 'stele',       en: 'Boundary Stone',     ar: 'حجر الحدود',     pos: [14, 0, -18], interact: 'clue' },
  { id: 'lm-court-bench',  region: 'palace-court', kind: 'bench',       en: 'Mud-brick Bench',    ar: 'مصطبة لبن',      pos: [-9, 0, -22], interact: 'sit' },
  { id: 'lm-court-brazier',region: 'palace-court', kind: 'brazier',     en: 'Bronze Brazier',     ar: 'موقد برونزي',    pos: [7, 0, -8],  interact: 'light' },
  { id: 'lm-court-stairs', region: 'palace-court', kind: 'stair',       en: 'Hall Stairs',        ar: 'درج القاعة',     pos: [0, 0, 26],  interact: 'door', vertical: true },
  { id: 'lm-court-jar-row',region: 'palace-court', kind: 'jarRow',      en: 'Oil Jar Row',        ar: 'صف جرار الزيت',  pos: [24, 0, 6],  interact: 'search' },
  { id: 'lm-court-relief', region: 'palace-court', kind: 'relief',      en: 'Glazed Relief',      ar: 'نقش مزجج',       pos: [-24, 0, 20], interact: 'examine' },
  { id: 'lm-court-guards', region: 'palace-court', kind: 'guardPost',   en: 'Guard Post',         ar: 'مركز الحرس',     pos: [4, 0, -34], interact: 'dialogue' },
  { id: 'lm-court-well',   region: 'palace-court', kind: 'well',        en: 'Courtyard Well',     ar: 'بئر الفناء',     pos: [-30, 0, -6], interact: 'search' },
  { id: 'lm-court-altar',  region: 'palace-court', kind: 'offeringTable', en: 'Offering Table',   ar: 'مائدة القرابين', pos: [30, 0, 24], interact: 'examine' },

  // --- hall of Orin (9)
  { id: 'lm-hall-throne',  region: 'palace-hall', kind: 'dais',         en: "Orin's Dais",        ar: 'عرش أورين',      pos: [0, 0, -16], interact: 'examine' },
  { id: 'lm-hall-beds',    region: 'palace-hall', kind: 'bed',          en: "Orin's Bed",         ar: 'سرير أورين',     pos: [-9, 0, -12], interact: 'dialogue' },
  { id: 'lm-hall-table',   region: 'palace-hall', kind: 'table',        en: 'Long Table',         ar: 'الطاولة الطويلة',pos: [0, 0, 2],   interact: 'examine' },
  { id: 'lm-hall-shrine',  region: 'palace-hall', kind: 'houseShrine',  en: 'Household Shrine',   ar: 'محراب البيت',    pos: [11, 0, -6], interact: 'pray' },
  { id: 'lm-hall-chest',   region: 'palace-hall', kind: 'chest',        en: 'Seal Chest',         ar: 'صندوق الختم',    pos: [-12, 0, 6], interact: 'search', key: 'basement-key' },
  { id: 'lm-hall-lamp',    region: 'palace-hall', kind: 'oilLamp',      en: 'Oil Lamp Stand',     ar: 'حامل السراج',    pos: [6, 0, -14], interact: 'light' },
  { id: 'lm-hall-rug',     region: 'palace-hall', kind: 'rug',          en: 'Wool Rug',           ar: 'سجادة صوف',      pos: [0, 0.02, -4], interact: null },
  { id: 'lm-hall-tablets', region: 'palace-hall', kind: 'tabletShelf',  en: 'Tablet Shelf',       ar: 'رف الألواح',     pos: [13, 0, 8],  interact: 'clue' },
  { id: 'lm-hall-door-cellar', region: 'palace-hall', kind: 'door',     en: 'Cellar Door',        ar: 'باب القبو',      pos: [-4, 0, 18], interact: 'door', locked: true },
  { id: 'lm-hall-linen',   region: 'palace-hall', kind: 'shelfRack',    en: 'Linen Cupboard',     ar: 'خزانة الكتان',   pos: [13, 0, -8],   interact: 'search' },
  { id: 'lm-hall-jars',    region: 'palace-hall', kind: 'jarRow',       en: 'Water Jar Row',      ar: 'صفّ جرار الماء', pos: [-13, 0, -14], interact: 'search' },

  // --- feast hall (7)
  { id: 'lm-feast-tables', region: 'feast-hall', kind: 'feastTable',    en: 'Feast Tables',       ar: 'موائد الوليمة',  pos: [0, 0, 0],   interact: 'dialogue' },
  { id: 'lm-feast-hearth', region: 'feast-hall', kind: 'hearth',        en: 'Central Hearth',     ar: 'الموقد المركزي', pos: [0, 0, -12], interact: 'examine' },
  { id: 'lm-feast-wine',   region: 'feast-hall', kind: 'wineJars',      en: 'Wine Jars',          ar: 'جرار الخمر',     pos: [-10, 0, 8], interact: 'search' },
  { id: 'lm-feast-cups',   region: 'feast-hall', kind: 'cupTable',      en: 'Cup Table',          ar: 'طاولة الأكواب',  pos: [9, 0, -4],  interact: 'clue' },
  { id: 'lm-feast-music',  region: 'feast-hall', kind: 'lyreStand',     en: 'Lyre Stand',         ar: 'حامل الكنارة',   pos: [10, 0, 12], interact: 'examine' },
  { id: 'lm-feast-dais',   region: 'feast-hall', kind: 'dais',          en: "Host's Dais",        ar: 'منصة المضيف',    pos: [0, 0, 14], interact: 'dialogue' },
  { id: 'lm-feast-screen', region: 'feast-hall', kind: 'reedScreen',    en: 'Reed Screen',        ar: 'ساتر القصب',     pos: [-8, 0, -8], interact: 'hide' },

  // --- brothers' wing (8)
  { id: 'lm-wing-novan',   region: 'brothers-wing', kind: 'bedroom',    en: "Novan's Room",       ar: 'غرفة نوفان',     pos: [-14, 0, -8], interact: 'search' },
  { id: 'lm-wing-zafir',   region: 'brothers-wing', kind: 'bedroom',    en: "Zafir's Room",       ar: 'غرفة زافير',     pos: [-14, 0, 8],  interact: 'search' },
  { id: 'lm-wing-kyle',    region: 'brothers-wing', kind: 'bedroom',    en: "Kyle's Room",        ar: 'غرفة كايل',      pos: [14, 0, -8],  interact: 'search' },
  { id: 'lm-wing-eleric',  region: 'brothers-wing', kind: 'bedroom',    en: "Eleric's Room",      ar: 'غرفة إليريك',    pos: [14, 0, 8],   interact: 'search' },
  { id: 'lm-wing-evan',    region: 'brothers-wing', kind: 'bedroom',    en: "Evan's Room",        ar: 'غرفة إيفان',     pos: [0, 0, 10],   interact: 'search' },
  { id: 'lm-wing-raynor',  region: 'brothers-wing', kind: 'bedroom',    en: "Raynor's Room",      ar: 'غرفة راينور',    pos: [0, 0, -10],  interact: 'search' },
  { id: 'lm-wing-corridor',region: 'brothers-wing', kind: 'corridor',   en: 'Wing Corridor',      ar: 'ممر الجناح',     pos: [0, 0, 0],   interact: null },
  { id: 'lm-wing-desk',    region: 'brothers-wing', kind: 'writingDesk',en: 'Writing Desk',       ar: 'مكتب الكتابة',   pos: [6, 0, 0],   interact: 'clue' },

  // --- kitchen (5)
  { id: 'lm-kitchen-oven', region: 'kitchen', kind: 'oven',             en: 'Clay Oven',          ar: 'التنور',         pos: [-5, 0, -7], interact: 'examine' },
  { id: 'lm-kitchen-bench',region: 'kitchen', kind: 'prepBench',        en: 'Prep Bench',         ar: 'طاولة التحضير',  pos: [4, 0, -4],  interact: 'search' },
  { id: 'lm-kitchen-jars', region: 'kitchen', kind: 'jarRow',           en: 'Grain Jars',         ar: 'جرار الحبوب',    pos: [-6, 0, 6],  interact: 'search' },
  { id: 'lm-kitchen-hearth',region:'kitchen', kind: 'hearth',           en: 'Kitchen Hearth',     ar: 'موقد المطبخ',    pos: [6, 0, 7],   interact: 'clue' },
  { id: 'lm-kitchen-shelf',region: 'kitchen', kind: 'herbShelf',        en: 'Herb Shelf',         ar: 'رف الأعشاب',     pos: [0, 0, -9],  interact: 'clue' },

  // --- storage (6)
  { id: 'lm-store-crates', region: 'storage', kind: 'crateStack',       en: 'Crate Stack',        ar: 'كومة الصناديق',  pos: [-7, 0, -8], interact: 'search' },
  { id: 'lm-store-sacks',  region: 'storage', kind: 'sackRow',          en: 'Grain Sacks',        ar: 'أكياس الحبوب',   pos: [7, 0, -6],  interact: 'hide' },
  { id: 'lm-store-shelves',region: 'storage', kind: 'shelfRack',        en: 'Shelf Rack',         ar: 'رفوف',           pos: [-8, 0, 6],  interact: 'search' },
  { id: 'lm-store-oil',    region: 'storage', kind: 'jarRow',           en: 'Oil Jars',           ar: 'جرار الزيت',     pos: [8, 0, 8],   interact: 'clue' },
  { id: 'lm-store-ledger', region: 'storage', kind: 'tabletShelf',      en: 'Store Ledger',       ar: 'سجل المخزن',     pos: [0, 0, 10],  interact: 'clue' },
  { id: 'lm-store-hatch',  region: 'storage', kind: 'hatch',            en: 'Cellar Hatch',       ar: 'فتحة القبو',     pos: [0, 0, -11], interact: 'door' },

  // --- cellar stair (3)
  // In a descending region pos[1] is an offset above the LOCAL floor, not above
  // the region's nominal elevation — the floor is what carries the descent.
  { id: 'lm-stair-steps',  region: 'cellar-stair', kind: 'stair',       en: 'Stone Steps',        ar: 'الدرجات الحجرية',pos: [0, 0, 0], interact: null, vertical: true },
  { id: 'lm-stair-lamp',   region: 'cellar-stair', kind: 'oilLamp',     en: 'Wall Lamp',          ar: 'سراج الحائط',    pos: [-2.5, 0, 4], interact: 'light' },
  { id: 'lm-stair-ring',   region: 'cellar-stair', kind: 'doorRing',    en: 'Door Ring',          ar: 'حلقة الباب',     pos: [0, 0, -8], interact: 'clue' },

  // --- cellar (7)
    // `enclosed: true` records that this landmark is deliberately sealed by the
  // story: Raynor is imprisoned inside until Evan opens the gate in Chapter 4.
  // reach-test asserts the cage is approachable from OUTSIDE and that its
  // interior is sealed until the gate is opened — not that it is walkable.
  { id: 'lm-cellar-cage',  region: 'cellar', kind: 'cage',             en: 'Holding Cage',       ar: 'القفص',          pos: [0, 0, -10], interact: 'dialogue', enclosed: true, gateId: 'cage-gate' },
  { id: 'lm-cellar-pillar',region: 'cellar', kind: 'pillar',           en: 'Brick Pillar',       ar: 'العمود',         pos: [-8, 0, 0],  interact: null },
  { id: 'lm-cellar-barrels',region:'cellar', kind: 'barrelRow',        en: 'Sealed Jars',        ar: 'جرار مختومة',    pos: [9, 0, -6],  interact: 'search' },
  { id: 'lm-cellar-chain', region: 'cellar', kind: 'chain',            en: 'Wall Chain',         ar: 'سلسلة الحائط',   pos: [-11, 0, -8], interact: 'examine' },
  { id: 'lm-cellar-drain', region: 'cellar', kind: 'drain',            en: 'Bitumen Drain',      ar: 'مصرف القير',     pos: [4, 0, 10],  interact: 'clue' },
  { id: 'lm-cellar-stain', region: 'cellar', kind: 'stain',            en: 'Dark Stain',         ar: 'بقعة داكنة',     pos: [-3, 0.01, 6], interact: 'clue' },
  { id: 'lm-cellar-tunnelmouth', region: 'cellar', kind: 'archway',    en: 'Tunnel Mouth',       ar: 'فوهة النفق',     pos: [0, 0, 14],  interact: 'door' },

  // --- servant passage (4)
  { id: 'lm-passage-nook', region: 'servant-passage', kind: 'alcove',   en: 'Servant Alcove',     ar: 'محراب الخدم',    pos: [-2.6, 0, -18], interact: 'hide' },
  { id: 'lm-passage-shelf',region: 'servant-passage', kind: 'shelfRack',en: 'Linen Shelf',        ar: 'رف الكتان',      pos: [2.6, 0, 6],   interact: 'search' },
  { id: 'lm-passage-lamp', region: 'servant-passage', kind: 'oilLamp',  en: 'Passage Lamp',       ar: 'سراج الممر',     pos: [-2.6, 0, 22], interact: 'light' },
  { id: 'lm-passage-dagger',region:'servant-passage', kind: 'propTable',en: 'Abandoned Table',    ar: 'طاولة مهجورة',   pos: [2.4, 0, -26], interact: 'pickup', item: 'dagger' },

  // --- tunnel (5)
  { id: 'lm-tunnel-arch1', region: 'tunnel', kind: 'archway',          en: 'Low Arch',           ar: 'قنطرة منخفضة',   pos: [0, 0, -34], interact: null },
  { id: 'lm-tunnel-water', region: 'tunnel', kind: 'channel',          en: 'Water Channel',      ar: 'مجرى الماء',     pos: [0, -0.2, 0], interact: 'examine' },
  { id: 'lm-tunnel-collapse',region:'tunnel', kind: 'rubble',          en: 'Collapsed Section',  ar: 'قسم منهار',      pos: [0, 0, 28],  interact: 'climb', vertical: true },
  { id: 'lm-tunnel-niche', region: 'tunnel', kind: 'alcove',           en: 'Dry Niche',          ar: 'كوة جافة',       pos: [-3.2, 0, 14], interact: 'hide' },
  { id: 'lm-tunnel-grate', region: 'tunnel', kind: 'grate',            en: 'Bronze Grate',       ar: 'مشبكة برونزية',  pos: [0, 0, 46],  interact: 'door' },

  // --- palace exterior (8)
  { id: 'lm-ext-ramp',     region: 'palace-exterior', kind: 'ramp',    en: 'Outer Ramp',         ar: 'المنحدر الخارجي',pos: [0, 0, 34],  interact: null, vertical: true },
  { id: 'lm-ext-wall',     region: 'palace-exterior', kind: 'cityWall',en: 'Outer Wall',         ar: 'السور الخارجي',  pos: [0, 0, -26], interact: null },
  { id: 'lm-ext-dump',     region: 'palace-exterior', kind: 'rubble',  en: 'Ash Dump',           ar: 'كومة الرماد',    pos: [-22, 0, 12], interact: 'search' },
  { id: 'lm-ext-stable',   region: 'palace-exterior', kind: 'stable',  en: 'Donkey Stable',      ar: 'حظيرة الحمير',   pos: [24, 0, 8],  interact: 'examine' },
  { id: 'lm-ext-guardtower',region:'palace-exterior', kind: 'watchPost',en: 'Watch Post',        ar: 'مركز المراقبة',  pos: [18, 0, -20], interact: null },
  { id: 'lm-ext-garden',   region: 'palace-exterior', kind: 'palmGrove',en: 'Outer Garden',      ar: 'الحديقة الخارجية',pos: [-26, 0, -14], interact: null },
  { id: 'lm-ext-cistern',  region: 'palace-exterior', kind: 'well',    en: 'Cistern',            ar: 'الصهريج',        pos: [28, 0, 26], interact: 'search' },
  { id: 'lm-ext-kiln',     region: 'palace-exterior', kind: 'kiln',    en: 'Brick Kiln',         ar: 'قمين الآجر',     pos: [-14, 0, 30], interact: 'examine' },

  // --- processional way (9)
  { id: 'lm-road-lions',   region: 'gate-road', kind: 'relief',         en: 'Lion Relief Wall',   ar: 'جدار الأسود',    pos: [-9, 0, -20], interact: 'examine' },
  { id: 'lm-road-columns', region: 'gate-road', kind: 'buttressRow',    en: 'Buttress Row',       ar: 'صف الدعائم',     pos: [9, 0, 10],   interact: null },
  { id: 'lm-road-arch',    region: 'gate-road', kind: 'archway',        en: 'Great Arch',         ar: 'القوس الكبير',   pos: [0, 0, -52],  interact: null },
  { id: 'lm-road-sphinx',  region: 'gate-road', kind: 'lamassu',        en: 'Lamassu Statue',     ar: 'تمثال اللاماسو', pos: [-8, 0, -44], interact: 'examine' },
  { id: 'lm-road-sphinx2', region: 'gate-road', kind: 'lamassu',        en: 'Lamassu Statue',     ar: 'تمثال اللاماسو', pos: [8, 0, -44],  interact: 'examine' },
  { id: 'lm-road-brazier1',region: 'gate-road', kind: 'brazier',        en: 'Road Brazier',       ar: 'موقد الطريق',    pos: [-7, 0, 30],  interact: 'light' },
  { id: 'lm-road-brazier2',region: 'gate-road', kind: 'brazier',        en: 'Road Brazier',       ar: 'موقد الطريق',    pos: [7, 0, 30],   interact: 'light' },
  { id: 'lm-road-stele',   region: 'gate-road', kind: 'stele',          en: 'Cuneiform Stele',    ar: 'لوحة مسمارية',   pos: [10, 0, -8],  interact: 'clue' },
  { id: 'lm-road-stall',   region: 'gate-road', kind: 'marketStall',    en: 'Roadside Stall',     ar: 'بسطة الطريق',    pos: [-10, 0, 44], interact: 'shop' },

  // --- poor quarter (11)
  { id: 'lm-pq-hut1',      region: 'poor-quarter', kind: 'hut',        en: 'Reed Hut',           ar: 'كوخ القصب',      pos: [-38, 0, -20], interact: 'search' },
  { id: 'lm-pq-hut2',      region: 'poor-quarter', kind: 'hut',        en: 'Mud-brick Shack',    ar: 'كوخ لبن',        pos: [-30, 0, -6],  interact: 'search' },
  { id: 'lm-pq-alley',     region: 'poor-quarter', kind: 'alley',      en: 'Narrow Alley',       ar: 'زقاق ضيق',       pos: [-20, 0, 8],   interact: 'hide' },
  { id: 'lm-pq-washyard',  region: 'poor-quarter', kind: 'basin',      en: 'Wash Yard',          ar: 'ساحة الغسيل',    pos: [-10, 0, -18], interact: 'dialogue' },
  { id: 'lm-pq-bakery',    region: 'poor-quarter', kind: 'oven',       en: 'Quarter Oven',       ar: 'تنور الحي',      pos: [4, 0, 4],     interact: 'shop' },
  { id: 'lm-pq-brokenwell',region: 'poor-quarter', kind: 'well',       en: 'Broken Well',        ar: 'بئر معطلة',      pos: [14, 0, -12],  interact: 'search' },
  { id: 'lm-pq-ruinwall',  region: 'poor-quarter', kind: 'rubble',     en: 'Fallen Wall',        ar: 'جدار منهار',     pos: [-44, 0, 20],  interact: 'climb', vertical: true },
  { id: 'lm-pq-shrine',    region: 'poor-quarter', kind: 'houseShrine',en: 'Street Shrine',      ar: 'مزار الشارع',    pos: [10, 0, 26],   interact: 'pray' },
  { id: 'lm-pq-pens',      region: 'poor-quarter', kind: 'stable',     en: 'Goat Pens',          ar: 'حظيرة الماعز',   pos: [-26, 0, 30],  interact: 'examine' },
  { id: 'lm-pq-ashheap',   region: 'poor-quarter', kind: 'rubble',     en: 'Ash Heap',           ar: 'كومة الرماد',    pos: [18, 0, 14],   interact: 'search' },
  { id: 'lm-pq-cart',      region: 'poor-quarter', kind: 'cart',       en: 'Broken Cart',        ar: 'عربة مكسورة',    pos: [-6, 0, 22],   interact: 'search', sidequest: 'stolen-goods' },

  // --- market (12)
  { id: 'lm-mk-grain',     region: 'market', kind: 'marketStall',       en: 'Grain Stall',        ar: 'بسطة الحبوب',    pos: [-18, 0, -14], interact: 'shop' },
  { id: 'lm-mk-cloth',     region: 'market', kind: 'marketStall',       en: 'Cloth Stall',        ar: 'بسطة الأقمشة',   pos: [-8, 0, -18],  interact: 'shop' },
  { id: 'lm-mk-pottery',   region: 'market', kind: 'marketStall',       en: 'Pottery Stall',      ar: 'بسطة الفخار',    pos: [4, 0, -16],   interact: 'shop' },
  { id: 'lm-mk-bronze',    region: 'market', kind: 'marketStall',       en: 'Bronze Smith',       ar: 'حداد البرونز',   pos: [16, 0, -10],  interact: 'shop' },
  { id: 'lm-mk-fish',      region: 'market', kind: 'marketStall',       en: 'Fish Stall',         ar: 'بسطة السمك',     pos: [-20, 0, 6],   interact: 'shop' },
  { id: 'lm-mk-spice',     region: 'market', kind: 'marketStall',       en: 'Spice Stall',        ar: 'بسطة التوابل',   pos: [-6, 0, 10],   interact: 'clue' },
  { id: 'lm-mk-slave',     region: 'market', kind: 'platform',          en: 'Labour Platform',    ar: 'منصة العمال',    pos: [10, 0, 8],    interact: 'dialogue' },
  { id: 'lm-mk-scribe',    region: 'market', kind: 'writingDesk',       en: "Scribe's Corner",    ar: 'زاوية الكاتب',   pos: [22, 0, 16],   interact: 'dialogue' },
  { id: 'lm-mk-wellwater', region: 'market', kind: 'well',              en: 'Market Well',        ar: 'بئر السوق',      pos: [0, 0, 0],     interact: 'examine' },
  { id: 'lm-mk-awnings',   region: 'market', kind: 'awningRow',         en: 'Reed Awnings',       ar: 'مظلات القصب',    pos: [0, 0, 22],    interact: 'hide' },
  { id: 'lm-mk-moneylender',region:'market', kind: 'marketStall',       en: 'Money Lender',       ar: 'المرابي',        pos: [-24, 0, 20],  interact: 'shop', sidequest: 'old-debt' },
  { id: 'lm-mk-thief',     region: 'market', kind: 'alley',             en: 'Thief Alley',        ar: 'زقاق اللصوص',    pos: [24, 0, -22],  interact: 'dialogue', sidequest: 'stolen-goods' },

  // --- temple precinct (8)
  { id: 'lm-tp-gate',      region: 'temple-precinct', kind: 'gatehouse',en: 'Precinct Gate',      ar: 'بوابة الحرم',    pos: [0, 0, 22],    interact: 'door' },
  { id: 'lm-tp-court',     region: 'temple-precinct', kind: 'courtyard',en: 'Temple Court',       ar: 'فناء المعبد',    pos: [0, 0, 4],     interact: null },
  { id: 'lm-tp-altar',     region: 'temple-precinct', kind: 'offeringTable', en: 'Great Altar',   ar: 'المذبح العظيم',  pos: [0, 0.5, -18], interact: 'examine' },
  { id: 'lm-tp-cella',     region: 'temple-precinct', kind: 'cella',    en: 'Inner Cella',        ar: 'القدْس',         pos: [0, 0, -30],   interact: 'dialogue' },
  { id: 'lm-tp-basin',     region: 'temple-precinct', kind: 'basin',    en: 'Ablution Basin',     ar: 'حوض الوضوء',     pos: [-12, 0, -8],  interact: 'examine' },
  { id: 'lm-tp-priests',   region: 'temple-precinct', kind: 'guardPost',en: "Priests' Stand",     ar: 'موقف الكهنة',    pos: [12, 0, -8],   interact: 'dialogue' },
  { id: 'lm-tp-tablets',   region: 'temple-precinct', kind: 'tabletShelf',en: 'Temple Archive',   ar: 'أرشيف المعبد',   pos: [-18, 0, -26], interact: 'clue' },
  { id: 'lm-tp-stairs',    region: 'temple-precinct', kind: 'stair',    en: 'Terrace Stairs',     ar: 'درج الشرفة',     pos: [0, 0, -34],   interact: null, vertical: true },

  // --- ziggurat terrace (4)
  { id: 'lm-zt-shrine',    region: 'ziggurat-terrace', kind: 'houseShrine', en: 'Summit Shrine', ar: 'مزار القمة',     pos: [0, 7.5, 0],   interact: 'examine' },
  { id: 'lm-zt-view',      region: 'ziggurat-terrace', kind: 'parapet',  en: 'Parapet',          ar: 'الدرابزين',      pos: [0, 7.5, -14], interact: 'examine' },
  { id: 'lm-zt-brazier',   region: 'ziggurat-terrace', kind: 'brazier',  en: 'Signal Brazier',   ar: 'موقد الإشارة',   pos: [-10, 7.5, 8], interact: 'light' },
  { id: 'lm-zt-stairs',    region: 'ziggurat-terrace', kind: 'stair',    en: 'Terrace Steps',    ar: 'درجات الشرفة',   pos: [0, 3.8, 14],  interact: null, vertical: true },

  // --- canal bank (6)
  { id: 'lm-cb-bridge',    region: 'canal-bank', kind: 'bridge',        en: 'Timber Bridge',      ar: 'الجسر الخشبي',   pos: [-6, 0, 10], interact: null },
  { id: 'lm-cb-mooring',   region: 'canal-bank', kind: 'mooring',       en: 'Reed Boat Mooring',  ar: 'مرسى القوارب',   pos: [-22, 0, 22],  interact: 'examine' },
  { id: 'lm-cb-washsteps', region: 'canal-bank', kind: 'stair',         en: 'Wash Steps',         ar: 'درجات الغسيل',   pos: [2, 0, 30],    interact: 'examine', vertical: true },
  { id: 'lm-cb-reedbed',   region: 'canal-bank', kind: 'reedBed',       en: 'Reed Bed',           ar: 'مستنقع القصب',   pos: [-34, 0, 4],   interact: 'hide' },
  { id: 'lm-cb-potter',    region: 'canal-bank', kind: 'kiln',          en: "Potter's Kiln",      ar: 'قمين الفخار',    pos: [12, 0, -8],   interact: 'dialogue' },
  { id: 'lm-cb-body',      region: 'canal-bank', kind: 'stain',         en: 'Something Afloat',   ar: 'شيء طافٍ',       pos: [-18, 0, 34],  interact: 'clue' },

  // --- ruins (7)
  { id: 'lm-ru-arch',      region: 'ruins', kind: 'archway',            en: 'Broken Arch',        ar: 'قنطرة مكسورة',   pos: [-14, 0, -12], interact: null },
  { id: 'lm-ru-vault',     region: 'ruins', kind: 'vault',              en: 'Sunken Vault',       ar: 'القبو الغائر',   pos: [6, -2.4, 8],  interact: 'search', vertical: true, artifact: true },
  { id: 'lm-ru-wallstub',  region: 'ruins', kind: 'rubble',             en: 'Wall Stub',          ar: 'بقايا جدار',     pos: [22, 0, -20],  interact: 'climb', vertical: true },
  { id: 'lm-ru-stele',     region: 'ruins', kind: 'stele',              en: 'Fallen Stele',       ar: 'لوحة ساقطة',     pos: [-26, 0, 18],  interact: 'clue' },
  { id: 'lm-ru-cistern',   region: 'ruins', kind: 'well',               en: 'Dry Cistern',        ar: 'صهريج جاف',      pos: [16, 0, 26],   interact: 'search' },
  { id: 'lm-ru-foundations',region:'ruins', kind: 'foundation',         en: 'Old Foundations',    ar: 'الأساسات',       pos: [-4, 0, -30],  interact: 'examine' },
  { id: 'lm-ru-ambush',    region: 'ruins', kind: 'alley',              en: 'Ambush Cut',         ar: 'منزل الكمين',    pos: [30, 0, 4],    interact: null, sidequest: 'layla-ambush' },

  // --- desert edge (5)
  { id: 'lm-de-dunes',     region: 'desert-edge', kind: 'dune',         en: 'First Dunes',        ar: 'أول الكثبان',    pos: [0, 1.2, -30], interact: null },
  { id: 'lm-de-camp',      region: 'desert-edge', kind: 'camp',         en: 'Abandoned Camp',     ar: 'مخيم مهجور',     pos: [-28, 0, 10],  interact: 'search' },
  { id: 'lm-de-cairn',     region: 'desert-edge', kind: 'rubble',       en: 'Stone Cairn',        ar: 'رجْم حجري',      pos: [24, 0, 20],   interact: 'examine' },
  { id: 'lm-de-drywell',   region: 'desert-edge', kind: 'well',         en: 'Dry Well',           ar: 'بئر جافة',       pos: [12, 0, -44],  interact: 'search' },
  { id: 'lm-de-horizon',   region: 'desert-edge', kind: 'parapet',      en: 'Horizon Ridge',      ar: 'حافة الأفق',     pos: [0, 2.5, 48],  interact: 'examine' },

  // --- Layla's house (4)
  { id: 'lm-ll-hearth',    region: 'layla-house', kind: 'hearth',       en: 'Layla\'s Hearth',    ar: 'موقد ليلى',      pos: [-3, 0, -5],   interact: 'dialogue' },
  { id: 'lm-ll-loom',      region: 'layla-house', kind: 'loom',         en: 'Loom',               ar: 'النول',          pos: [4, 0, -3],    interact: 'examine' },
  { id: 'lm-ll-table',     region: 'layla-house', kind: 'table',        en: 'Low Table',          ar: 'طاولة منخفضة',   pos: [0, 0, 3],     interact: 'dialogue', sidequest: 'artifact' },
  { id: 'lm-ll-chest',     region: 'layla-house', kind: 'chest',        en: 'Woven Chest',        ar: 'صندوق مضفور',    pos: [-4, 0, 5],    interact: 'search' },
]);

export const LANDMARK_MAP = Object.freeze(
  Object.fromEntries(LANDMARKS.map((l) => [l.id, l])),
);

/** Landmarks per region — used by the world builder and the map UI. */
export const LANDMARKS_BY_REGION = Object.freeze(REGIONS.reduce((acc, r) => {
  acc[r.id] = LANDMARKS.filter((l) => l.region === r.id).map((l) => l.id);
  return acc;
}, {}));

/**
 * Validate the world graph at import time. A broken region link would make a
 * chapter uncompletable (P0 under §19), so we fail loudly during boot instead.
 */
export function validateWorldData() {
  const errors = [];
  const regionIds = new Set(REGIONS.map((r) => r.id));

  for (const r of REGIONS) {
    if (!r.id || !r.en || !r.ar) errors.push(`region ${r.id}: missing id/en/ar`);
    // A declared count that has drifted from the real one is how a region ends up
    // asking the player to search places that were never built.
    const actual = LANDMARKS.filter((l) => l.region === r.id).length;
    if (typeof r.landmarkCount === 'number' && r.landmarkCount !== actual) {
      errors.push(`region ${r.id}: declares ${r.landmarkCount} landmarks, has ${actual}`);
    }
    // Chapter is a story chapter id ('ch3', 'epilogue'), not a number. The story
    // layer cross-checks the value against its own chapter list.
    if (typeof r.chapter !== 'string' || !r.chapter) {
      errors.push(`region ${r.id}: chapter must be a chapter id string, got ${JSON.stringify(r.chapter)}`);
    }
    if (!r.bounds) errors.push(`region ${r.id}: missing bounds`);
    for (const c of r.connects ?? []) {
      if (!regionIds.has(c)) errors.push(`region ${r.id}: connects to unknown region "${c}"`);
    }
    // Connectivity must be symmetric — a one-way door would trap the player.
    for (const c of r.connects ?? []) {
      const other = REGION_MAP[c];
      if (other && !(other.connects ?? []).includes(r.id)) {
        errors.push(`region ${r.id} -> ${c} is not bidirectional`);
      }
    }
  }

  const landmarkIds = new Set();
  for (const l of LANDMARKS) {
    if (landmarkIds.has(l.id)) errors.push(`duplicate landmark id "${l.id}"`);
    landmarkIds.add(l.id);
    if (!regionIds.has(l.region)) errors.push(`landmark ${l.id}: unknown region "${l.region}"`);
    if (!l.en || !l.ar) errors.push(`landmark ${l.id}: missing en/ar name`);
    if (!Array.isArray(l.pos) || l.pos.length !== 3) errors.push(`landmark ${l.id}: bad pos`);
    const region = REGION_MAP[l.region];
    if (region) {
      const [x, , z] = l.pos;
      const [x0, x1] = region.bounds.x;
      const [z0, z1] = region.bounds.z;
      if (x < x0 || x > x1 || z < z0 || z > z1) {
        errors.push(`landmark ${l.id} at (${x},${z}) is outside region ${l.region} bounds`);
      }
    }
  }

  // Every region must be reachable from the palace courtyard.
  const seen = new Set(['palace-court']);
  const queue = ['palace-court'];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of REGION_MAP[cur]?.connects ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  for (const r of REGIONS) {
    if (!seen.has(r.id)) errors.push(`region ${r.id} is unreachable from palace-court`);
  }

  return { ok: errors.length === 0, errors, regionCount: REGIONS.length, landmarkCount: LANDMARKS.length };
}
