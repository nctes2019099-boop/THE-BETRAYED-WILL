/** Bilingual dialogue trees. Choices set flags. */
export const SCENES = {
  intro: {
    letterbox: true,
    beats: [
      { who: null, ar: "مات الملك ألدريك في الشتاء السابع. قرئت وصيته على الملأ.", en: "King Aldric died in the seventh winter. His will was read in public." },
      { who: null, ar: "لم يكن اسمك فيها.", en: "Your name was not in it." },
      { who: "lyen", ar: "ثلاث سنوات من المنفى. والآن يقولون إن الوصية الأصلية ما زالت تتنفّس.", en: "Three years of exile. Now they say the original will still breathes." },
    ],
  },

  docksLook: {
    beats: [
      { who: null, ar: "رماد على الماء. السفن محروقة حتى الخطّ المائي. كأن المملكة نفسها أُطفئت.", en: "Ash on the water. Ships burned to the waterline. As if the kingdom itself had been put out." },
    ],
  },

  runa: {
    beats: [
      { who: "runa", ar: "ليان. ظننتُ البحر ابتلعك.", en: "Lyen. I thought the sea had swallowed you." },
      { who: "lyen", ar: "كاد. جئتُ من أجل الختم لا من أجل العرش.", en: "Almost. I came for the seal, not the throne." },
      { who: "runa", ar: "الختم في البلاط. لكن الوصية… تُسمَع في المستنقعات. الناس يجنون من الهمس.", en: "The seal is at court. But the will… it is heard on the moors. Folk go mad from the whispering." },
      {
        who: "runa",
        ar: "إن دخلتَ المدينة باسمك، يشنقك فاروس قبل الغروب.",
        en: "If you enter the city under your name, Pharos will hang you before dusk.",
        choices: [
          { id: "trustRuna", ar: "أعطني طريقاً.", en: "Give me a road.", set: { metRuna: true, heardRumor: true, moorsOpen: true } },
          { id: "alone", ar: "أعمل وحدي.", en: "I work alone.", set: { metRuna: true, heardRumor: true, moorsOpen: true } },
        ],
      },
    ],
  },

  runaAfter: {
    beats: [
      { who: "runa", ar: "الطريق عبر المستنقعات. إن وجدتَ الكاتب أورلن في المرقب، يفتح لك الباب.", en: "The road is through the moors. If you find Scribe Orlen at the watch, he can open a door." },
    ],
  },

  hearthLook: {
    beats: [
      { who: null, ar: "النار ضعيفة، لكنها صادقة. شيء نادر في فارِث.", en: "The fire is weak, but honest. A rare thing in Vareth." },
    ],
  },

  maia: {
    beats: [
      { who: "maia", ar: "لا أسماء في الفانوس الأخير. ادفع بالرماد أو بالصمت.", en: "No names in the Last Lantern. Pay in ash or in silence." },
      { who: "lyen", ar: "أحتاج سقيفة لليلة.", en: "I need the loft for a night." },
      { who: "maia", ar: "السقيفة مسكونة بالحبر. رسائل بلا مرسل. خذ المفتاح إن شئت أن تقرأ ما لا يخصّك.", en: "The loft is haunted by ink. Letters with no sender. Take the key if you would read what is not yours." },
    ],
    set: { innKey: true },
  },

  loftLetter: {
    need: "innKey",
    beats: [
      { who: null, ar: "رسالة بخطّ الملك: «إن خان المجلس الختم، فلتحيا الوصية وحدها.»", en: "A letter in the king's hand: “If the council betrays the seal, let the will live on alone.”" },
      { who: "lyen", ar: "لم يكن يثق بهم. حتى في موته أراد شاهداً.", en: "He did not trust them. Even in death he wanted a witness." },
    ],
  },

  fragHarbor: {
    beats: [
      { who: null, ar: "شظية شمع ذهبي تحت لوحٍ مخلوع. حرف واحد: ل.", en: "A shard of golden wax under a pried board. One letter: L." },
    ],
    set: { fragmentHarbor: true },
  },

  harborClash: {
    combat: true,
    beats: [
      { who: "guardian", ar: "الاسم مشطوب. العودة محظورة.", en: "The name is struck. Return is forbidden." },
      { who: "lyen", ar: "إذن سأعيده بيدي.", en: "Then I will write it back by hand." },
    ],
    set: { combatHarbor: true },
  },

  standingStones: {
    beats: [
      { who: null, ar: "حجارة قائمة محفورة بختم مكسور. الريح تمرّ منها كأنها تقرأ.", en: "Standing stones carved with a broken seal. Wind moves through them as if reading." },
    ],
  },

  aldric: {
    beats: [
      { who: "aldric", ar: "يا ولدَ الدم. لم أنم. صاغوا فمي من شمعٍ كاذب.", en: "Child of my blood. I have not slept. They cast my mouth in lying wax." },
      { who: "lyen", ar: "قل لي أين الأصل.", en: "Tell me where the original is." },
      { who: "aldric", ar: "في القبو، تحت سبع كذبات. سيراث تعرف العدّ. فاروس يعرف الثمن.", en: "In the vault, under seven lies. Serath knows the count. Pharos knows the price." },
    ],
  },

  fragMoors: {
    beats: [
      { who: null, ar: "الشظية الثانية، باردة كالضريح. حرف: ي.", en: "The second shard, cold as a tomb. Letter: Y." },
    ],
    set: { fragmentMoors: true },
  },

  orlen: {
    beats: [
      { who: "orlen", ar: "إن رأوك تكلّمني أُحرَق مع كتبي.", en: "If they see you speaking to me I will burn with my books." },
      { who: "lyen", ar: "أحتاج الأرشيف.", en: "I need the archives." },
      {
        who: "orlen",
        ar: "أعطيك تصريحاً مزيّفاً مقابل وعد: لا تُطعم الوصية اسمك.",
        en: "I will forge you a pass if you promise not to feed the will your name.",
        choices: [
          { id: "promise", ar: "أعدك.", en: "I promise.", set: { courtPass: true, archiveOpen: true } },
          { id: "nromise", ar: "لا أعد بما لا أفهم.", en: "I will not swear to what I do not understand.", set: { courtPass: true, archiveOpen: true } },
        ],
      },
    ],
  },

  orlenAfter: {
    beats: [
      { who: "orlen", ar: "البلاط يبتسم للوثائق. لا للحق.", en: "The court smiles at documents. Not at truth." },
    ],
  },

  watchMap: {
    beats: [
      { who: null, ar: "خريطة قديمة: نفق من الأرشيف إلى قبوٍ وُسِم «لا يُفتح بعد الموت».", en: "An old map: a tunnel from the archives to a vault marked “not to be opened after death.”" },
    ],
  },

  serath: {
    beats: [
      { who: "serath", ar: "رجعتَ متسخاً بالمنفى. العرش لا يحب الطين.", en: "You return soiled by exile. The throne dislikes mud." },
      { who: "lyen", ar: "هل وقّعتِ على شطبي؟", en: "Did you sign my striking-out?" },
      {
        who: "serath",
        ar: "وقّعتُ على بقاء المملكة. أبوك أحبّك أكثر مما أحبّ السلام.",
        en: "I signed the kingdom's survival. Your father loved you more than he loved peace.",
        choices: [
          { id: "blame", ar: "هذا ليس بقاء. هذا سرقة.", en: "That is not survival. That is theft.", set: { spokeSerath: true } },
          { id: "ask", ar: "إذن ساعديني تُصلحي السرقة.", en: "Then help me undo the theft.", set: { spokeSerath: true, vaultOpen: true } },
        ],
      },
    ],
  },

  serathAfter: {
    beats: [
      { who: "serath", ar: "فاروس يظن الختم أبدياً. الأختام شمع. والشمع يذوب.", en: "Pharos thinks the seal is eternal. Seals are wax. Wax melts." },
    ],
  },

  pharos: {
    beats: [
      { who: "pharos", ar: "الوريث المشطوب. ما أرقّ الحنين حين يرتدي سكّيناً.", en: "The struck heir. How tender nostalgia looks when it wears a knife." },
      { who: "lyen", ar: "أُعيد الوصية.", en: "I will restore the will." },
      {
        who: "pharos",
        ar: "الوصية لم تعد ورقة. صارت فمًا. إن فتحتَ القبو فستأكل الاسم أولاً.",
        en: "The will is no longer paper. It is a mouth. Open the vault and it will eat the name first.",
        choices: [
          { id: "defy", ar: "أفضل فم الحقيقة على يدك.", en: "I prefer the mouth of truth to your hand.", set: { spokePharos: true } },
          { id: "bargain", ar: "ماذا تريد مقابل الأصل؟", en: "What do you want for the original?", set: { spokePharos: true, mercyPharos: true } },
        ],
      },
    ],
  },

  pharosAfter: {
    beats: [
      { who: "pharos", ar: "احكم إن استطعت. لكن لا تطلب مني أن أركع لشبح.", en: "Rule if you can. Do not ask me to kneel to a ghost." },
    ],
  },

  falseThrone: {
    beats: [
      { who: null, ar: "العرش لامع جداً. اللمعان يُخفي النحت الأصلي تحت طبقة ذهب جديدة.", en: "The throne is too bright. The shine hides original carving under a new skin of gold." },
    ],
  },

  fragCourt: {
    beats: [
      { who: null, ar: "شظية ثالثة خلف ستارة. حرف: ا.", en: "A third shard behind a curtain. Letter: A." },
    ],
    set: { fragmentCourt: true },
  },

  forgedCopy: {
    beats: [
      { who: null, ar: "نسخة الوصية المزورة. التوقيع صحيح. التاريخ مستحيل. أبوك مات قبل أن يُكتب السطر الأخير بيوم.", en: "The forged will. The signature is true. The date is impossible. Your father died a day before the last line was written." },
      { who: "lyen", ar: "هذا يكفي لشنق مجلس. لا يكفي لإيقاظ ميت.", en: "Enough to hang a council. Not enough to wake the dead." },
    ],
    set: { forgedWill: true, vaultOpen: true },
  },

  vaultClash: {
    combat: true,
    beats: [
      { who: "guardian", ar: "الوصايا لا تُستعاد. تُطعَم.", en: "Wills are not reclaimed. They are fed." },
    ],
    set: { combatVault: true },
  },

  theWill: {
    beats: [
      { who: "theWill", ar: "كتبتُ نفسي حين خانوك. أعطني اسمك أُكمل الجملة.", en: "I wrote myself when they betrayed you. Give me your name and I will finish the sentence." },
      {
        who: "lyen",
        ar: "ماذا تكونين؟",
        en: "What are you?",
        choices: [
          { id: "trust", ar: "كوني شاهدي.", en: "Be my witness.", set: { trueWill: true, trustWill: true } },
          { id: "wary", ar: "كوني دليلاً لا سيّداً.", en: "Be evidence, not a master.", set: { trueWill: true } },
        ],
      },
    ],
  },

  theWillAfter: {
    beats: [
      { who: "theWill", ar: "العرش الأجوف ينتظر جملةً أخيرة.", en: "The hollow throne waits for a last sentence." },
    ],
  },

  trueWillLook: {
    beats: [
      { who: null, ar: "الوصية الأصلية: «ليان آل فارِث، لا العرش: الحق في رفضه.»", en: "The original will: “Lyen al-Vareth, not the throne: the right to refuse it.”" },
      { who: "lyen", ar: "لم يورّثني تاجاً. ورّثني اختياراً.", en: "He did not leave me a crown. He left me a choice." },
    ],
    set: { trueWill: true },
  },

  fragVault: {
    beats: [
      { who: null, ar: "الشظية الأخيرة. الحروف معاً: ليان. اسمك كان الختم.", en: "The last shard. Together the letters spell LYEN. Your name was the seal." },
    ],
    set: { fragmentVault: true },
  },

  endingChoice: {
    letterbox: true,
    beats: [
      { who: "theWill", ar: "أربعة طرق. جملة واحدة.", en: "Four roads. One sentence." },
      { who: "pharos", ar: "أبقِ النظام. سأجعل اسمك حاشيةً لا حبلاً.", en: "Keep the order. I will make your name a footnote, not a noose." },
      { who: "serath", ar: "أعد القراءة العلنية. دع الشعب يسمع أباك لا المجلس.", en: "Restore the public reading. Let the people hear your father, not the council." },
      {
        who: "lyen",
        ar: "أختار.",
        en: "I choose.",
        choices: [
          { id: "justice", ar: "أُعيد الوصية الحقيقية.", en: "Restore the true will.", ending: "justice" },
          { id: "merge", ar: "أتّحد مع الوصية.", en: "Merge with the Will.", ending: "merge", set: { trustWill: true } },
          { id: "burn", ar: "أحرق كل الوصايا.", en: "Burn every will.", ending: "burn", set: { burnAll: true } },
          { id: "side", ar: "أصالح فاروس.", en: "Side with Pharos.", ending: "betrayal", set: { mercyPharos: true } },
        ],
      },
    ],
  },
};

export const ENDINGS = {
  justice: {
    title: { ar: "الوصية المُعادة", en: "The Restored Will" },
    ar: "تُقرأ الوصية على درجات البلاط. يسقط الختم المزور. لا تأخذ التاج. تأخذ الحق في أن ترفضه، وتعيد المملكة إلى قانونٍ يُسمَع.",
    en: "The will is read on the court steps. The false seal falls. You do not take the crown. You take the right to refuse it, and return the kingdom to a law that can be heard.",
  },
  merge: {
    title: { ar: "الإرادة الواحدة", en: "One Will" },
    ar: "تُعطي اسمك للجملة. تصيران فمًا واحداً. الممالك تُطاع لا لأنها عادلة، بل لأنها لا تتوقف عن الكتابة.",
    en: "You give your name to the sentence. You become one mouth. Kingdoms obey not because they are just, but because they never stop being written.",
  },
  burn: {
    title: { ar: "رماد العقود", en: "Ash of Contracts" },
    ar: "تحرق الأصل والمزوّر معاً. لا وريث، لا مجلس، لا همس. الحرية فوضوية، لكنها لك.",
    en: "You burn original and forgery together. No heir, no council, no whispering. Freedom is messy, but it is yours.",
  },
  betrayal: {
    title: { ar: "الحاشية", en: "The Footnote" },
    ar: "تُوقّع صلحاً مع فاروس. يعيش اسمك في الهامش، وتعيش المملكة كما كانت: لامعة، وكاذبة، ومستقرّة.",
    en: "You sign a peace with Pharos. Your name lives in the margin, and the kingdom lives as it was: bright, false, and stable.",
  },
};

export function npcSceneId(who, flags) {
  if (who === "runa") return flags.metRuna ? "runaAfter" : "runa";
  if (who === "maia") return "maia";
  if (who === "orlen") return flags.courtPass ? "orlenAfter" : "orlen";
  if (who === "serath") return flags.spokeSerath ? "serathAfter" : "serath";
  if (who === "pharos") return flags.spokePharos ? "pharosAfter" : "pharos";
  if (who === "aldric") return "aldric";
  if (who === "theWill") return flags.trueWill ? "theWillAfter" : "theWill";
  return null;
}
