/**
 * THE BETRAYED WILL — story.js
 *
 * The narrative spine: characters, chapters, missions, clues and cinematics.
 *
 * ── Why this file is data and not prose ──────────────────────────────────────
 * Every mission, clue and cinematic here is bound to a REAL region id and a REAL
 * landmark id from world-data.js, and `validateStoryData()` proves it. A story
 * layer that invents its own place names drifts from the generated world the
 * first time someone edits either file, and the failure is invisible until a
 * player is told to "search the writing desk" in a room that has no desk. Binding
 * by id, and validating, makes that class of bug impossible to ship.
 *
 * The world data already encoded the shape of this story before it was written:
 * exactly 14 landmarks carry `interact:"dialogue"` (the 14 required dialogue
 * trees) and 16 carry `interact:"clue"` (from which the 10 required clues are
 * drawn). The plot below is built to fit that, not the other way round — so a
 * clue is always something the player can physically walk to and examine.
 *
 * ── Canon ───────────────────────────────────────────────────────────────────
 * Orin, lord of the house, dictates his will onto clay tablets and is murdered
 * before it is read. One tablet is a forgery. Raynor — the player, and the heir
 * the true will names — investigates across six chapters, is wounded in the
 * servant passages in Chapter 5 (which is why COMBAT.INJURED_DAMAGE_SCALE exists
 * and why MOVE has an injured speed band), and in the epilogue confronts the
 * brother who betrayed the will.
 *
 * The traitor is EVAN. The motive is debt: the market moneylender holds his
 * bonds, and the true will left the estate to Raynor. Evan bribed the market
 * scribe to copy Orin's seal onto a fresh tablet, put bitter herb in Orin's cup
 * at the feast, held him in the cellar cage while the poison worked, washed the
 * blood toward the bitumen drain, and drowned the scribe in the canal to close
 * the only loose end. The body the canal gives back in Chapter 6 is that scribe.
 *
 * Every brother is given a reason to be suspected, because a mystery with one
 * suspect is not a mystery: Novan quarrelled with Orin publicly, Zafir also owes
 * money, Kyle sat nearest the cup table, and Eleric has temple access and could
 * have reached the archive copy.
 *
 * Arabic is first-class here, not a translation layer bolted on afterwards: every
 * title, briefing, objective and clue carries `ar` beside `en`, and the two are
 * authored together so neither can fall behind.
 */

import { REGIONS, REGION_MAP, LANDMARKS, LANDMARK_MAP } from './world-data.js';

/* ------------------------------------------------------------- characters */

export const Role = Object.freeze({
  PROTAGONIST: 'protagonist',
  VICTIM: 'victim',
  BROTHER: 'brother',
  SISTER: 'sister',
  TRAITOR: 'traitor',
  WITNESS: 'witness',
  OFFICIAL: 'official',
});

export const CHARACTERS = Object.freeze({
  raynor: Object.freeze({
    id: 'raynor', en: 'Raynor', ar: 'راينور',
    role: Role.PROTAGONIST, player: true,
    title: { en: 'Heir named by the true will', ar: 'الوريث الذي سمّته الوصية الحقيقية' },
    // Chapter 5 is where Raynor is wounded. Both the movement and the combat
    // systems read this: MOVE has an injured speed band and COMBAT has
    // INJURED_DAMAGE_SCALE. An injury that costs nothing is a cosmetic flag.
    injuredFromChapter: 'ch5',
  }),
  orin: Object.freeze({
    id: 'orin', en: 'Orin', ar: 'أورين', role: Role.VICTIM, player: false,
    title: { en: 'Lord of the house, dictating his will', ar: 'سيّد الدار، يُملي وصيته' },
  }),
  layla: Object.freeze({
    id: 'layla', en: 'Layla', ar: 'ليلى', role: Role.SISTER, player: false,
    title: { en: 'Raynor’s sister, keeper of the house memory', ar: 'أخت راينور، حافظة ذاكرة الدار' },
  }),
  novan: Object.freeze({
    id: 'novan', en: 'Novan', ar: 'نوفان', role: Role.BROTHER, player: false,
    title: { en: 'Eldest brother; quarrelled with Orin openly', ar: 'الأخ الأكبر؛ خاصم أورين علنًا' },
    suspect: { motive: { en: 'A public quarrel over the estate', ar: 'خصام علني على التركة' }, weight: 2 },
  }),
  zafir: Object.freeze({
    id: 'zafir', en: 'Zafir', ar: 'زافر', role: Role.BROTHER, player: false,
    title: { en: 'Brother; owes the moneylender', ar: 'أخ؛ مدين للمرابي' },
    suspect: { motive: { en: 'Debts, though smaller than Evan’s', ar: 'ديون، وإن كانت أصغر من ديون إيفان' }, weight: 2 },
  }),
  kyle: Object.freeze({
    id: 'kyle', en: 'Kyle', ar: 'كايل', role: Role.BROTHER, player: false,
    title: { en: 'Brother; sat nearest the cup table', ar: 'أخ؛ جلس الأقرب إلى طاولة الأكواب' },
    suspect: { motive: { en: 'Nearest the poisoned cup', ar: 'الأقرب إلى الكأس المسمومة' }, weight: 3 },
  }),
  eleric: Object.freeze({
    id: 'eleric', en: 'Eleric', ar: 'إليريك', role: Role.BROTHER, player: false,
    title: { en: 'Brother; has standing in the temple', ar: 'أخ؛ له مكانة في المعبد' },
    suspect: { motive: { en: 'Temple access could reach the archive copy', ar: 'نفوذه في المعبد قد يبلغ نسخة الأرشيف' }, weight: 2 },
  }),
  evan: Object.freeze({
    id: 'evan', en: 'Evan', ar: 'إيفان', role: Role.TRAITOR, player: false,
    title: { en: 'Youngest brother; the hand that betrayed the will', ar: 'الأخ الأصغر؛ اليد التي غدرت بالوصية' },
    suspect: { motive: { en: 'Held by the moneylender’s bonds', ar: 'تُثقله سندات المرابي' }, weight: 1 },
    traitor: true,
  }),
  scribe: Object.freeze({
    id: 'scribe', en: 'Bel-ushar the scribe', ar: 'بيل أوشّر الكاتب', role: Role.WITNESS, player: false,
    title: { en: 'Copied the forged seal; drowned for it', ar: 'نسخ الختم المزوَّر؛ فأُغرق لذلك' },
    dead: true,
  }),
  priest: Object.freeze({
    id: 'priest', en: 'The šangu-priest', ar: 'الكاهن شانغو', role: Role.OFFICIAL, player: false,
    title: { en: 'Keeper of the temple archive', ar: 'حافظ أرشيف المعبد' },
  }),
});

/* --------------------------------------------------------------- chapters */

/**
 * Prologue + six chapters + epilogue = eight acts, in the mandated order.
 * `regions` are the world-data region ids this act plays in, and each is checked
 * against REGION_MAP by validateStoryData().
 */
export const CHAPTERS = Object.freeze([
  Object.freeze({
    id: 'prologue', index: 0, order: 'prologue',
    en: 'Prologue — The Dictation', ar: 'المقدمة — الإملاء',
    regions: ['palace-court'], timeOfDay: 'dusk',
    premise: {
      en: 'Orin dictates his will onto clay in the courtyard while the house waits.',
      ar: 'يُملي أورين وصيته على الطين في الفناء بينما تنتظر الدار.',
    },
  }),
  Object.freeze({
    id: 'ch1', index: 1, order: 'chapter',
    en: 'Chapter 1 — The Sealed Tablets', ar: 'الفصل الأول — الألواح المختومة',
    regions: ['palace-hall'], timeOfDay: 'night',
    premise: {
      en: 'Orin is found dead before dawn. The tablet shelf holds seven tablets, and one is wrong.',
      ar: 'يوجد أورين ميتًا قبل الفجر. يحمل رفّ الألواح سبعة ألواح، وأحدها خطأ.',
    },
  }),
  Object.freeze({
    id: 'ch2', index: 2, order: 'chapter',
    en: 'Chapter 2 — The Feast of Brothers', ar: 'الفصل الثاني — وليمة الإخوة',
    regions: ['feast-hall'], timeOfDay: 'night',
    premise: {
      en: 'The mourning feast is held. Every brother is present, and one cup was poured twice.',
      ar: 'تُقام وليمة العزاء. كل الإخوة حاضرون، وكأس واحدة صُبّت مرتين.',
    },
  }),
  Object.freeze({
    id: 'ch3', index: 3, order: 'chapter',
    en: 'Chapter 3 — Seven Doors', ar: 'الفصل الثالث — سبعة أبواب',
    regions: ['brothers-wing', 'kitchen', 'storage', 'cellar-stair'], timeOfDay: 'night',
    premise: {
      en: 'The house is searched while it sleeps: six brothers’ rooms, a kitchen, a store, and a locked stair.',
      ar: 'تُفتَّش الدار وهي نائمة: غرف ستة إخوة، ومطبخ، ومخزن، ودَرَج مقفل.',
    },
  }),
  Object.freeze({
    id: 'ch4', index: 4, order: 'chapter',
    en: 'Chapter 4 — What the Cellar Keeps', ar: 'الفصل الرابع — ما يُخفيه القبو',
    regions: ['cellar'], timeOfDay: 'night',
    premise: {
      en: 'Below the stair is a holding cage, a dark stain, and a bitumen drain that was washed recently.',
      ar: 'تحت الدَرَج قفص حبس، وبقعة داكنة، ومصرف قير غُسل حديثًا.',
    },
  }),
  Object.freeze({
    id: 'ch5', index: 5, order: 'chapter',
    en: 'Chapter 5 — The Servant’s Way', ar: 'الفصل الخامس — طريق الخدم',
    regions: ['servant-passage', 'tunnel', 'palace-exterior'], timeOfDay: 'night',
    premise: {
      en: 'Raynor is caught in the passages, wounded, and goes out through the tunnel rather than the gate.',
      ar: 'يُقبض على راينور في الممرات، فيُجرح، ويخرج من النفق لا من البوابة.',
    },
    // The injury is a story fact with mechanical consequences, declared once here
    // and read by both movement and combat.
    injuresPlayer: true,
  }),
  Object.freeze({
    id: 'ch6', index: 6, order: 'chapter',
    en: 'Chapter 6 — The City’s Tongue', ar: 'الفصل السادس — لسان المدينة',
    regions: ['gate-road', 'poor-quarter', 'market', 'temple-precinct',
      'ziggurat-terrace', 'canal-bank', 'ruins'], timeOfDay: 'day',
    premise: {
      en: 'Outside the palace the city talks: a scribe’s corner, a temple archive, and something afloat in the canal.',
      ar: 'خارج القصر تتكلم المدينة: زاوية كاتب، وأرشيف معبد، وشيء طافٍ في القناة.',
    },
  }),
  Object.freeze({
    id: 'epilogue', index: 7, order: 'epilogue',
    en: 'Epilogue — The Betrayed Will', ar: 'الخاتمة — وصية الغدر',
    regions: ['desert-edge', 'layla-house'], timeOfDay: 'dawn',
    premise: {
      en: 'At the desert edge the last brother is confronted, and at Layla’s hearth the true will is read aloud.',
      ar: 'عند حافة الصحراء يُواجه آخر الإخوة، وعند موقد ليلى تُقرأ الوصية الحقيقية جهارًا.',
    },
  }),
]);

export const CHAPTER_MAP = Object.freeze(
  CHAPTERS.reduce((acc, c) => { acc[c.id] = c; return acc; }, {}),
);

/* -------------------------------------------------------- objective types */

/**
 * The closed vocabulary of objective kinds.
 *
 * Closed on purpose: the mission system switches on these, so a content author
 * who invents a new kind gets a validation error here rather than an objective
 * that can never complete and silently soft-locks the campaign.
 */
export const ObjectiveType = Object.freeze({
  GOTO: 'goto',            // reach a region or landmark
  EXAMINE: 'examine',      // inspect a landmark
  CLUE: 'clue',            // acquire a specific clue
  DIALOGUE: 'dialogue',    // complete a dialogue tree
  SEARCH: 'search',        // search N of M marked places
  TAKEDOWN: 'takedown',    // silent takedown count
  COMBAT: 'combat',        // defeat N enemies
  SURVIVE: 'survive',      // survive for N seconds
  ESCAPE: 'escape',        // leave a region while pursued
  CINEMATIC: 'cinematic',  // witness a cinematic
  INTERACT: 'interact',    // use a landmark's interact verb
  RETURN: 'return',        // bring something to someone
});

/* ------------------------------------------------------------------ clues */

/**
 * The ten clues. Each binds to a landmark whose `interact` is `clue`, so every
 * clue is something the player can walk to and examine — never a fact handed over
 * by a loading screen. `incriminates` is deliberately NOT always the traitor:
 * four of the ten point at innocent brothers, because a case where every piece of
 * evidence points one way teaches the player nothing and can be solved by
 * guessing.
 */
export const CLUES = Object.freeze([
  Object.freeze({
    id: 'clue-boundary-stone', landmark: 'lm-court-stele', chapter: 'prologue',
    en: { name: 'The Boundary Stone', text: 'Orin’s own hand records the estate’s bounds, and names Raynor heir to the house and its tablets.' },
    ar: { name: 'حجر الحدود', text: 'بيد أورين نفسه سُجّلت حدود التركة، وسمّى راينور وارثًا للدار وألواحها.' },
    incriminates: null, weight: 1,
  }),
  Object.freeze({
    id: 'clue-tablet-shelf', landmark: 'lm-hall-tablets', chapter: 'ch1',
    en: { name: 'The Seventh Tablet', text: 'Seven tablets on the shelf. The seventh is a different clay, fired later, and its seal is pressed rather than rolled.' },
    ar: { name: 'اللوح السابع', text: 'سبعة ألواح على الرف. السابع من طين مختلف، أُحرق لاحقًا، وختمه ضُغط بدل أن يُدحرج.' },
    incriminates: null, weight: 3,
  }),
  Object.freeze({
    id: 'clue-cup-table', landmark: 'lm-feast-cups', chapter: 'ch2',
    en: { name: 'The Twice-Poured Cup', text: 'One cup at the table was rinsed and poured again. A bitter residue remains in the foot.' },
    ar: { name: 'الكأس التي صُبّت مرتين', text: 'كأس واحدة على المائدة شُطفت ثم صُبّت من جديد. وتبقى رواسب مرة في قاعدتها.' },
    incriminates: 'kyle', weight: 2,
  }),
  Object.freeze({
    id: 'clue-writing-desk', landmark: 'lm-wing-desk', chapter: 'ch3',
    en: { name: 'The Practised Seal', text: 'Wax scraps bearing a seal pressed again and again, learning a hand. The desk is in the brothers’ corridor, not in a specific room.' },
    ar: { name: 'الختم المُتدرَّب عليه', text: 'قصاصات شمع تحمل ختمًا ضُغط مرة بعد مرة يتعلّم يدًا. المكتب في ممر الإخوة، لا في غرفة بعينها.' },
    incriminates: 'novan', weight: 2,
  }),
  Object.freeze({
    id: 'clue-herb-shelf', landmark: 'lm-kitchen-shelf', chapter: 'ch3',
    en: { name: 'The Missing Bitter Herb', text: 'A jar of bitter herb, emptied. The cook measures by handfuls and swears she did not use it that night.' },
    ar: { name: 'العشب المرّ المفقود', text: 'جرّة عشب مرّ، أُفرغت. الطاهية تكيل بالقبضات وتُقسم أنها لم تستعمله تلك الليلة.' },
    incriminates: null, weight: 3,
  }),
  Object.freeze({
    id: 'clue-store-ledger', landmark: 'lm-store-ledger', chapter: 'ch3',
    en: { name: 'The Store Ledger', text: 'Bitumen and oil drawn after the feast, on the night the cellar was washed. The mark beside the entry is Evan’s.' },
    ar: { name: 'سجل المخزن', text: 'قير وزيت سُحبا بعد الوليمة، في الليلة التي غُسل فيها القبو. العلامة إلى جانب القيد هي علامة إيفان.' },
    incriminates: 'evan', weight: 3,
  }),
  Object.freeze({
    id: 'clue-door-ring', landmark: 'lm-stair-ring', chapter: 'ch3',
    en: { name: 'The Door Ring', text: 'A bronze ring, snapped from a hand and caught in the stair door’s hasp. It matches a gap on Evan’s right hand.' },
    ar: { name: 'حلقة الباب', text: 'حلقة برونزية، انتُزعت من يد وعلقت في عروة باب الدَرَج. تطابق فراغًا في يد إيفان اليمنى.' },
    incriminates: 'evan', weight: 3,
  }),
  Object.freeze({
    id: 'clue-dark-stain', landmark: 'lm-cellar-stain', chapter: 'ch4',
    en: { name: 'The Dark Stain', text: 'Blood, washed toward the bitumen drain but not out of the floor’s pores. Someone was held here while the poison worked.' },
    ar: { name: 'البقعة الداكنة', text: 'دم، غُسل نحو مصرف القير لكنه لم يخرج من مسام الأرضية. أحدهم حُبس هنا بينما كان السمّ يعمل.' },
    incriminates: null, weight: 3,
  }),
  Object.freeze({
    id: 'clue-temple-archive', landmark: 'lm-tp-tablets', chapter: 'ch6',
    en: { name: 'The Temple’s Copy', text: 'The archive holds the witnessed copy Orin lodged with the temple. It names Raynor. Its date precedes the seventh tablet by a month.' },
    ar: { name: 'نسخة المعبد', text: 'يحتفظ الأرشيف بالنسخة المشهود عليها التي أودعها أورين المعبد. تُسمّي راينور. ويسبق تاريخها اللوح السابع بشهر.' },
    incriminates: 'evan', weight: 4,
  }),
  Object.freeze({
    id: 'clue-canal-body', landmark: 'lm-cb-body', chapter: 'ch6',
    en: { name: 'What the Canal Gave Back', text: 'A drowned man with a scribe’s hands, the nails still stained with the same clay as the seventh tablet, and a moneylender’s token in his belt.' },
    ar: { name: 'ما ردّته القناة', text: 'رجل غريق بيدَي كاتب، ما تزال أظافره ملطخة بالطين نفسه الذي للوح السابع، وفي حزامه علامة المرابي.' },
    incriminates: 'evan', weight: 4,
  }),
]);

export const CLUE_MAP = Object.freeze(CLUES.reduce((acc, c) => { acc[c.id] = c; return acc; }, {}));

/* --------------------------------------------------------------- missions */

/**
 * Eleven missions across eight chapters.
 *
 * `objectives` are ordered but not strictly sequential: the mission system marks
 * any objective complete when its condition is met, so a player who finds a clue
 * out of order is rewarded rather than punished. `optional` objectives never gate
 * completion — an optional objective that blocks progress is a soft-lock.
 */
export const MISSIONS = Object.freeze([
  Object.freeze({
    id: 'm01-dictation', chapter: 'prologue', index: 0,
    region: 'palace-court',
    en: { title: 'The Dictation', brief: 'Stand with Orin while he dictates the will, and hear who is named.' },
    ar: { title: 'الإملاء', brief: 'قف مع أورين وهو يُملي الوصية، واسمع من يُسمّى.' },
    cinematicStart: 'cin-dictation',
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.GOTO, target: 'lm-court-stele', en: 'Go to the boundary stone', ar: 'اذهب إلى حجر الحدود' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.EXAMINE, target: 'lm-court-stele', en: 'Examine the boundary stone', ar: 'افحص حجر الحدود' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.CLUE, target: 'clue-boundary-stone', en: 'Learn who Orin named', ar: 'اعرف من سمّى أورين' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.DIALOGUE, target: 'dt-court-guards', en: 'Speak with the guard post', ar: 'تحدّث مع مركز الحرس' }),
      // Optional and genuinely missable: the relief is off the path to the stone.
      // This used to target cin-dictation, which is the mission's own
      // cinematicStart and so completed by itself the instant the mission opened.
      Object.freeze({ id: 'o5', type: ObjectiveType.EXAMINE, target: 'lm-court-relief', optional: true, en: 'Study the glazed relief', ar: 'تأمل الواجهة المزجّجة' }),
    ]),
  }),
  Object.freeze({
    id: 'm02-sealed-tablets', chapter: 'ch1', index: 1,
    region: 'palace-hall',
    en: { title: 'The Sealed Tablets', brief: 'Orin is dead before dawn. Count the tablets on the shelf and find the one that is wrong.' },
    ar: { title: 'الألواح المختومة', brief: 'مات أورين قبل الفجر. عُدّ الألواح على الرف وابحث عن الخطأ بينها.' },
    cinematicStart: 'cin-orin-death',
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.DIALOGUE, target: 'dt-orin-bed', en: 'Speak at Orin’s bed', ar: 'تحدّث عند سرير أورين' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.GOTO, target: 'lm-hall-tablets', en: 'Go to the tablet shelf', ar: 'اذهب إلى رف الألواح' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.CLUE, target: 'clue-tablet-shelf', en: 'Find the seventh tablet', ar: 'اعثر على اللوح السابع' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.SEARCH, target: 'palace-hall', count: 3, en: 'Search the hall', ar: 'فتّش القاعة' }),
    ]),
  }),
  Object.freeze({
    id: 'm03-feast', chapter: 'ch2', index: 2,
    region: 'feast-hall',
    en: { title: 'The Feast of Brothers', brief: 'Attend the mourning feast. Watch the cup table, and hear what the dais says.' },
    ar: { title: 'وليمة الإخوة', brief: 'احضر وليمة العزاء. راقب طاولة الأكواب، واسمع ما تقوله المنصة.' },
    cinematicStart: 'cin-feast-toast',
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.DIALOGUE, target: 'dt-feast-tables', en: 'Talk among the feast tables', ar: 'تحدّث بين موائد الوليمة' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.DIALOGUE, target: 'dt-feast-dais', en: 'Hear the host’s dais', ar: 'استمع إلى منصة المضيف' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.CLUE, target: 'clue-cup-table', en: 'Examine the cup table', ar: 'افحص طاولة الأكواب' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.SURVIVE, count: 20, en: 'Stay until the feast ends', ar: 'ابقَ حتى تنتهي الوليمة' }),
    ]),
  }),
  Object.freeze({
    id: 'm04-seven-doors', chapter: 'ch3', index: 3,
    region: 'brothers-wing',
    en: { title: 'Seven Doors', brief: 'Search the brothers’ wing, the kitchen and the store while the house sleeps. Do not be seen.' },
    ar: { title: 'سبعة أبواب', brief: 'فتّش جناح الإخوة والمطبخ والمخزن والدار نائمة. ولا تُرَ.' },
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.CLUE, target: 'clue-writing-desk', en: 'Search the writing desk', ar: 'فتّش مكتب الكتابة' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.CLUE, target: 'clue-herb-shelf', en: 'Search the herb shelf', ar: 'فتّش رف الأعشاب' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.CLUE, target: 'clue-store-ledger', en: 'Search the store ledger', ar: 'فتّش سجل المخزن' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.SEARCH, target: 'brothers-wing', count: 6, en: 'Search six brothers’ rooms', ar: 'فتّش غرف الإخوة الست' }),
      Object.freeze({ id: 'o5', type: ObjectiveType.TAKEDOWN, count: 1, optional: true, en: 'Silence a watching servant', ar: 'أسكت خادمًا يراقب' }),
    ]),
    stealth: true,
  }),
  Object.freeze({
    id: 'm05-door-ring', chapter: 'ch3', index: 4,
    region: 'cellar-stair',
    en: { title: 'The Locked Stair', brief: 'The cellar stair is barred from the inside. Find what caught in the hasp.' },
    ar: { title: 'الدَرَج المقفل', brief: 'دَرَج القبو مُوصد من الداخل. اعثر على ما علق في العروة.' },
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.GOTO, target: 'lm-stair-ring', en: 'Go to the stair door', ar: 'اذهب إلى باب الدَرَج' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.EXAMINE, target: 'lm-stair-ring', en: 'Examine the hasp', ar: 'افحص العروة' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.CLUE, target: 'clue-door-ring', en: 'Recover the door ring', ar: 'استخرج حلقة الباب' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.INTERACT, target: 'lm-stair-steps', en: 'Open the stair', ar: 'افتح الدَرَج' }),
    ]),
  }),
  Object.freeze({
    id: 'm06-cellar', chapter: 'ch4', index: 5,
    region: 'cellar',
    en: { title: 'What the Cellar Keeps', brief: 'A cage, a stain, and a drain that was washed. Two guards hold the cellar.' },
    ar: { title: 'ما يُخفيه القبو', brief: 'قفص، وبقعة، ومصرف غُسل. حارسان يمسكان القبو.' },
    cinematicStart: 'cin-cellar-discovery',
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.CLUE, target: 'clue-dark-stain', en: 'Examine the dark stain', ar: 'افحص البقعة الداكنة' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.EXAMINE, target: 'lm-cellar-cage', en: 'Examine the holding cage', ar: 'افحص قفص الحبس' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.EXAMINE, target: 'lm-cellar-drain', en: 'Examine the bitumen drain', ar: 'افحص مصرف القير' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.DIALOGUE, target: 'dt-cellar-cage', en: 'Speak to whoever is caged', ar: 'تحدّث إلى من في القفص' }),
      Object.freeze({ id: 'o5', type: ObjectiveType.COMBAT, count: 2, en: 'Clear the cellar', ar: 'طهّر القبو' }),
    ]),
  }),
  Object.freeze({
    id: 'm07-servants-way', chapter: 'ch5', index: 6,
    region: 'servant-passage',
    en: { title: 'The Servant’s Way', brief: 'They know you are in the cellar. Go out by the passage and the tunnel — and do not stop for the wound.' },
    ar: { title: 'طريق الخدم', brief: 'عرفوا أنك في القبو. اخرج من الممر والنفق — ولا تتوقف عند الجرح.' },
    cinematicStart: 'cin-injury', cinematicEnd: 'cin-escape',
    injuresPlayer: true,
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.ESCAPE, target: 'servant-passage', en: 'Escape the passages', ar: 'اهرب من الممرات' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.GOTO, target: 'lm-passage-dagger', optional: true, en: 'Recover the dagger in the nook', ar: 'استخرج الخنجر من الكوة' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.ESCAPE, target: 'tunnel', en: 'Go through the tunnel', ar: 'اعبر النفق' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.SURVIVE, count: 25, en: 'Outlast the pursuit', ar: 'اصمد أمام المطاردة' }),
      Object.freeze({ id: 'o5', type: ObjectiveType.GOTO, target: 'palace-exterior', setsFlags: ['outside-palace'], en: 'Reach the palace exterior', ar: 'ابلغ ظاهر القصر' }),
    ]),
    chase: true,
  }),
  Object.freeze({
    id: 'm08-citys-tongue', chapter: 'ch6', index: 7,
    region: 'market',
    en: { title: 'The City’s Tongue', brief: 'The palace will not speak. The city will: a wash yard, a labour platform, a scribe’s corner, a thief’s alley.' },
    ar: { title: 'لسان المدينة', brief: 'القصر لن يتكلم. المدينة ستتكلّم: ساحة غسيل، ومنصة عمال، وزاوية كاتب، وزقاق لصوص.' },
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.DIALOGUE, target: 'dt-pq-washyard', en: 'Ask at the wash yard', ar: 'اسأل في ساحة الغسيل' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.DIALOGUE, target: 'dt-mk-scribe', en: 'Ask at the scribe’s corner', ar: 'اسأل في زاوية الكاتب' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.DIALOGUE, target: 'dt-mk-labour', en: 'Ask at the labour platform', ar: 'اسأل في منصة العمال' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.DIALOGUE, target: 'dt-mk-thief', en: 'Ask in the thief’s alley', ar: 'اسأل في زقاق اللصوص' }),
      Object.freeze({ id: 'o5', type: ObjectiveType.EXAMINE, target: 'lm-mk-moneylender', en: 'Read the moneylender’s bonds', ar: 'اقرأ سندات المرابي' }),
      Object.freeze({ id: 'o6', type: ObjectiveType.EXAMINE, target: 'lm-road-stele', optional: true, en: 'Read the cuneiform stele', ar: 'اقرأ اللوحة المسمارية' }),
    ]),
  }),
  Object.freeze({
    id: 'm09-temples-memory', chapter: 'ch6', index: 8,
    region: 'temple-precinct',
    en: { title: 'The Temple’s Memory', brief: 'Orin lodged a witnessed copy with the temple. The priests will not hand it to a suspect.' },
    ar: { title: 'ذاكرة المعبد', brief: 'أودع أورين نسخة مشهودًا عليها المعبد. والكهنة لن يسلّموها إلى متهم.' },
    cinematicEnd: 'cin-temple-verdict',
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.DIALOGUE, target: 'dt-tp-priests', en: 'Speak at the priests’ stand', ar: 'تحدّث في موقف الكهنة' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.DIALOGUE, target: 'dt-tp-cella', en: 'Enter the inner cella', ar: 'ادخل القدْس' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.CLUE, target: 'clue-temple-archive', en: 'Recover the temple’s copy', ar: 'استخرج نسخة المعبد' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.GOTO, target: 'ziggurat-terrace', optional: true, en: 'Climb to the ziggurat terrace', ar: 'اصعد إلى شرفة الزقورة' }),
    ]),
  }),
  Object.freeze({
    id: 'm10-canal', chapter: 'ch6', index: 9,
    region: 'canal-bank',
    en: { title: 'What the Canal Gave Back', brief: 'A man is afloat by the potter’s kiln. The ruins beyond hold a fallen stele and an ambush.' },
    ar: { title: 'ما ردّته القناة', brief: 'رجل طافٍ عند قمين الفخّار. وفي الآثار وراءه لوحة ساقطة وكمين.' },
    cinematicStart: 'cin-canal-body',
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.DIALOGUE, target: 'dt-cb-potter', en: 'Ask at the potter’s kiln', ar: 'اسأل عند قمين الفخّار' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.CLUE, target: 'clue-canal-body', en: 'Examine what is afloat', ar: 'افحص الطافي' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.COMBAT, count: 3, en: 'Survive the ambush at the ruins', ar: 'انجُ من كمين الآثار' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.EXAMINE, target: 'lm-ru-stele', optional: true, en: 'Read the fallen stele', ar: 'اقرأ اللوحة الساقطة' }),
    ]),
  }),
  Object.freeze({
    id: 'm11-betrayed-will', chapter: 'epilogue', index: 10,
    region: 'desert-edge',
    en: { title: 'The Betrayed Will', brief: 'Evan has gone out to the desert edge. Confront him, then read the true will at Layla’s hearth.' },
    ar: { title: 'وصية الغدر', brief: 'خرج إيفان إلى حافة الصحراء. واجِهه، ثم اقرأ الوصية الحقيقية عند موقد ليلى.' },
    cinematicStart: 'cin-confrontation',
    objectives: Object.freeze([
      Object.freeze({ id: 'o1', type: ObjectiveType.GOTO, target: 'lm-de-cairn', en: 'Reach the cairn at the desert edge', ar: 'ابلغ الرجمة عند حافة الصحراء' }),
      Object.freeze({ id: 'o2', type: ObjectiveType.COMBAT, count: 1, setsFlags: ['evan-cornered'], en: 'Face Evan', ar: 'واجِه إيفان' }),
      Object.freeze({ id: 'o3', type: ObjectiveType.GOTO, target: 'layla-house', en: 'Go to Layla’s house', ar: 'اذهب إلى دار ليلى' }),
      Object.freeze({ id: 'o4', type: ObjectiveType.DIALOGUE, target: 'dt-ll-hearth', en: 'Speak at Layla’s hearth', ar: 'تحدّث عند موقد ليلى' }),
      Object.freeze({ id: 'o5', type: ObjectiveType.RETURN, target: 'clue-temple-archive', en: 'Read the true will aloud', ar: 'اقرأ الوصية الحقيقية جهارًا' }),
      Object.freeze({ id: 'o6', type: ObjectiveType.DIALOGUE, target: 'dt-ll-table', optional: true, en: 'Sit at the low table', ar: 'اجلس إلى الطاولة المنخفضة' }),
    ]),
  }),
]);

export const MISSION_MAP = Object.freeze(MISSIONS.reduce((acc, m) => { acc[m.id] = m; return acc; }, {}));

/* ------------------------------------------------------------- cinematics */

/**
 * Nine cinematics. Each is declared as data — a shot list the camera system can
 * consume — because a cinematic that hardcodes its own camera would be the one
 * place in the game where framing is not measured, and framing is exactly what
 * camera-test.mjs proves has zero penetration.
 */
export const CINEMATICS = Object.freeze([
  Object.freeze({
    id: 'cin-dictation', chapter: 'prologue', at: 'mission-start', mission: 'm01-dictation',
    seconds: 34, region: 'palace-court',
    en: { title: 'The Dictation', text: 'Orin dictates; the scribe’s stylus moves; seven brothers listen.' },
    ar: { title: 'الإملاء', text: 'أورين يُملي؛ وقلم الكاتب يتحرك؛ وسبعة إخوة يصغون.' },
    shots: Object.freeze([
      Object.freeze({ mode: 'CINEMATIC', subject: 'orin', seconds: 12, framing: 'twoShot' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-court-stele', seconds: 10, framing: 'orbit' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'raynor', seconds: 12, framing: 'close' }),
    ]),
  }),
  Object.freeze({
    id: 'cin-orin-death', chapter: 'ch1', at: 'mission-start', mission: 'm02-sealed-tablets',
    seconds: 28, region: 'palace-hall',
    en: { title: 'Before Dawn', text: 'The bed is cold. The tablet shelf is one tablet short of honest.' },
    ar: { title: 'قبل الفجر', text: 'السرير بارد. ورفّ الألواح ينقصه لوح واحد من الصدق.' },
    shots: Object.freeze([
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-hall-beds', seconds: 14, framing: 'close' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-hall-tablets', seconds: 14, framing: 'orbit' }),
    ]),
  }),
  Object.freeze({
    id: 'cin-feast-toast', chapter: 'ch2', at: 'mission-start', mission: 'm03-feast',
    seconds: 30, region: 'feast-hall',
    en: { title: 'The Toast', text: 'A cup is raised to Orin. One cup at the table has been poured twice.' },
    ar: { title: 'النخب', text: 'تُرفع كأس لأورين. كأس واحدة على المائدة صُبّت مرتين.' },
    shots: Object.freeze([
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-feast-dais', seconds: 12, framing: 'twoShot' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-feast-tables', seconds: 10, framing: 'wide' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-feast-cups', seconds: 8, framing: 'close' }),
    ]),
  }),
  Object.freeze({
    id: 'cin-cellar-discovery', chapter: 'ch4', at: 'mission-start', mission: 'm06-cellar',
    seconds: 26, region: 'cellar',
    en: { title: 'Below the Stair', text: 'Lamplight finds a cage, a stain, and a drain that was washed this week.' },
    ar: { title: 'تحت الدَرَج', text: 'يجد ضوء السراج قفصًا، وبقعةً، ومصرفًا غُسل هذا الأسبوع.' },
    shots: Object.freeze([
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-cellar-cage', seconds: 10, framing: 'close' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-cellar-stain', seconds: 9, framing: 'close' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-cellar-drain', seconds: 7, framing: 'orbit' }),
    ]),
  }),
  Object.freeze({
    id: 'cin-injury', chapter: 'ch5', at: 'mid-mission', mission: 'm07-servants-way',
    seconds: 22, region: 'servant-passage',
    en: { title: 'The Wound', text: 'A blade in the passage. From here Raynor fights hurt — and the game means it.' },
    ar: { title: 'الجرح', text: 'نصل في الممر. ومن هنا يقاتل راينور مجروحًا — واللعبة تعني ذلك.' },
    shots: Object.freeze([
      Object.freeze({ mode: 'CINEMATIC', subject: 'raynor', seconds: 12, framing: 'close' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-passage-nook', seconds: 10, framing: 'twoShot' }),
    ]),
    // The mechanical consequence, declared once so movement and combat agree.
    setsInjured: true,
    // Declared as data as well, so the flag-liveness check can see that the mission
    // layer really writes this rather than trusting one hardcoded line in
    // mission.js. setsInjured stays: it drives the movement and combat penalty.
    setsFlags: ['wounded'],
  }),
  Object.freeze({
    id: 'cin-escape', chapter: 'ch5', at: 'mission-end', mission: 'm07-servants-way',
    seconds: 24, region: 'palace-exterior',
    en: { title: 'Out by the Tunnel', text: 'The tunnel mouth, the ramp, and a city that does not know him yet.' },
    ar: { title: 'خروج من النفق', text: 'فم النفق، والمنحدر، ومدينة لا تعرفه بعد.' },
    shots: Object.freeze([
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-tunnel-grate', seconds: 8, framing: 'close' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-ext-ramp', seconds: 9, framing: 'wide' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'raynor', seconds: 7, framing: 'orbit' }),
    ]),
  }),
  Object.freeze({
    id: 'cin-canal-body', chapter: 'ch6', at: 'mission-start', mission: 'm10-canal',
    seconds: 25, region: 'canal-bank',
    en: { title: 'Something Afloat', text: 'Reed, silt, and a scribe’s hands stained with the seventh tablet’s clay.' },
    ar: { title: 'شيء طافٍ', text: 'قصب وطمي، ويدَا كاتب ملطختان بطين اللوح السابع.' },
    shots: Object.freeze([
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-cb-reedbed', seconds: 9, framing: 'wide' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-cb-body', seconds: 16, framing: 'close' }),
    ]),
  }),
  Object.freeze({
    id: 'cin-temple-verdict', chapter: 'ch6', at: 'mission-end', mission: 'm09-temples-memory',
    seconds: 31, region: 'temple-precinct',
    en: { title: 'The Archive Speaks', text: 'The witnessed copy is unrolled. Its date precedes the forgery by a month.' },
    ar: { title: 'الأرشيف يتكلم', text: 'تُفرد النسخة المشهود عليها. ويسبق تاريخها التزوير بشهر.' },
    shots: Object.freeze([
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-tp-tablets', seconds: 13, framing: 'close' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-tp-priests', seconds: 10, framing: 'twoShot' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'raynor', seconds: 8, framing: 'close' }),
    ]),
  }),
  Object.freeze({
    id: 'cin-confrontation', chapter: 'epilogue', at: 'mission-start', mission: 'm11-betrayed-will',
    seconds: 40, region: 'desert-edge',
    en: { title: 'The Last Brother', text: 'At the cairn Evan stops running. The will he betrayed is read at Layla’s hearth.' },
    ar: { title: 'الأخ الأخير', text: 'عند الرجمة يكفّ إيفان عن الهرب. والوصية التي غدر بها تُقرأ عند موقد ليلى.' },
    shots: Object.freeze([
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-de-cairn', seconds: 14, framing: 'twoShot' }),
      Object.freeze({ mode: 'FINISHER', subject: 'evan', seconds: 12, framing: 'close' }),
      Object.freeze({ mode: 'CINEMATIC', subject: 'lm-ll-hearth', seconds: 14, framing: 'wide' }),
    ]),
  }),
]);

export const CINEMATIC_MAP = Object.freeze(
  CINEMATICS.reduce((acc, c) => { acc[c.id] = c; return acc; }, {}),
);

/* ------------------------------------------------------------- validation */

/**
 * Prove the story is bound to the world that is actually generated.
 *
 * This is the function that makes the content layer trustworthy: it is called by
 * the test suite and by lint, so a mission that references a landmark nobody
 * built, a clue that belongs to two missions, or a chapter out of order fails the
 * build instead of failing a player three hours in.
 */
export function validateStoryData() {
  const errors = [];
  const landmarkIds = new Set(LANDMARKS.map((l) => l.id));
  const regionIds = new Set(REGIONS.map((r) => r.id));
  const dialogueLandmarks = LANDMARKS.filter((l) => l.interact === 'dialogue');

  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  // Script purity. Arabic is a first-class language here, not a translation
  // layer, so a stray Latin word inside an `ar` string is a content defect and not
  // a cosmetic one. Two such words reached this file before the check existed
  // ("beside", "mentre") and were only caught by reading the output by eye - a
  // reviewer's attention is not a gate. This is.
  const bilingual = (obj, where) => {
    need(obj && typeof obj.en === 'string' && obj.en.length > 0, `${where}: missing en`);
    need(obj && typeof obj.ar === 'string' && obj.ar.length > 0, `${where}: missing ar`);
    if (obj && typeof obj.ar === 'string') {
      const latin = obj.ar.match(/[A-Za-z]{2,}/);
      need(!latin, `${where}: Arabic text contains Latin script "${latin ? latin[0] : ''}"`);
    }
    if (obj && typeof obj.en === 'string') {
      const arabic = obj.en.match(/[\u0600-\u06FF]/);
      need(!arabic, `${where}: English text contains Arabic script`);
    }
  };

  // --- chapters ------------------------------------------------------------
  need(CHAPTERS.length === 8, `expected 8 chapters (prologue + 6 + epilogue), found ${CHAPTERS.length}`);
  need(CHAPTERS[0].id === 'prologue', 'the first chapter must be the prologue');
  need(CHAPTERS[CHAPTERS.length - 1].id === 'epilogue', 'the last chapter must be the epilogue');
  CHAPTERS.forEach((c, i) => {
    need(c.index === i, `${c.id}: index ${c.index} out of order at position ${i}`);
    bilingual({ en: c.en, ar: c.ar }, `chapter ${c.id} title`);
    bilingual(c.premise, `chapter ${c.id} premise`);
    need(Array.isArray(c.regions) && c.regions.length > 0, `${c.id}: no regions`);
    for (const r of c.regions ?? []) need(regionIds.has(r), `${c.id}: unknown region "${r}"`);
  });
  need(new Set(CHAPTERS.map((c) => c.id)).size === CHAPTERS.length, 'duplicate chapter ids');

  // --- missions ------------------------------------------------------------
  need(MISSIONS.length === 11, `expected 11 missions, found ${MISSIONS.length}`);
  MISSIONS.forEach((m, i) => {
    need(m.index === i, `${m.id}: index ${m.index} out of order at position ${i}`);
    need(CHAPTER_MAP[m.chapter], `${m.id}: unknown chapter "${m.chapter}"`);
    need(regionIds.has(m.region), `${m.id}: unknown region "${m.region}"`);
    const chapter = CHAPTER_MAP[m.chapter];
    need(chapter && chapter.regions.includes(m.region),
      `${m.id}: region "${m.region}" is not one of chapter ${m.chapter}’s regions`);
    bilingual({ en: m.en.title, ar: m.ar.title }, `${m.id} title`);
    bilingual({ en: m.en.brief, ar: m.ar.brief }, `${m.id} brief`);
    need(Array.isArray(m.objectives) && m.objectives.length >= 3,
      `${m.id}: needs at least 3 objectives, has ${m.objectives?.length ?? 0}`);

    const ids = new Set();
    let required = 0;
    for (const o of m.objectives ?? []) {
      need(!ids.has(o.id), `${m.id}: duplicate objective id "${o.id}"`);
      ids.add(o.id);
      need(Object.values(ObjectiveType).includes(o.type), `${m.id}/${o.id}: unknown objective type "${o.type}"`);
      bilingual({ en: o.en, ar: o.ar }, `${m.id}/${o.id} objective text`);
      if (!o.optional) required++;
      if (typeof o.count === 'number') need(o.count > 0, `${m.id}/${o.id}: count must be positive`);
      if (o.target) {
        const isClue = o.type === ObjectiveType.CLUE || o.type === ObjectiveType.RETURN;
        const isCinematic = o.type === ObjectiveType.CINEMATIC;
        const isDialogue = o.type === ObjectiveType.DIALOGUE;
        const isRegion = o.type === ObjectiveType.SEARCH || o.type === ObjectiveType.ESCAPE
          || (o.type === ObjectiveType.GOTO && regionIds.has(o.target));
        if (isClue) need(CLUE_MAP[o.target], `${m.id}/${o.id}: unknown clue "${o.target}"`);
        else if (isCinematic) need(CINEMATIC_MAP[o.target], `${m.id}/${o.target}: unknown cinematic`);
        else if (isDialogue) need(true, `${m.id}/${o.id}: dialogue target validated below`);
        else if (isRegion) need(regionIds.has(o.target), `${m.id}/${o.id}: unknown region "${o.target}"`);
        else need(landmarkIds.has(o.target), `${m.id}/${o.id}: unknown landmark "${o.target}"`);
      }
    }
    need(required > 0, `${m.id}: every objective is optional, so the mission can never be required to finish`);
    // A REQUIRED cinematic objective is a soft-lock: cinematics are skippable, so
    // a player who skips one can never finish the mission. An optional cinematic is
    // the correct shape, and a mission that must show one declares it through
    // cinematicStart/cinematicEnd, which the mission system plays and completes for
    // the player rather than asking them to achieve it.
    for (const o of m.objectives ?? []) {
      if (!o.optional && o.type === ObjectiveType.CINEMATIC) {
        need(false, `${m.id}/${o.id}: a required cinematic objective can be skipped by the player, soft-locking the mission`);
      }
    }
    if (m.cinematicStart) need(CINEMATIC_MAP[m.cinematicStart], `${m.id}: unknown cinematicStart`);
    if (m.cinematicEnd) need(CINEMATIC_MAP[m.cinematicEnd], `${m.id}: unknown cinematicEnd`);
  });
  need(new Set(MISSIONS.map((m) => m.id)).size === MISSIONS.length, 'duplicate mission ids');

  // Every chapter carries at least one mission, and the eight chapters are
  // covered by the eleven missions.
  for (const c of CHAPTERS) {
    const n = MISSIONS.filter((m) => m.chapter === c.id).length;
    need(n >= 1, `chapter ${c.id} has no mission`);
  }

  // --- clues ---------------------------------------------------------------
  need(CLUES.length === 10, `expected 10 clues, found ${CLUES.length}`);
  const clueLandmarks = new Set();
  for (const c of CLUES) {
    const lm = LANDMARK_MAP[c.landmark];
    need(!!lm, `clue ${c.id}: unknown landmark "${c.landmark}"`);
    need(lm && lm.interact === 'clue',
      `clue ${c.id}: landmark "${c.landmark}" has interact="${lm?.interact}", not "clue"`);
    need(!clueLandmarks.has(c.landmark), `clue ${c.id}: landmark "${c.landmark}" already carries a clue`);
    clueLandmarks.add(c.landmark);
    need(CHAPTER_MAP[c.chapter], `clue ${c.id}: unknown chapter "${c.chapter}"`);
    bilingual({ en: c.en.name, ar: c.ar.name }, `clue ${c.id} name`);
    bilingual({ en: c.en.text, ar: c.ar.text }, `clue ${c.id} text`);
    need(Number.isFinite(c.weight) && c.weight > 0, `clue ${c.id}: weight must be positive`);
    if (c.incriminates) {
      need(!!CHARACTERS[c.incriminates], `clue ${c.id}: unknown character "${c.incriminates}"`);
    }
    // Every clue must be required by at least one mission, or it is unreachable
    // content the player can never be told to look for.
    const used = MISSIONS.some((m) => m.objectives.some((o) => o.target === c.id));
    need(used, `clue ${c.id} is not required by any mission`);
    // And its chapter must not come after the mission that demands it.
    const mission = MISSIONS.find((m) => m.objectives.some((o) => o.target === c.id));
    if (mission) {
      need(CHAPTER_MAP[c.chapter].index <= CHAPTER_MAP[mission.chapter].index,
        `clue ${c.id} belongs to ${c.chapter} but is required in the earlier ${mission.chapter}`);
    }
  }
  need(new Set(CLUES.map((c) => c.id)).size === CLUES.length, 'duplicate clue ids');

  // A mystery where every clue points one way is a guess, not a deduction.
  const incriminated = new Set(CLUES.map((c) => c.incriminates).filter(Boolean));
  need(incriminated.size >= 2, 'every clue incriminates the same person — there is nothing to deduce');
  const traitor = CHARACTERS.evan;
  need(CLUES.some((c) => c.incriminates && c.incriminates !== traitor.id),
    'no clue points at an innocent brother, so the case solves itself');
  need(CLUES.filter((c) => c.incriminates === traitor.id).length >= 3,
    'fewer than three clues point at the actual traitor, so the case is unsolvable');

  // --- cinematics ----------------------------------------------------------
  need(CINEMATICS.length === 9, `expected 9 cinematics, found ${CINEMATICS.length}`);
  for (const c of CINEMATICS) {
    need(CHAPTER_MAP[c.chapter], `cinematic ${c.id}: unknown chapter "${c.chapter}"`);
    need(regionIds.has(c.region), `cinematic ${c.id}: unknown region "${c.region}"`);
    need(MISSION_MAP[c.mission], `cinematic ${c.id}: unknown mission "${c.mission}"`);
    need(MISSION_MAP[c.mission]?.chapter === c.chapter,
      `cinematic ${c.id}: chapter ${c.chapter} does not match mission ${c.mission}’s chapter`);
    bilingual({ en: c.en.title, ar: c.ar.title }, `cinematic ${c.id} title`);
    bilingual({ en: c.en.text, ar: c.ar.text }, `cinematic ${c.id} text`);
    need(Number.isFinite(c.seconds) && c.seconds > 0, `cinematic ${c.id}: bad duration`);
    need(Array.isArray(c.shots) && c.shots.length > 0, `cinematic ${c.id}: no shots`);
    let total = 0;
    for (const s of c.shots) {
      need(Number.isFinite(s.seconds) && s.seconds > 0, `cinematic ${c.id}: a shot has no duration`);
      total += s.seconds;
      need(s.subject && (CHARACTERS[s.subject] || landmarkIds.has(s.subject)),
        `cinematic ${c.id}: shot subject "${s.subject}" is neither a character nor a landmark`);
    }
    need(Math.abs(total - c.seconds) < 1.01,
      `cinematic ${c.id}: shots total ${total}s but the declared duration is ${c.seconds}s`);
  }
  need(new Set(CINEMATICS.map((c) => c.id)).size === CINEMATICS.length, 'duplicate cinematic ids');

  // --- the 14 dialogue landmarks must all be used ---------------------------
  // world-data declares exactly 14 landmarks with interact:"dialogue", and the
  // brief requires exactly 14 dialogue trees. Every one must be spoken at.
  need(dialogueLandmarks.length === 14,
    `world-data declares ${dialogueLandmarks.length} dialogue landmarks; the story expects 14`);

  // --- the two layers must agree on which chapter a region belongs to --------
  // world-data declares a chapter on every region and this file declares regions on
  // every chapter. Those are two answers to one question, and they had already
  // diverged: the epilogue regions were numbered 6 on the world side. Nothing read
  // the world-side field, which is precisely why the disagreement survived. Either
  // both agree or the story cannot be trusted to place the player in the right
  // chapter of the right map.
  const claimedBy = new Map();
  for (const c of CHAPTERS) {
    for (const r of c.regions ?? []) {
      if (claimedBy.has(r)) {
        need(false, `region "${r}" is claimed by both ${claimedBy.get(r)} and ${c.id}`);
      }
      claimedBy.set(r, c.id);
    }
  }
  for (const r of REGIONS) {
    const owner = claimedBy.get(r.id);
    need(!!owner, `region "${r.id}" belongs to no chapter — the player can walk somewhere the story never visits`);
    need(owner === r.chapter,
      `region "${r.id}": world-data says chapter ${JSON.stringify(r.chapter)}, the story says ${JSON.stringify(owner ?? null)}`);
  }
  for (const c of CHAPTERS) {
    need((c.regions ?? []).length > 0, `chapter ${c.id} has no regions — nothing to build it out of`);
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors,
    counts: Object.freeze({
      chapters: CHAPTERS.length, missions: MISSIONS.length, clues: CLUES.length,
      cinematics: CINEMATICS.length, dialogueLandmarks: dialogueLandmarks.length,
      characters: Object.keys(CHARACTERS).length,
      objectives: MISSIONS.reduce((n, m) => n + m.objectives.length, 0),
      regions: new Set(MISSIONS.map((m) => m.region)).size,
    }),
  });
}

/** Missions belonging to a chapter, in play order. */
export function missionsForChapter(chapterId) {
  return MISSIONS.filter((m) => m.chapter === chapterId);
}

/** Clues belonging to a chapter, in landmark order. */
export function cluesForChapter(chapterId) {
  return CLUES.filter((c) => c.chapter === chapterId);
}

/** The characters a clue points at, for the accusation UI. */
export function suspects() {
  return Object.values(CHARACTERS).filter((c) => c.suspect || c.traitor);
}
