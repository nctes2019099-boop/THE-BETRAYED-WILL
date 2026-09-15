/** Procedural soundtrack & cues via Web Audio. */
export function createAudio() {
  const A = {
    ctx: null,
    master: null,
    ambient: null,
    pad: null,
    place: null,
    unlocked: false,
  };

  function unlock() {
    if (A.unlocked) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    A.ctx = new Ctx();
    A.master = A.ctx.createGain();
    A.master.gain.value = 0.22;
    A.master.connect(A.ctx.destination);
    A.unlocked = true;
    startPad();
  }

  function tone(freq, dur, type, gain, at) {
    if (!A.ctx) return;
    const t = A.ctx.currentTime + (at || 0);
    const o = A.ctx.createOscillator();
    const g = A.ctx.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(A.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function noise(dur, gain, at) {
    if (!A.ctx) return;
    const t = A.ctx.currentTime + (at || 0);
    const n = A.ctx.createBuffer(1, A.ctx.sampleRate * dur, A.ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = A.ctx.createBufferSource();
    src.buffer = n;
    const f = A.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 800;
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(A.master);
    src.start(t);
    src.stop(t + dur);
  }

  function startPad() {
    if (!A.ctx || A.pad) return;
    const make = (freq, type, gain) => {
      const o = A.ctx.createOscillator();
      const g = A.ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g);
      g.connect(A.master);
      o.start();
      return { o, g };
    };
    A.pad = [
      make(55, "sine", 0.04),
      make(82.5, "triangle", 0.02),
      make(110, "sine", 0.015),
    ];
  }

  function setPlace(id) {
    A.place = id;
    if (!A.pad) return;
    const table = {
      harbor: [49, 73.4, 98],
      inn: [65.4, 82.4, 98],
      moors: [46.2, 69.3, 92.5],
      watch: [51.9, 77.8, 103.8],
      court: [61.7, 77.8, 123.5],
      archives: [58.3, 87.3, 116.5],
      vault: [41.2, 82.4, 123.5],
      finale: [38.9, 77.8, 155.6],
    };
    const f = table[id] || table.harbor;
    A.pad.forEach((p, i) => {
      p.o.frequency.linearRampToValueAtTime(f[i], A.ctx.currentTime + 1.4);
    });
  }

  function ui() { unlock(); tone(520, 0.08, "square", 0.03); }
  function step() { if (Math.random() < 0.4) noise(0.05, 0.018); }
  function hit() { noise(0.12, 0.08); tone(140, 0.18, "sawtooth", 0.06); }
  function win() { tone(392, 0.2, "sine", 0.05); tone(523, 0.25, "sine", 0.04, 0.12); }
  function talk() { tone(220 + Math.random() * 80, 0.07, "triangle", 0.025); }
  function danger() { tone(80, 0.4, "sawtooth", 0.05); }

  return { unlock, setPlace, ui, step, hit, win, talk, danger, get unlocked() { return A.unlocked; } };
}
