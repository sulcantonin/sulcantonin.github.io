/*
 * Interactive 3D portrait: a 3D Gaussian splat predicted from a single photo
 * (Apple SHARP), rendered live with three.js + Spark. Loaded on demand only.
 */
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

/* Camera of the source photo (pixels, metres) and the hero framing. */
const SHOT = { w: 2048, h: 2560, f: 4918.9, subject: 2.95, minDepth: 2.83, zoom: 1.3, shiftY: -0.07 };
const DIAG = Math.hypot(SHOT.w / SHOT.f, SHOT.h / SHOT.f);
const RANGE_X = 0.1 * DIAG * SHOT.minDepth;  // lateral look-around, metres
const RANGE_Y = 0.4 * RANGE_X;
const RANGE_Z = 0.12 * SHOT.minDepth;        // dolly in
const SWAY_X = 0.55 * RANGE_X;               // idle motion, same path as the hero loop
const PERIOD = 8;                             // seconds

export async function mountPortrait3D(stage, { url, onProgress }) {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.className = "viewer-canvas";
  stage.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.add(new SparkRenderer({ renderer }));

  const camera = new THREE.PerspectiveCamera(
    (2 * Math.atan(SHOT.h / 2 / (SHOT.f * SHOT.zoom)) * 180) / Math.PI, SHOT.w / SHOT.h, 0.05, 2000);
  const lookAt = new THREE.Vector3(0, 0, -SHOT.subject);

  const splat = new SplatMesh({
    url,
    onProgress: (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); },
  });
  splat.quaternion.set(1, 0, 0, 0); // OpenCV axes (y down, z forward) -> three.js
  scene.add(splat);

  function resize() {
    const r = stage.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.setViewOffset(w, h, 0, SHOT.shiftY * h, w, h);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  /* Input: hover or drag moves the eye, wheel/pinch dollies, arrows nudge. */
  const target = new THREE.Vector3();   // normalised [-1, 1] x/y, [0, 1] z
  const eye = new THREE.Vector3();
  let lastInput = -1e9, dragging = false;
  const pinch = new Map();
  let pinchStart = 0, zStart = 0;

  function pointAt(e) {
    const r = stage.getBoundingClientRect();
    target.x = THREE.MathUtils.clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    target.y = THREE.MathUtils.clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
    lastInput = performance.now();
  }
  const onMove = (e) => {
    if (pinch.has(e.pointerId)) pinch.set(e.pointerId, e);
    if (pinch.size === 2) {
      const [a, b] = [...pinch.values()];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      target.z = THREE.MathUtils.clamp(zStart + (d - pinchStart) / 300, 0, 1);
      lastInput = performance.now();
    } else if (e.pointerType === "mouse" || dragging) {
      pointAt(e);
    }
  };
  const onDown = (e) => {
    pinch.set(e.pointerId, e);
    if (pinch.size === 2) {
      const [a, b] = [...pinch.values()];
      pinchStart = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      zStart = target.z;
    }
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    pointAt(e);
  };
  const onUp = (e) => { pinch.delete(e.pointerId); dragging = pinch.size > 0; };
  const onWheel = (e) => {
    e.preventDefault();
    target.z = THREE.MathUtils.clamp(target.z - e.deltaY / 600, 0, 1);
    lastInput = performance.now();
  };
  const onKey = (e) => {
    const step = 0.15, k = e.key;
    if (k === "ArrowLeft") target.x = Math.max(-1, target.x - step);
    else if (k === "ArrowRight") target.x = Math.min(1, target.x + step);
    else if (k === "ArrowUp") target.y = Math.max(-1, target.y - step);
    else if (k === "ArrowDown") target.y = Math.min(1, target.y + step);
    else if (k === "+" || k === "=") target.z = Math.min(1, target.z + 0.1);
    else if (k === "-") target.z = Math.max(0, target.z - 0.1);
    else return;
    e.preventDefault();
    lastInput = performance.now();
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("keydown", onKey);

  await splat.initialized;

  /* Blend the idle sway with user input; ease everything for smooth motion. */
  let auto = reduceMotion ? 0 : 1;
  const clock = new THREE.Clock();
  let phase = 0;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const idle = performance.now() - lastInput > 2500 && !dragging;
    auto += ((idle && !reduceMotion ? 1 : 0) - auto) * Math.min(1, dt * 1.5);
    if (idle && !reduceMotion) phase += dt / PERIOD;
    const a = 2 * Math.PI * phase;
    const sway = new THREE.Vector3(SWAY_X * Math.sin(a), 0.175 * SWAY_X * Math.sin(2 * a), -0.07 * SHOT.minDepth * (1 - Math.cos(a)) / 2);
    const user = new THREE.Vector3(target.x * RANGE_X, -target.y * RANGE_Y, -target.z * RANGE_Z);
    eye.lerp(user.lerp(sway, auto), Math.min(1, dt * 6));
    camera.position.copy(eye);
    camera.lookAt(lookAt);
    renderer.render(scene, camera);
  });

  return function dispose() {
    renderer.setAnimationLoop(null);
    ro.disconnect();
    stage.removeEventListener("keydown", onKey);
    splat.dispose?.();
    renderer.dispose();
    canvas.remove();
  };
}
