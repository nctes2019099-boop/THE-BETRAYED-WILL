export function createCamera() {
  return {
    x: 0,
    y: 0,
    tx: 0,
    ty: 0,
    zoom: 1,
    tZoom: 1,
    shake: 0,
    letterbox: 0,
    tLetter: 0,
    lookX: 0,
    lookY: 0,
    mode: "follow",
  };
}

export function cameraFollow(cam, px, py, lookX, lookY) {
  cam.tx = px + lookX * 0.35;
  cam.ty = py + lookY * 0.35;
}

export function cameraUpdate(cam, dt) {
  const k = 1 - Math.pow(0.001, dt);
  cam.x += (cam.tx - cam.x) * k * 8;
  cam.y += (cam.ty - cam.y) * k * 8;
  cam.zoom += (cam.tZoom - cam.zoom) * k * 4;
  cam.letterbox += (cam.tLetter - cam.letterbox) * k * 5;
  cam.shake *= Math.pow(0.08, dt);
}

export function cameraOffset(cam, rand) {
  const s = cam.shake;
  if (s < 0.01) return { x: 0, y: 0 };
  return { x: (rand() - 0.5) * s, y: (rand() - 0.5) * s };
}

export function applyPlaceCamera(cam, place) {
  cam.tZoom = place.camera.zoom;
  cam.tLetter = place.camera.letterbox;
}

export function cinematic(cam, on) {
  cam.tLetter = on ? 0.12 : 0;
  cam.tZoom = on ? 1.18 : cam.tZoom;
}
