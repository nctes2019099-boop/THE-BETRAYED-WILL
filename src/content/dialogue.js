/**
 * THE BETRAYED WILL — dialogue.js
 *
 * The fourteen dialogue trees.
 *
 * Each tree is bound to one of the fourteen landmarks in world-data.js that carry
 * `interact:"dialogue"`, and to the mission objective that sends the player to it.
 * Both bindings are proven by `validateDialogueData()`, so a mission cannot ask the
 * player to speak at a corner of the market nobody built, and no built dialogue
 * landmark can be left unreachable.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 * A tree is a node map with a declared `entry`. A node carries lines, and then
 * either `choices` (a branch the player picks) or `next` (a linear advance) or
 * neither (a terminal node). Choices may carry `requires` — clues or flags the
 * player must hold — and `effects` — flags to set, clues to grant, suspicion to
 * move. Conditions are data, not code: the walker in src/sim/dialogue.js
 * interprets them, so a content author cannot write a branch the save system does
 * not understand, and a branch that can never be taken is caught here rather than
 * discovered by a player who has run out of things to do.
 *
 * ── Language ─────────────────────────────────────────────────────────────────
 * Every line and every choice is authored in Arabic and English together, and
 * `validateDialogueData()` rejects Latin script inside an `ar` string and Arabic
 * script inside an `en` string. Arabic is a first-class language in this game, not
 * a translation bolted on at the end, so the check is on the content and not on a
 * reviewer's attention.
 */

import { CHARACTERS, CINEMATICS, CLUE_MAP, MISSIONS, CHAPTER_MAP } from './story.js';
import { LANDMARKS, LANDMARK_MAP } from './world-data.js';

/* ------------------------------------------------------------ minor roles */

/**
 * Speakers who are not named characters.
 *
 * Declared rather than invented at the point of use, so the validator can prove
 * every speaker resolves to something. A dialogue line attributed to a typo shows
 * up in the UI as an empty name plate.
 */
export const MINOR_ROLES = Object.freeze({
  guard: Object.freeze({ id: 'guard', en: 'Palace Guard', ar: 'حارس القصر' }),
  cook: Object.freeze({ id: 'cook', en: 'The Cook', ar: 'الطاهية' }),
  prisoner: Object.freeze({ id: 'prisoner', en: 'The Caged Man', ar: 'الرجل المقفوص' }),
  washerwoman: Object.freeze({ id: 'washerwoman', en: 'Washerwoman', ar: 'الغسّالة' }),
  labourer: Object.freeze({ id: 'labourer', en: 'Labour Foreman', ar: 'رئيس العمّال' }),
  apprentice: Object.freeze({ id: 'apprentice', en: 'Scribe’s Apprentice', ar: 'تلميذ الكاتب' }),
  thief: Object.freeze({ id: 'thief', en: 'Alley Man', ar: 'رجل الزقاق' }),
  potter: Object.freeze({ id: 'potter', en: 'The Potter', ar: 'الفخّاري' }),
  crowd: Object.freeze({ id: 'crowd', en: 'The Hall', ar: 'القاعة' }),
});

export function speakerOf(id) {
  return CHARACTERS[id] ?? MINOR_ROLES[id] ?? null;
}

/* ------------------------------------------------------------------- flags */

/**
 * The closed vocabulary of story flags.
 *
 * Closed on purpose. A flag invented in a dialogue effect but never read anywhere
 * is dead content; a flag read by a condition but never set is a branch that can
 * never be taken, which is a soft-lock with extra steps. `validateDialogueData()`
 * checks both directions.
 */
export const Flags = Object.freeze({
  HEARD_DICTATION: 'heard-dictation',
  KNOWS_SEVENTH_TABLET: 'knows-seventh-tablet',
  SAW_CUP_RINSED: 'saw-cup-rinsed',
  KNOWS_PRACTISED_SEAL: 'knows-practised-seal',
  KNOWS_BITUMEN_DRAWN: 'knows-bitumen-drawn',
  RING_MATCHES_EVAN: 'ring-matches-evan',
  CAGE_MAN_SPOKE: 'cage-man-spoke',
  WOUNDED: 'wounded',
  OUTSIDE_PALACE: 'outside-palace',
  WASHYARD_TOLD: 'washyard-told',
  FOREMAN_PAID: 'foreman-paid',
  APPRENTICE_CONFESSED: 'apprentice-confessed',
  THIEF_SAW_DROWNING: 'thief-saw-drowning',
  PRIESTS_REFUSED: 'priests-refused',
  TEMPLE_WITNESS: 'temple-witness',
  POTTER_MARKED_HANDS: 'potter-marked-hands',
  LAYLA_TRUSTS: 'layla-trusts',
  EVAN_CORNERED: 'evan-cornered',
  WILL_READ_ALOUD: 'will-read-aloud',
});

/**
 * Flags the MISSION system writes, never dialogue.
 *
 * One writer per flag. `evan-cornered` is set when the accusation objective
 * completes, not by a line of conversation, and a validator that can only see the
 * dialogue layer would otherwise report it as a branch nothing ever unlocks -
 * which is true of the layer it is looking at and false of the game. Declaring the
 * boundary fixes that report and also forbids the far worse case: the same flag
 * written from both layers, where the question "who set this?" has no answer.
 */
export const MISSION_OWNED_FLAGS = Object.freeze(new Set([
  Flags.EVAN_CORNERED,
  Flags.OUTSIDE_PALACE,
  Flags.WOUNDED,
]));

/* ------------------------------------------------------------ the 14 trees */

const L = (en, ar) => Object.freeze({ en, ar });

export const DIALOGUE_TREES = Object.freeze([
  /* 1 — prologue: the guard post in the courtyard */
  Object.freeze({
    id: 'dt-court-guards', landmark: 'lm-court-guards', chapter: 'prologue',
    mission: 'm01-dictation', speaker: 'guard', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'guard',
        lines: Object.freeze([L('The lord dictates inside. We are told to let no one leave the court.',
          'السيد يُملي في الداخل. وأُمرنا ألا ندع أحدًا يخرج من الفناء.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('Who gave that order?', 'من أعطى هذا الأمر؟'), next: 'order' }),
          Object.freeze({ text: L('Did anyone come to the stone today?', 'هل جاء أحد إلى الحجر اليوم؟'), next: 'stone' }),
          Object.freeze({ text: L('Leave him to his post.', 'اتركه في مركزه.'), next: 'end_polite' }),
        ]),
      }),
      order: Object.freeze({
        speaker: 'guard',
        lines: Object.freeze([L('The youngest. Evan. He said it was his father’s wish.',
          'الأصغر. إيفان. قال إنها رغبة أبيه.')]),
        effects: Object.freeze({ flags: [Flags.HEARD_DICTATION] }),
        next: 'open',
      }),
      stone: Object.freeze({
        speaker: 'guard',
        lines: Object.freeze([L('The scribe went to the boundary stone twice. Twice is once too often for one text.',
          'ذهب الكاتب إلى حجر الحدود مرتين. ومرتان زيادة على النصّ الواحد.')]),
        next: 'open',
      }),
      end_polite: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('Stay at your post. If anyone asks, I was never here.',
          'ابقَ في مركزك. وإن سأل أحد، فلم أكن هنا أبدًا.')]),
        end: true,
      }),
    }),
  }),

  /* 2 — chapter 1: Orin's bed */
  Object.freeze({
    id: 'dt-orin-bed', landmark: 'lm-hall-beds', chapter: 'ch1',
    mission: 'm02-sealed-tablets', speaker: 'layla', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'layla',
        lines: Object.freeze([L('He was warm at midnight. He was cold before the lamp burned down.',
          'كان دافئًا عند منتصف الليل. وصار باردًا قبل أن ينطفئ السراج.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('Who sat with him?', 'من جلس معه؟'), next: 'who' }),
          Object.freeze({ text: L('Did he speak of the will?', 'هل تحدّث عن الوصية؟'), next: 'will' }),
          Object.freeze({ text: L('Show me the shelf.', 'أرني الرفّ.'), next: 'shelf' }),
        ]),
      }),
      who: Object.freeze({
        speaker: 'layla',
        lines: Object.freeze([L('Evan, for a while. He said he would watch so the rest of us could sleep.',
          'إيفان، لبعض الوقت. قال إنه سيسهر لننام نحن الباقون.')]),
        next: 'open',
      }),
      will: Object.freeze({
        speaker: 'layla',
        lines: Object.freeze([L('He dictated it in the courtyard, in front of witnesses. He was proud of it. He did not hide it.',
          'أملاها في الفناء أمام الشهود. كان فخورًا بها. ولم يُخفها.')]),
        effects: Object.freeze({ flags: [Flags.HEARD_DICTATION] }),
        next: 'open',
      }),
      shelf: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('Seven tablets. He dictated six.',
          'سبعة ألواح. وهو قد أملى ستة.')]),
        effects: Object.freeze({ flags: [Flags.KNOWS_SEVENTH_TABLET] }),
        end: true,
      }),
    }),
  }),

  /* 3 — chapter 2: among the feast tables */
  Object.freeze({
    id: 'dt-feast-tables', landmark: 'lm-feast-tables', chapter: 'ch2',
    mission: 'm03-feast', speaker: 'novan', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'novan',
        lines: Object.freeze([L('Eat. Everyone is watching who eats and who does not.',
          'كُل. الجميع يراقب من يأكل ومن لا يأكل.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('You argued with him the week he died.', 'خاصمته في الأسبوع الذي مات فيه.'), next: 'quarrel' }),
          Object.freeze({ text: L('Where were you when the cups were poured?', 'أين كنت حين صُبّت الأكواب؟'), next: 'cups' }),
          Object.freeze({ text: L('Say nothing more.', 'لا تقل شيئًا بعد.'), next: 'end_quiet' }),
        ]),
      }),
      quarrel: Object.freeze({
        speaker: 'novan',
        lines: Object.freeze([L('I argued in the open, in daylight, with six people listening. A man who means to kill does not advertise.',
          'خاصمت علنًا، في وضح النهار، وستة أشخاص يصغون. من ينوي القتل لا يُعلن عن نفسه.')]),
        next: 'open',
      }),
      cups: Object.freeze({
        speaker: 'novan',
        lines: Object.freeze([L('Kyle sat nearest the cup table. He poured for our father himself. Ask him whether he rinsed it first.',
          'كايل جلس الأقرب إلى طاولة الأكواب. هو صبّ لأبينا بنفسه. اسأله إن كان شطفها أولًا.')]),
        effects: Object.freeze({ flags: [Flags.SAW_CUP_RINSED] }),
        next: 'open',
      }),
      end_quiet: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('I will eat. And I will watch.', 'سآكل. وسأراقب.')]),
        end: true,
      }),
    }),
  }),

  /* 4 — chapter 2: the host's dais */
  Object.freeze({
    id: 'dt-feast-dais', landmark: 'lm-feast-dais', chapter: 'ch2',
    mission: 'm03-feast', speaker: 'evan', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'evan',
        lines: Object.freeze([L('You are the one the stone names. That must be hard to carry tonight.',
          'أنت من سمّاه الحجر. لا بدّ أن حمل ذلك ثقيل هذه الليلة.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('The stone names me. The tablets do not.', 'الحجر يسمّيني. والألواح لا تفعل.'), next: 'tablets' }),
          Object.freeze({ text: L('You watched him die instead of sleeping.', 'سهرت على موته بدل أن تنام.'), next: 'watch' }),
          Object.freeze({ text: L('Raise the cup with the rest.', 'ارفع الكأس مع الباقين.'), next: 'end_cup' }),
        ]),
      }),
      tablets: Object.freeze({
        speaker: 'evan',
        lines: Object.freeze([L('Tablets are made by men. Stones are made by weather. I would trust the tablet.',
          'الألواح يصنعها الرجال. والحجارة يصنعها الطقس. أنا أثق باللوح.')]),
        next: 'open',
      }),
      watch: Object.freeze({
        speaker: 'evan',
        lines: Object.freeze([L('Someone had to. Novan would have made it about himself and Zafir would have slept through it.',
          'كان لا بدّ من أحد. نوفان كان سيجعل الأمر عن نفسه، وزافر كان سينام عنه.')]),
        next: 'open',
      }),
      end_cup: Object.freeze({
        speaker: 'crowd',
        lines: Object.freeze([L('To Orin. Seven sons, one house, one will.',
          'إلى أورين. سبعة أبناء، ودار واحدة، ووصية واحدة.')]),
        end: true,
      }),
    }),
  }),

  /* 5 — chapter 4: the holding cage */
  Object.freeze({
    id: 'dt-cellar-cage', landmark: 'lm-cellar-cage', chapter: 'ch4',
    mission: 'm06-cellar', speaker: 'prisoner', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'prisoner',
        lines: Object.freeze([L('You are not one of them. One of them would not have come down the stair without a lamp.',
          'لست منهم. أحدهم ما كان لينزل الدَرَج بلا مصباح.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('Why are you caged?', 'لماذا أنت في القفص؟'), next: 'why' }),
          Object.freeze({ text: L('Who put you here?', 'من وضعك هنا؟'), next: 'who' }),
          Object.freeze({
            text: L('Show him the ring from the hasp.', 'أره الحلقة من العروة.'),
            next: 'ring', requires: Object.freeze({ clues: ['clue-door-ring'] }),
          }),
          // Ungated exit. Without this the only way out of the scene was the ring
          // branch, which needs a clue the player may not have found yet — and a
          // conversation with no available exit is a hang, not a missed line.
          Object.freeze({ text: L('Step back from the cage.', 'ابتعد عن القفص.'), next: 'end_back' }),
        ]),
      }),
      why: Object.freeze({
        speaker: 'prisoner',
        lines: Object.freeze([L('I carry water up from the canal. Three nights ago I carried a body instead, and they decided I had seen it.',
          'أحمل الماء من القناة. قبل ثلاث ليال حملت جسدًا بدل الماء، فقرروا أنني قد رأيته.')]),
        next: 'open',
      }),
      who: Object.freeze({
        speaker: 'prisoner',
        lines: Object.freeze([L('The youngest. He has soft hands for a man who locks a cage.',
          'الأصغر. يداه ناعمتان لرجل يُقفل قفصًا.')]),
        next: 'open',
      }),
      ring: Object.freeze({
        speaker: 'prisoner',
        lines: Object.freeze([L('He wore that. He pulled at the hasp with it and it snapped, and he cursed like a boy who has lost a toy.',
          'كان يلبسها. جذب العروة بها فانكسرت، وسبّ كصبيّ أضاع لعبته.')]),
        effects: Object.freeze({ flags: [Flags.RING_MATCHES_EVAN, Flags.CAGE_MAN_SPOKE] }),
        end: true,
      }),
      end_back: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('I will come back with the ring. Until then, stay quiet.',
          'سأعود ومعي الحلقة. حتى ذلك الحين، ابقَ صامتًا.')]),
        end: true,
      }),
    }),
  }),

  /* 6 — chapter 6: the wash yard */
  Object.freeze({
    id: 'dt-pq-washyard', landmark: 'lm-pq-washyard', chapter: 'ch6',
    mission: 'm08-citys-tongue', speaker: 'washerwoman', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'washerwoman',
        lines: Object.freeze([L('Palace linen, once a week. That night they sent down three loads, and one of them was still wet with something that was not water.',
          'كتان القصر، مرة في الأسبوع. تلك الليلة أرسلوا ثلاث حِمل، وأحدها كان ما يزال مبللًا بشيء ليس ماءً.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('Who brought the loads?', 'من جاء بالأحمال؟'), next: 'who' }),
          Object.freeze({ text: L('What colour was it?', 'ما لونه؟'), next: 'colour' }),
          Object.freeze({ text: L('Thank her and go.', 'اشكرها وامضِ.'), next: 'end_go' }),
        ]),
      }),
      who: Object.freeze({
        speaker: 'washerwoman',
        lines: Object.freeze([L('A servant, and a young lord holding a lamp so the servant could see. The young lord did not want his name on the yard book.',
          'خادم، وسيد شاب يحمل مصباحًا ليرى الخادم. السيد الشاب لم يرد اسمه في دفتر الساحة.')]),
        effects: Object.freeze({ flags: [Flags.WASHYARD_TOLD] }),
        next: 'open',
      }),
      colour: Object.freeze({
        speaker: 'washerwoman',
        lines: Object.freeze([L('Dark. It went brown in the tub and it did not rinse out of the weave. I have washed for forty years. I know what that was.',
          'داكن. صار بنيًّا في الحوض ولم يخرج من النسيج. أنا أغسل منذ أربعين سنة. أعرف ما كان.')]),
        next: 'open',
      }),
      end_go: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('Say nothing of this to the yard book.', 'لا تقولي شيئًا عن هذا في دفتر الساحة.')]),
        end: true,
      }),
    }),
  }),

  /* 7 — chapter 6: the labour platform */
  Object.freeze({
    id: 'dt-mk-labour', landmark: 'lm-mk-slave', chapter: 'ch6',
    mission: 'm08-citys-tongue', speaker: 'labourer', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'labourer',
        lines: Object.freeze([L('Work is bought here, and so is silence. Which of the two are you buying?',
          'هنا يُشترى العمل، ويُشترى الصمت. أيّهما تشتري؟')]),
        choices: Object.freeze([
          Object.freeze({ text: L('I want the scribe’s name.', 'أريد اسم الكاتب.'), next: 'name' }),
          Object.freeze({
            text: L('Pay for silence about the scribe.', 'ادفع ثمن الصمت عن الكاتب.'),
            next: 'paid', requires: Object.freeze({ flags: [Flags.APPRENTICE_CONFESSED] }),
          }),
          Object.freeze({ text: L('Neither. Walk away.', 'لا هذا ولا ذاك. امضِ بعيدًا.'), next: 'end_walk' }),
        ]),
      }),
      name: Object.freeze({
        speaker: 'labourer',
        lines: Object.freeze([L('Bel-ushar. He wrote for whoever paid, and last month somebody paid him twice in one night.',
          'بيل أوشّر. كان يكتب لمن يدفع، وفي الشهر الماضي دفع له أحدهم مرتين في ليلة واحدة.')]),
        next: 'open',
      }),
      paid: Object.freeze({
        speaker: 'labourer',
        lines: Object.freeze([L('Then the canal keeps what it kept. Ask the potter at the kiln — he pulled the man out and he put him back in.',
          'إذن فالقناة تحتفظ بما احتفظت به. اسأل الفخّاري عند القمين — هو أخرج الرجل ثم أعاده.')]),
        effects: Object.freeze({ flags: [Flags.FOREMAN_PAID] }),
        end: true,
      }),
      end_walk: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('Neither. I do not buy what I can prove.', 'لا هذا ولا ذاك. لا أشتري ما أستطيع إثباته.')]),
        end: true,
      }),
    }),
  }),

  /* 8 — chapter 6: the scribe's corner */
  Object.freeze({
    id: 'dt-mk-scribe', landmark: 'lm-mk-scribe', chapter: 'ch6',
    mission: 'm08-citys-tongue', speaker: 'apprentice', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'apprentice',
        lines: Object.freeze([L('The master is not here. The master has not been here for a week, and nobody has come to ask until you.',
          'الأستاذ ليس هنا. الأستاذ لم يكن هنا منذ أسبوع، ولم يأتِ أحد ليسأل قبلك.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('What did he write last?', 'ماذا كتب آخر مرة؟'), next: 'last' }),
          Object.freeze({
            text: L('Show him the seventh tablet’s clay.', 'أره طين اللوح السابع.'),
            next: 'clay', requires: Object.freeze({ clues: ['clue-tablet-shelf'] }),
          }),
          Object.freeze({ text: L('Ask where he went.', 'اسأل إلى أين ذهب.'), next: 'went' }),
        ]),
      }),
      last: Object.freeze({
        speaker: 'apprentice',
        lines: Object.freeze([L('A seal. Not a text — a seal. He practised it on wax until he could press it in the dark.',
          'ختم. لا نصّ — ختم. تدرّب عليه بالشمع حتى صار يضغطه في الظلام.')]),
        effects: Object.freeze({ flags: [Flags.KNOWS_PRACTISED_SEAL] }),
        next: 'open',
      }),
      // Terminal on purpose. Identifying the clay is the payoff of this corner, and
      // closing here gives the tree an exit - before this node ended with
      // `next: "open"`, every branch looped back and the player could never leave
      // the conversation, which in a shipped build is a hang rather than a bug.
      clay: Object.freeze({
        speaker: 'apprentice',
        lines: Object.freeze([L('That is his clay. He kept it in a jar by the door and he was proud of it. Whoever pressed this used his jar.',
          'هذا طينه. كان يحفظه في جرّة عند الباب ويفخر به. ومن ضغط هذا فقد استعمل جرّته.')]),
        effects: Object.freeze({ flags: [Flags.APPRENTICE_CONFESSED] }),
        end: true,
      }),
      went: Object.freeze({
        speaker: 'apprentice',
        lines: Object.freeze([L('Out at night, toward the canal, with a man who paid in bronze and would not give a name. He did not come back.',
          'خرج ليلًا نحو القناة، مع رجل يدفع بالبرونز ولا يعطي اسمًا. ولم يعد.')]),
        end: true,
      }),
    }),
  }),

  /* 9 — chapter 6: the thief's alley */
  Object.freeze({
    id: 'dt-mk-thief', landmark: 'lm-mk-thief', chapter: 'ch6',
    mission: 'm08-citys-tongue', speaker: 'thief', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'thief',
        lines: Object.freeze([L('A lord in this alley is either lost or buying. You are not lost — you are walking too straight.',
          'سيد في هذا الزقاق إما ضائع أو مشترٍ. أنت لست ضائعًا — فأنت تمشي باستقامة زائدة.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('What did you see at the canal?', 'ماذا رأيت عند القناة؟'), next: 'canal' }),
          Object.freeze({
            text: L('Offer the moneylender’s token.', 'اعرض علامة المرابي.'),
            next: 'token', requires: Object.freeze({ clues: ['clue-canal-body'] }),
          }),
          Object.freeze({ text: L('Leave the alley.', 'اترك الزقاق.'), next: 'end_leave' }),
        ]),
      }),
      canal: Object.freeze({
        speaker: 'thief',
        lines: Object.freeze([L('Two men at the mooring after dark. One went in the water. The one who walked out wore a lord’s hem and did not run.',
          'رجلان عند المرسى بعد حلول الظلام. أحدهما دخل الماء. والذي خرج ارتدى ذيل سيد ولم يركض.')]),
        effects: Object.freeze({ flags: [Flags.THIEF_SAW_DROWNING] }),
        next: 'open',
      }),
      token: Object.freeze({
        speaker: 'thief',
        lines: Object.freeze([L('That token is the moneylender’s, and the moneylender only gives those to men whose bonds he holds. Evan’s bonds are heavy.',
          'تلك العلامة للمرابي، والمرابي لا يعطيها إلا لمن يملك سنداته. وسندات إيفان ثقيلة.')]),
        effects: Object.freeze({ flags: [Flags.KNOWS_BITUMEN_DRAWN] }),
        end: true,
      }),
      end_leave: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('Keep your alley. I have a canal to look at.', 'احتفظ بزقاقك. عندي قناة أنظر إليها.')]),
        end: true,
      }),
    }),
  }),

  /* 10 — chapter 6: the priests' stand */
  Object.freeze({
    id: 'dt-tp-priests', landmark: 'lm-tp-priests', chapter: 'ch6',
    mission: 'm09-temples-memory', speaker: 'priest', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'priest',
        lines: Object.freeze([L('The archive holds a witnessed copy. It is not given to a man whose own family names him a suspect.',
          'يحتفظ الأرشيف بنسخة مشهود عليها. ولا تُعطى لرجل تسمّيه أسرته نفسها متهمًا.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('Then witness me now, in the cella.', 'فاشهد عليّ الآن، في القدْس.'), next: 'cella' }),
          Object.freeze({
            text: L('Present the boundary stone’s wording.', 'اعرض نصّ حجر الحدود.'),
            next: 'stone', requires: Object.freeze({ clues: ['clue-boundary-stone'] }),
          }),
          Object.freeze({ text: L('Ask who lodged the copy.', 'اسأل من أودع النسخة.'), next: 'lodged' }),
        ]),
      }),
      cella: Object.freeze({
        speaker: 'priest',
        lines: Object.freeze([L('Enter, then. But the copy is read aloud before the god, or it is not read at all.',
          'ادخل إذن. لكن النسخة تُقرأ جهارًا أمام الإله، أو لا تُقرأ البتة.')]),
        effects: Object.freeze({ flags: [Flags.TEMPLE_WITNESS] }),
        end: true,
      }),
      stone: Object.freeze({
        speaker: 'priest',
        lines: Object.freeze([L('You know the wording by heart. A forger learns a seal; an heir learns a text. Go in.',
          'أنت تعرف النصّ عن ظهر قلب. المزوّر يتعلّم ختمًا؛ والوارث يتعلّم نصًّا. ادخل.')]),
        effects: Object.freeze({ flags: [Flags.PRIESTS_REFUSED, Flags.TEMPLE_WITNESS] }),
        end: true,
      }),
      lodged: Object.freeze({
        speaker: 'priest',
        lines: Object.freeze([L('Orin himself, a month before he died. He said a house that argues should have a witness it cannot bribe.',
          'أورين نفسه، قبل موته بشهر. قال إن دارًا تتخاصم يجب أن يكون لها شاهد لا يمكن رشوته.')]),
        next: 'open',
      }),
    }),
  }),

  /* 11 — chapter 6: the inner cella */
  Object.freeze({
    id: 'dt-tp-cella', landmark: 'lm-tp-cella', chapter: 'ch6',
    mission: 'm09-temples-memory', speaker: 'priest', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'priest',
        lines: Object.freeze([L('Speak low. The copy is in the niche behind the basin, and it is older than the tablet your family carries.',
          'اخفض صوتك. النسخة في الكوة وراء الحوض، وهي أقدم من اللوح الذي تحمله أسرتك.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('Read it to me.', 'اقرأها عليّ.'), next: 'read' }),
          Object.freeze({
            text: L('Ask about Eleric’s standing here.', 'اسأل عن مكانة إليريك هنا.'),
            next: 'eleric',
          }),
          Object.freeze({ text: L('Take nothing and leave.', 'لا تأخذ شيئًا واخرج.'), next: 'end_leave' }),
        ]),
      }),
      read: Object.freeze({
        speaker: 'priest',
        lines: Object.freeze([L('“To Raynor, the house and its tablets; to the others, their portions in silver and in land, and no portion in the writing of this.”',
          '«لراينور، الدار وألواحها؛ وللباقين، أنصبتهم من الفضة والأرض، ولا نصيب لهم في كتابة هذا».')]),
        effects: Object.freeze({ flags: [Flags.TEMPLE_WITNESS] }),
        end: true,
      }),
      eleric: Object.freeze({
        speaker: 'priest',
        lines: Object.freeze([L('Eleric has stood in this cella, but he has never touched the niche. The niche is sealed with wax only three of us break.',
          'وقف إليريك في هذا القدْس، لكنه لم يمسّ الكوة قط. الكوة مختومة بشمع لا يكسره إلا ثلاثة منا.')]),
        next: 'open',
      }),
      end_leave: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('I will come back with witnesses. I will not steal from a god.',
          'سأعود مع شهود. لن أسرق من إله.')]),
        end: true,
      }),
    }),
  }),

  /* 12 — chapter 6: the potter's kiln */
  Object.freeze({
    id: 'dt-cb-potter', landmark: 'lm-cb-potter', chapter: 'ch6',
    mission: 'm10-canal', speaker: 'potter', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'potter',
        lines: Object.freeze([L('I pulled a man out of the reeds. Then two came and told me to put him back, and I am a potter, not a hero.',
          'أخرجت رجلًا من القصب. ثم جاء اثنان وطلبا أن أُعيده، وأنا فخّاري لا بطل.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('Describe the man.', 'صف الرجل.'), next: 'describe' }),
          Object.freeze({ text: L('Describe the two.', 'صف الاثنين.'), next: 'two' }),
          Object.freeze({ text: L('Show him the canal clue.', 'أره دليل القناة.'), next: 'hands', requires: Object.freeze({ clues: ['clue-canal-body'] }) }),
          Object.freeze({ text: L('Leave the kiln.', 'اترك القمين.'), next: 'end_leave' }),
        ]),
      }),
      describe: Object.freeze({
        speaker: 'potter',
        lines: Object.freeze([L('Thin. Ink under the nails of both hands, the way it stays on a man who writes all day and washes afterwards.',
          'نحيل. حبر تحت أظافر كلتا يديه، كما يبقى على رجل يكتب النهار كله ثم يغسل بعده.')]),
        effects: Object.freeze({ flags: [Flags.POTTER_MARKED_HANDS] }),
        next: 'open',
      }),
      two: Object.freeze({
        speaker: 'potter',
        lines: Object.freeze([L('One was a servant I know from the palace store. The other kept his back to the kiln fire. He had soft hands.',
          'أحدهما خادم أعرفه من مخزن القصر. والآخر أبقى ظهره إلى نار القمين. كانت يداه ناعمتين.')]),
        next: 'open',
      }),
      hands: Object.freeze({
        speaker: 'potter',
        lines: Object.freeze([L('That clay is the scribe’s own jar clay. He was drowned with his work still under his nails.',
          'هذا الطين هو طين جرّة الكاتب نفسه. أُغرق وعمله ما يزال تحت أظافره.')]),
        effects: Object.freeze({ flags: [Flags.POTTER_MARKED_HANDS] }),
        end: true,
      }),
      // Ungated exit: `hands` above needs a clue, so it cannot be the only
      // way out of the kiln scene.
      end_leave: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('Keep the fire going. I will come back with a man who writes this down.',
          'أبقِ النار مشتعلة. سأعود مع رجل يدوّن هذا.')]),
        end: true,
      }),
    }),
  }),

  /* 13 — epilogue: Layla's hearth */
  Object.freeze({
    id: 'dt-ll-hearth', landmark: 'lm-ll-hearth', chapter: 'epilogue',
    mission: 'm11-betrayed-will', speaker: 'layla', entry: 'open',
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'layla',
        lines: Object.freeze([L('You came back through the door and not the window. That means it is finished.',
          'عدت من الباب لا من النافذة. معناه أن الأمر قد انتهى.')]),
        choices: Object.freeze([
          Object.freeze({
            text: L('Read the temple’s copy aloud.', 'اقرأ نسخة المعبد جهارًا.'),
            next: 'read', requires: Object.freeze({ clues: ['clue-temple-archive'] }),
          }),
          Object.freeze({ text: L('Tell her what Evan did.', 'أخبرها بما فعله إيفان.'), next: 'evan', requires: Object.freeze({ flags: [Flags.EVAN_CORNERED] }) }),
          Object.freeze({ text: L('Say only that you are tired.', 'قل فقط إنك متعب.'), next: 'end_tired' }),
        ]),
      }),
      read: Object.freeze({
        speaker: 'layla',
        lines: Object.freeze([L('“To Raynor, the house and its tablets.” He said it in the courtyard and he said it here. Now it is said twice in a house that tried to forget it.',
          '«لراينور، الدار وألواحها». قالها في الفناء وقالها هنا. والآن قيلت مرتين في دار حاولت أن تنساها.')]),
        effects: Object.freeze({ flags: [Flags.WILL_READ_ALOUD, Flags.LAYLA_TRUSTS] }),
        end: true,
      }),
      evan: Object.freeze({
        speaker: 'layla',
        lines: Object.freeze([L('He was the one who sat up so the rest of us could sleep. I would have sworn for him. That is what he counted on.',
          'هو من سهر لننام نحن الباقين. كنت سأحلف من أجله. وهذا ما راهن عليه.')]),
        effects: Object.freeze({ flags: [Flags.LAYLA_TRUSTS] }),
        next: 'open',
      }),
      end_tired: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('I am tired. The will can wait until the lamp is lit.', 'أنا متعب. الوصية يمكن أن تنتظر حتى يُشعل السراج.')]),
        end: true,
      }),
    }),
  }),

  /* 14 — epilogue: the low table (optional, closing beat) */
  Object.freeze({
    id: 'dt-ll-table', landmark: 'lm-ll-table', chapter: 'epilogue',
    mission: 'm11-betrayed-will', speaker: 'layla', entry: 'open', optional: true,
    nodes: Object.freeze({
      open: Object.freeze({
        speaker: 'layla',
        lines: Object.freeze([L('Sit. There is bread and there is nothing to decide.',
          'اجلس. هناك خبز وليس هناك ما يُقرَّر.')]),
        choices: Object.freeze([
          Object.freeze({ text: L('Ask what she will do now.', 'اسألها ماذا ستفعل الآن.'), next: 'now' }),
          Object.freeze({ text: L('Ask about the brothers who were innocent.', 'اسأل عن الإخوة الأبرياء.'), next: 'innocent' }),
          Object.freeze({ text: L('Eat in silence.', 'كُل بصمت.'), next: 'end_eat' }),
        ]),
      }),
      now: Object.freeze({
        speaker: 'layla',
        lines: Object.freeze([L('Keep the house’s memory. Someone has to, or the next argument starts from nothing again.',
          'أحفظ ذاكرة الدار. لا بدّ من أحد يحفظها، وإلا بدأ الخصام القادم من الصفر مرة أخرى.')]),
        effects: Object.freeze({ flags: [Flags.LAYLA_TRUSTS] }),
        end: true,
      }),
      innocent: Object.freeze({
        speaker: 'layla',
        lines: Object.freeze([L('Novan argued in daylight. Zafir owes less than he boasts. Kyle poured the cup but did not rinse it. Eleric never touched the niche.',
          'نوفان خاصم في وضح النهار. وزافر مدين بأقل مما يتباهى. وكايل صبّ الكأس لكنه لم يشطفها. وإليريك لم يمسّ الكوة قط.')]),
        end: true,
      }),
      end_eat: Object.freeze({
        speaker: 'raynor',
        lines: Object.freeze([L('The bread is good. That is enough for one evening.', 'الخبز طيّب. وهذا يكفي لليلة واحدة.')]),
        end: true,
      }),
    }),
  }),
]);

export const DIALOGUE_MAP = Object.freeze(
  DIALOGUE_TREES.reduce((acc, t) => { acc[t.id] = t; return acc; }, {}),
);

/** The landmarks that carry dialogue, straight from the world data. */
export function dialogueLandmarks() {
  return LANDMARKS.filter((l) => l.interact === 'dialogue');
}

/** Which tree (if any) is spoken at a given landmark. */
export function treeAtLandmark(landmarkId) {
  return DIALOGUE_TREES.find((t) => t.landmark === landmarkId) ?? null;
}

/* --------------------------------------------------------- walkability */

/** Predicate that holds nothing: models a player who has arrived early. */
export const NOTHING = () => false;
/** Predicate that holds everything: models a player who has found it all. */
export const EVERYTHING = () => true;

const isTerminal = (n) => n.end === true
  || (typeof n.next !== 'string' && !(Array.isArray(n.choices) && n.choices.length > 0));

/**
 * Whether a choice's `requires` is satisfied by what the player holds.
 *
 * Exported so the runtime walker and this validator gate branches with the same
 * code. Two implementations of one rule drift, and the drift shows up as a choice
 * that is greyed out in the UI but walkable in the graph - or the reverse.
 */
export function allows(req, has) {
  if (!req) return true;
  for (const f of req.flags ?? []) if (!has('flag', f)) return false;
  for (const c of req.clues ?? []) if (!has('clue', c)) return false;
  return true;
}

/**
 * Every node the player can actually reach, given what they are carrying.
 *
 * `has` is a predicate `(kind, id) => boolean` rather than a state object, so this
 * file never imports the mission or save layer, and so a test can ask what a tree
 * looks like to a player holding nothing without building one.
 */
export function reachableNodes(tree, has = EVERYTHING) {
  const nodes = tree.nodes ?? {};
  const seen = new Set();
  const stack = [tree.entry];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !nodes[id]) continue;
    seen.add(id);
    const n = nodes[id];
    if (typeof n.next === 'string') stack.push(n.next);
    for (const c of n.choices ?? []) if (allows(c.requires, has)) stack.push(c.next);
  }
  return seen;
}

/**
 * Whether a player standing at `from` and holding `has` can get OUT.
 *
 * Stricter than "the tree has a terminal node", and the difference is the bug it
 * exists to catch: a tree can have exactly one exit and put it behind a gated
 * choice, so a player who arrives without that clue is trapped in a conversation
 * that never ends. Three of the fourteen trees were built that way, and a terminal
 * count that ignores gating reported all three as healthy.
 *
 * Taking a start node makes it usable for the second question as well: a branch can
 * be reachable and still be a dead end, and only a check from that branch knows.
 */
export function canFinishFrom(tree, has = EVERYTHING, from = tree.entry) {
  const nodes = tree.nodes ?? {};
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !nodes[id]) continue;
    seen.add(id);
    if (isTerminal(nodes[id])) return true;
    if (typeof nodes[id].next === 'string') stack.push(nodes[id].next);
    for (const c of nodes[id].choices ?? []) if (allows(c.requires, has)) stack.push(c.next);
  }
  return false;
}

/** Whether a player holding `has` can finish this conversation from its start. */
export function canFinish(tree, has = EVERYTHING) {
  return canFinishFrom(tree, has, tree.entry);
}

/* ------------------------------------------------------------- validation */

/**
 * Prove the fourteen trees are complete, bound, bilingual, and walkable.
 *
 * The graph checks are the ones that matter. A choice that points at a node
 * nobody wrote is a conversation that ends in silence; a node with neither
 * `next` nor `choices` nor `end` is a conversation the player cannot leave, which
 * in a shipped game is a hang, not a bug report.
 */
export function validateDialogueData() {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  const flagValues = new Set(Object.values(Flags));
  const landmarkIds = new Set(LANDMARKS.map((l) => l.id));

  const bilingual = (obj, where) => {
    need(obj && typeof obj.en === 'string' && obj.en.length > 0, `${where}: missing en`);
    need(obj && typeof obj.ar === 'string' && obj.ar.length > 0, `${where}: missing ar`);
    if (obj && typeof obj.ar === 'string') {
      const latin = obj.ar.match(/[A-Za-z]{2,}/);
      need(!latin, `${where}: Arabic line contains Latin script "${latin ? latin[0] : ''}"`);
    }
    if (obj && typeof obj.en === 'string') {
      need(!/[\u0600-\u06FF]/.test(obj.en), `${where}: English line contains Arabic script`);
    }
  };

  // Exactly fourteen trees, one per dialogue landmark, none doubled up.
  const landmarks = dialogueLandmarks();
  need(DIALOGUE_TREES.length === 14, `expected 14 dialogue trees, found ${DIALOGUE_TREES.length}`);
  need(landmarks.length === 14, `world-data declares ${landmarks.length} dialogue landmarks; expected 14`);
  const usedLandmarks = new Set();
  for (const t of DIALOGUE_TREES) {
    need(!usedLandmarks.has(t.landmark), `${t.id}: landmark "${t.landmark}" already carries another tree`);
    usedLandmarks.add(t.landmark);
    const lm = LANDMARK_MAP[t.landmark];
    need(!!lm, `${t.id}: unknown landmark "${t.landmark}"`);
    need(lm && lm.interact === 'dialogue',
      `${t.id}: landmark "${t.landmark}" has interact="${lm?.interact}", not "dialogue"`);
    need(lm && lm.region && CHAPTER_MAP[t.chapter]?.regions.includes(lm.region),
      `${t.id}: chapter ${t.chapter} does not include landmark region "${lm?.region}"`);
    need(!!speakerOf(t.speaker), `${t.id}: unknown speaker "${t.speaker}"`);
    need(t.mission === null || !!MISSIONS.find((m) => m.id === t.mission),
      `${t.id}: unknown mission "${t.mission}"`);

    // The tree must be reachable: some mission sends the player to it, or it is
    // explicitly marked optional/ambient so the validator knows it is deliberate.
    const wantedBy = MISSIONS.filter((m) => m.objectives.some((o) => o.target === t.id));
    need(wantedBy.length > 0 || t.optional === true,
      `${t.id}: no mission sends the player here, and it is not marked optional — unreachable content`);
    for (const m of wantedBy) {
      need(m.chapter === t.chapter,
        `${t.id}: chapter ${t.chapter} does not match mission ${m.id}’s chapter ${m.chapter}`);
    }

    // --- graph integrity ----------------------------------------------------
    const nodes = t.nodes ?? {};
    const ids = Object.keys(nodes);
    need(ids.length >= 3, `${t.id}: only ${ids.length} nodes — a tree this small is a single line, not a conversation`);
    need(!!nodes[t.entry], `${t.id}: entry node "${t.entry}" does not exist`);

    const referenced = new Set();
    let terminals = 0;
    for (const id of ids) {
      const n = nodes[id];
      const hasChoices = Array.isArray(n.choices) && n.choices.length > 0;
      const hasNext = typeof n.next === 'string';
      if (n.end === true || (!hasChoices && !hasNext)) terminals++;
      need(!(n.end === true && (hasChoices || hasNext)),
        `${t.id}/${id}: marked end but also has an exit — one of the two is a mistake`);
      need(Array.isArray(n.lines) && n.lines.length > 0, `${t.id}/${id}: no lines`);
      for (const [li, line] of (n.lines ?? []).entries()) {
        bilingual(line, `${t.id}/${id} line ${li}`);
      }
      need(n.speaker === undefined || !!speakerOf(n.speaker),
        `${t.id}/${id}: unknown speaker "${n.speaker}"`);

      if (hasNext) referenced.add(n.next);
      for (const c of n.choices ?? []) {
        bilingual(c.text, `${t.id}/${id} choice`);
        referenced.add(c.next);
        for (const cl of c.requires?.clues ?? []) need(!!CLUE_MAP[cl], `${t.id}/${id}: requires unknown clue "${cl}"`);
        for (const f of c.requires?.flags ?? []) need(flagValues.has(f), `${t.id}/${id}: requires unknown flag "${f}"`);
        for (const f of c.effects?.flags ?? []) {
          need(flagValues.has(f), `${t.id}/${id}: effect sets unknown flag "${f}"`);
          need(!MISSION_OWNED_FLAGS.has(f),
            `${t.id}/${id}: dialogue writes "${f}", which belongs to the mission system - one writer per flag`);
        }
        for (const cl of c.effects?.clues ?? []) need(!!CLUE_MAP[cl], `${t.id}/${id}: effect grants unknown clue "${cl}"`);
      }
      for (const f of n.effects?.flags ?? []) {
        need(flagValues.has(f), `${t.id}/${id}: node effect sets unknown flag "${f}"`);
        need(!MISSION_OWNED_FLAGS.has(f),
          `${t.id}/${id}: dialogue writes "${f}", which belongs to the mission system - one writer per flag`);
      }
      for (const cl of n.effects?.clues ?? []) need(!!CLUE_MAP[cl], `${t.id}/${id}: node effect grants unknown clue "${cl}"`);
    }
    // Every edge must land somewhere. This is the check that stops a conversation
    // ending in silence because of a renamed node.
    for (const ref of referenced) {
      need(!!nodes[ref], `${t.id}: an exit points at node "${ref}", which does not exist`);
    }
    need(terminals > 0, `${t.id}: no way to end the conversation — the player is trapped in it`);
    // Terminals counted above ignore gating; these two do not. A tree must be
    // finishable by a player holding nothing, because the player may reach a
    // landmark before finding the clue that unlocks its best exit.
    need(canFinish(t, NOTHING),
      `${t.id}: every exit is behind a clue or flag - a player who arrives early can never leave this conversation`);
    need(canFinish(t, EVERYTHING),
      `${t.id}: unwalkable even holding every clue and flag`);
    for (const id of ids) {
      const n = nodes[id];
      need(!(Array.isArray(n.choices) && n.choices.length > 4),
        `${t.id}/${id}: ${n.choices?.length} choices - more than a player can hold in mind at once`);
    }

    // Reachability from the entry node: an unreachable node is content the player
    // can never see, and usually means a branch was orphaned by an edit.
    const seen = new Set();
    const stack = [t.entry];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur) || !nodes[cur]) continue;
      seen.add(cur);
      const n = nodes[cur];
      if (typeof n.next === 'string') stack.push(n.next);
      for (const c of n.choices ?? []) stack.push(c.next);
    }
    for (const id of ids) {
      need(seen.has(id), `${t.id}/${id}: unreachable from entry "${t.entry}" — orphaned content`);
    }
  }
  for (const lm of landmarks) {
    need(usedLandmarks.has(lm.id),
      `landmark "${lm.id}" is built as a dialogue point but no tree is spoken there`);
  }

  // A gated choice must be satisfiable: a flag required by some choice must be set
  // by some node somewhere, or that branch is permanently dead.
  const settable = new Set();
  for (const t of DIALOGUE_TREES) {
    for (const n of Object.values(t.nodes)) {
      for (const f of n.effects?.flags ?? []) settable.add(f);
      for (const c of n.choices ?? []) for (const f of c.effects?.flags ?? []) settable.add(f);
    }
  }
  for (const t of DIALOGUE_TREES) {
    for (const [id, n] of Object.entries(t.nodes)) {
      for (const c of n.choices ?? []) {
        for (const f of c.requires?.flags ?? []) {
          need(settable.has(f) || MISSION_OWNED_FLAGS.has(f),
            `${t.id}/${id}: a choice requires flag "${f}" that neither dialogue nor the mission system ever sets — dead branch`);
        }
      }
    }
  }

  // --- flag liveness -------------------------------------------------------
  // A flag nobody writes is dead content, and a flag written only by a layer that
  // never runs is dead in practice. Both are invisible in play: the branch reading
  // the flag simply never opens, and nothing looks broken.
  const writtenByStory = new Set();
  const noteStory = (where, list) => {
    for (const f of list ?? []) {
      writtenByStory.add(f);
      need(flagValues.has(f), `${where}: setsFlags names unknown flag "${f}"`);
    }
  };
  for (const m of MISSIONS) {
    noteStory(`mission ${m.id}`, m.setsFlags);
    for (const o of m.objectives) noteStory(`mission ${m.id}/${o.id}`, o.setsFlags);
  }
  for (const c of CINEMATICS) noteStory(`cinematic ${c.id}`, c.setsFlags);
  for (const f of flagValues) {
    need(settable.has(f) || writtenByStory.has(f),
      `flag "${f}" is written by nothing - no conversation, mission, objective or cinematic sets it`);
  }

  // --- every dialogue flag must be obtainable by a real walk ----------------
  // Liveness above proves something writes each flag. This proves a player can
  // actually collect it: the node that sets it must be reachable AND the walk must
  // still be able to leave afterwards. A flag set on a branch that traps the player
  // is worse than a flag nobody writes, because the trap only happens to whoever
  // takes that branch.
  //
  // Checked with EVERYTHING held, which is the honest bound: a gated branch is
  // reachable in some playthrough, not necessarily in the first one. Two of the
  // nineteen flags sit behind clues the linear pass has not found yet, and that is
  // branch variance rather than a defect - but only if a walk through them still
  // finishes, which is what this asserts.
  for (const t of DIALOGUE_TREES) {
    const reachAll = reachableNodes(t, EVERYTHING);
    for (const [id, n] of Object.entries(t.nodes)) {
      const setters = [...(n.effects?.flags ?? [])];
      for (const c of n.choices ?? []) setters.push(...(c.effects?.flags ?? []));
      if (!setters.length) continue;
      need(reachAll.has(id),
        `${t.id}/${id}: sets ${setters.join(', ')} but no walk reaches this node`);
      need(canFinishFrom(t, EVERYTHING, id),
        `${t.id}/${id}: sets ${setters.join(', ')} but a walk that takes this branch cannot leave the conversation`);
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors,
    counts: Object.freeze({
      trees: DIALOGUE_TREES.length,
      nodes: DIALOGUE_TREES.reduce((n, t) => n + Object.keys(t.nodes).length, 0),
      choices: DIALOGUE_TREES.reduce((n, t) => n
        + Object.values(t.nodes).reduce((k, nd) => k + (nd.choices?.length ?? 0), 0), 0),
      lines: DIALOGUE_TREES.reduce((n, t) => n
        + Object.values(t.nodes).reduce((k, nd) => k + (nd.lines?.length ?? 0), 0), 0),
      flags: Object.keys(Flags).length,
      landmarksBound: usedLandmarks.size,
      flagsWrittenByDialogue: settable.size,
      flagsWrittenByStory: writtenByStory.size,
    }),
  });
}
