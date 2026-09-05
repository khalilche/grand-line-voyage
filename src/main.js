import { Game } from './core/Game.js';

const loader = document.getElementById('loader');
const bar = document.getElementById('bar');
const hud = document.getElementById('hud');

function setProgress(p) {
  bar.style.width = `${Math.round(p * 100)}%`;
}

function fail(stage, err) {
  const msg = String((err && err.stack) || err);
  window.__BOOT_ERR__ = `[${stage}] ${msg}`;
  console.error('[boot]', stage, err);
  if (loader) {
    const hint = loader.querySelector('.hint');
    if (hint) hint.textContent = `Failed at ${stage} — see console.`;
  }
}

window.addEventListener('error', (e) => {
  if (!window.__BOOT_ERR__) window.__BOOT_ERR__ = `[window.error] ${e.message} @ ${e.filename}:${e.lineno}`;
});
window.addEventListener('unhandledrejection', (e) => {
  if (!window.__BOOT_ERR__) window.__BOOT_ERR__ = `[unhandledrejection] ${String(e.reason && e.reason.stack || e.reason)}`;
});

async function boot() {
  let game;
  try {
    game = new Game({ mount: document.getElementById('app'), onProgress: setProgress });
    window.__GAME__ = game;               // expose early for tooling
  } catch (err) {
    return fail('construct', err);
  }

  try {
    await game.init();
  } catch (err) {
    return fail('init', err);
  }

  setProgress(1);
  hud.hidden = false;
  loader.classList.add('hidden');
  setTimeout(() => loader.remove(), 900);

  try {
    game.start();
  } catch (err) {
    return fail('start', err);
  }
}

boot();
