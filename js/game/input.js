export function createInput() {
  const down = new Set();
  const once = new Set();
  const map = {
    KeyW: "up", ArrowUp: "up",
    KeyS: "down", ArrowDown: "down",
    KeyA: "left", ArrowLeft: "left",
    KeyD: "right", ArrowRight: "right",
    KeyE: "use", Space: "use", Enter: "use",
    KeyF: "use",
    Escape: "menu", KeyP: "menu",
    Tab: "studio",
    KeyQ: "lang",
    KeyM: "map",
    Digit1: "c1", Digit2: "c2", Digit3: "c3", Digit4: "c4",
  };

  function bind(target) {
    target.addEventListener("keydown", (e) => {
      const a = map[e.code];
      if (!a) return;
      e.preventDefault();
      if (!down.has(a)) once.add(a);
      down.add(a);
    });
    target.addEventListener("keyup", (e) => {
      const a = map[e.code];
      if (!a) return;
      down.delete(a);
    });
    target.addEventListener("blur", () => down.clear());
  }

  function pressed(a) {
    if (once.has(a)) {
      once.delete(a);
      return true;
    }
    return false;
  }

  function axis() {
    let x = 0;
    let y = 0;
    if (down.has("left")) x -= 1;
    if (down.has("right")) x += 1;
    if (down.has("up")) y -= 1;
    if (down.has("down")) y += 1;
    if (x && y) {
      x *= 0.707;
      y *= 0.707;
    }
    return { x, y };
  }

  return { bind, pressed, axis, down };
}
