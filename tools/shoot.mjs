/**
 * Screenshot harness. Builds the game, serves dist/ from an inline static
 * server, drives the debug camera to a set of framings, writes PNGs + a log.
 *
 *   node tools/shoot.mjs                 # all shots
 *   node tools/shoot.mjs beach ocean     # a subset
 *   node tools/shoot.mjs --no-build      # reuse existing dist/
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, appendFileSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const outDir = path.join(root, 'tools', 'shots');
const logFile = path.join(root, 'tools', 'shoot.log');
const PORT = 4100 + Math.floor(Math.random() * 800);

writeFileSync(logFile, '');
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  appendFileSync(logFile, line + '\n');
  process.stdout.write(line + '\n');
};

const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const headed = args.includes('--headed');
const swiftshader = args.includes('--swiftshader');
const qArg = (args.find((a) => a.startsWith('--q=')) || '--q=high').slice(4);
const want = args.filter((a) => !a.startsWith('--'));

const SHOTS = [
  { name: 'arena', settle: 2.2 },
  { name: 'arena-wide', settle: 2.4 },
  { name: 'arena-eye', settle: 1.6 },
  { name: 'arena-mid', settle: 1.6 },
  { name: 'mera-wall', base: 'arena-eye', settle: 1.2, after: 'g.setFruitDebug(3); g.castDebug("e");', hold: 0.9 },
  { name: 'mera-hiken', base: 'arena-eye', settle: 1.2, after: 'g.setFruitDebug(3); g.castDebug("v");', hold: 0.5 },
  { name: 'mera-dash', base: 'arena-eye', settle: 1.2, after: 'g.setFruitDebug(3); g.castDebug("f");', hold: 0.35 },
  { name: 'village', settle: 2.4 },
  { name: 'camp', settle: 2.4 },
  { name: 'ruins', settle: 2.4 },
  { name: 'town-wide', settle: 2.6 },
  { name: 'worldmap', settle: 1.2 },
  { name: 'beach', settle: 2.2 },
  { name: 'ocean', settle: 2.6 },
  { name: 'hill', settle: 2.0 },
  { name: 'sail', settle: 2.6 },
  { name: 'fx-fire', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(1); g.castDebug("e");', hold: 0.55 },
  { name: 'fx-firefist', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(3); g.castDebug("q");', hold: 0.42 },
  { name: 'fx-ice', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(2); g.castDebug("e");', hold: 0.55 },
  { name: 'fx-iceage', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(2); g.castDebug("f");', hold: 0.5 },
  { name: 'fx-lightning', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(3); g.castDebug("e");', hold: 0.52 },
  { name: 'fx-quake', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(4); g.castDebug("e");', hold: 0.44 },
  { name: 'fx-sand', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(2); g.castDebug("e");', hold: 0.7 },
  { name: 'ult-sea', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(8); g.castDebug("ult");', hold: 1.0 },
  { name: 'ult-fire', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(3); g.castDebug("ult");', hold: 1.05 },
  { name: 'ult-lightning', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(7); g.castDebug("ult");', hold: 0.62 },
  { name: 'ult-magma', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(9); g.castDebug("ult");', hold: 0.95 },
  { name: 'ult-ice', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(4); g.castDebug("ult");', hold: 0.5 },
  { name: 'tf-phoenix', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(5); g.castDebug("f");', hold: 0.5 },
  { name: 'tf-gear5', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(6); g.castDebug("f");', hold: 0.5 },
  { name: 'q-gomu', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(6); g.castDebug("q");', hold: 0.34 },
  { name: 'gomu-redhawk', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(6); g.castDebug("q");', hold: 0.5 },
  { name: 'gomu-gatling', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(6); g.castDebug("e");', hold: 0.7 },
  { name: 'gomu-bajrang', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(6); g.castDebug("ult");', hold: 1.1 },
  { name: 'gomu-gear5', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(6); g.castDebug("f");', hold: 0.55 },
  { name: 'bara-z2', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(0); g.castDebug("q");', hold: 0.45 },
  { name: 'hie-corona2', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(4); g.castDebug("e");', hold: 0.55 },
  { name: 'q-gura', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(8); g.castDebug("q");', hold: 0.34 },
  { name: 'q-goro', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(7); g.castDebug("q");', hold: 0.14 },
  { name: 'q-mera', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(3); g.castDebug("q");', hold: 0.12 },
  { name: 'tf-gear5-move', base: 'walk', settle: 0.3, after: 'g.setFruitDebug(6); g.fruit.toggleForm(g._fruitCtx());', hold: 0.5 },
  { name: 'tf-phoenix-move', base: 'walk', settle: 0.3, after: 'g.setFruitDebug(5); g.fruit.toggleForm(g._fruitCtx());', hold: 0.5 },
  { name: 'bara-e', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(0); g.castDebug("e");', hold: 0.55 },
  { name: 'bara-f', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(0); g.castDebug("f");', hold: 0.9 },
  { name: 'bara-q', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(0); g.castDebug("q");', hold: 0.22 },
  { name: 'bara-v', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(0); g.castDebug("v");', hold: 1.1 },
  { name: 'bara-ult', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(0); g.castDebug("ult");', hold: 1.1 },
  { name: 'bane-q', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(1); g.castDebug("q");', hold: 0.3 },
  { name: 'bane-e', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(1); g.castDebug("e");', hold: 0.9 },
  { name: 'bane-f', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(1); g.castDebug("f");', hold: 0.8 },
  { name: 'bane-v', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(1); g.castDebug("v");', hold: 1.0 },
  { name: 'bane-ult', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(1); g.castDebug("ult");', hold: 1.1 },
  { name: 'bara-lmb', base: 'walk', settle: 0.4, after: 'g.setFruitDebug(0); g._combo=1; g.meleeDebug();', hold: 0.08 },
  { name: 'bara-lmb3', base: 'walk', settle: 0.4, after: 'g.setFruitDebug(0); g._combo=2; g.meleeDebug();', hold: 0.06 },
  { name: 'suna-q', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(2); g.castDebug("q");', hold: 0.3 },
  { name: 'suna-e', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(2); g.castDebug("e");', hold: 1.1 },
  { name: 'suna-f', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(2); g.castDebug("f");', hold: 0.6 },
  { name: 'suna-v', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(2); g.castDebug("v");', hold: 0.5 },
  { name: 'suna-ult', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(2); g.castDebug("ult");', hold: 1.2 },
  { name: 'mera-fly', base: 'walk', settle: 0.4, after: 'g.setFruitDebug(3); g.castDebug("f"); g.controller.position.y += 7; var fp=g.controller.position.clone(); fp.y-=1; g.vfx.flame(fp,{radius:1.1,height:2.6,life:1.2}); g.vfx.burst(fp,{count:26,color:0xffb43c,color2:0xff3d12,speed:8,size:0.3,life:0.6,gravity:-2,drag:3});', hold: 0.5 },
  { name: 'mera-higan', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(3); g.castDebug("q");', hold: 0.62 },
  { name: 'mera-rain', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(3); g.castDebug("e");', hold: 1.35 },
  { name: 'hie-lance', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(4); g.castDebug("q");', hold: 0.42 },
  { name: 'hie-nova', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(4); g.castDebug("e");', hold: 0.62 },
  { name: 'hie-nova-shatter', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(4); g.castDebug("e");', hold: 1.25 },
  { name: 'hero-front', settle: 0.6 },
  { name: 'hero-back', settle: 0.6 },
  { name: 'hero-3q', settle: 0.6 },
  { name: 'hero-walk', base: 'walk', settle: 0.8 },
  { name: 'phoenix-fly', base: 'combat', settle: 1.2, after: 'g.setFruitDebug(5); g.castDebug("f"); g.controller.position.y += 7;', hold: 0.5 },
  { name: 'phoenix-ground', base: 'walk', settle: 0.6, after: 'g.setFruitDebug(5); g.castDebug("f"); g.controller.flying=false;', hold: 0.5 },
  { name: 'phoenix-q', base: 'combat', settle: 1.2, after: 'g.setFruitDebug(5); g.castDebug("f"); g.controller.position.y += 5; g.castDebug("q");', hold: 0.72 },
  { name: 'phoenix-x', base: 'combat', settle: 1.2, after: 'g.setFruitDebug(5); g.castDebug("f"); g.castDebug("e");', hold: 0.85 },
  { name: 'mera-rain', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(3); g.castDebug("e");', hold: 1.1 },
  { name: 'mera-ult2', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(3); g.castDebug("ult");', hold: 1.15 },
  { name: 'zushi-q', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(10); g.castDebug("q");', hold: 1.6 },
  { name: 'zushi-x', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(10); g.castDebug("e");', hold: 6.0 },
  { name: 'zushi-meteor', base: 'combat', settle: 1.8, after: 'g.setFruitDebug(10); g.castDebug("ult");', hold: 4.5 },
  { name: 'zushi-meteor-hit', base: 'combat', settle: 1.8, after: 'g.setFruitDebug(10); g.castDebug("ult");', hold: 9.5 },
  { name: 'zushi-meteor-after', base: 'combat', settle: 1.8, after: 'g.setFruitDebug(10); g.castDebug("ult");', hold: 13.0 },
  { name: 'goro-rain', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(7); g.castDebug("e");', hold: 4.0 },
  { name: 'goro-rain2', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(7); g.castDebug("e");', hold: 8.0 },
  { name: 'goro-thor', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(7); g.castDebug("f");', hold: 0.5 },
  { name: 'goro-thor2', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(7); g.castDebug("f"); setTimeout(()=>g.castDebug("f"),400); setTimeout(()=>g.castDebug("f"),800);', hold: 1.6 },
  { name: 'goro-q', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(7); g.castDebug("q");', hold: 0.4 },
  { name: 'goro-prison', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(7); g.castDebug("q");', hold: 2.2 },
  { name: 'goro-ult', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(7); g.castDebug("ult");', hold: 3.2 },
  { name: 'goro-ult2', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(7); g.castDebug("ult");', hold: 5.5 },
  { name: 'magu-q', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(9); var s=g.fruit.slots.q; s.onCharge(g._fruitCtx(),1); g.fruit.use("q", g._fruitCtx(), 1);', hold: 1.4 },
  { name: 'magu-lava', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(9); g.castDebug("e");', hold: 2.5 },
  { name: 'magu-lava2', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(9); g.castDebug("e");', hold: 6.0 },
  { name: 'gura-fist', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(8); g.castDebug("q");', hold: 0.6 },
  { name: 'gura-cyc1', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(8); g.castDebug("q");', hold: 1.6 },
  { name: 'gura-cyc2', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(8); g.castDebug("q");', hold: 3.2 },
  { name: 'gura-cyc-blast', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(8); g.castDebug("q");', hold: 5.4 },
  { name: 'gura-fracture', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(8); g.castDebug("e");', hold: 1.0 },
  { name: 'gura-leap', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(8); g.castDebug("f");', hold: 3.0 },
  { name: 'gura-ult', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(8); g.castDebug("ult");', hold: 3.5 },
  { name: 'gura-ult2', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(8); g.castDebug("ult");', hold: 6.5 },
  { name: 'magu-dash', base: 'walk', settle: 0.4, after: 'g.setFruitDebug(9); g.castDebug("f");', hold: 0.4 },
  { name: 'magu-ult', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(9); g.castDebug("ult");', hold: 3.5 },
  { name: 'magu-ult2', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(9); g.castDebug("ult");', hold: 6.5 },
  { name: 'zushi-levit', base: 'combat', settle: 1.4, after: 'g.setFruitDebug(10); g.castDebug("f"); g.controller.position.y += 4;', hold: 1.2 }
];
const list = want.length
  ? want.map((n) => SHOTS.find((s) => s.name === n) || { name: n, settle: 2.4 })
  : SHOTS;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.map': 'application/json', '.wasm': 'application/wasm'
};

function serve() {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = path.join(distDir, '.' + p.replace(/\\/g, '/'));
    const rel = path.relative(distDir, fp);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !existsSync(fp) || statSync(fp).isDirectory()) {
      log('  [404]', req.url);
      res.writeHead(404); res.end('nf'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(readFileSync(fp));
  });
  server.on('error', (e) => log('  [server error] ' + e.message));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function build() {
  return new Promise((res, rej) => {
    const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    const b = spawn(process.execPath, [viteBin, 'build', '--logLevel', 'warn'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    b.stdout.on('data', (d) => (out += d));
    b.stderr.on('data', (d) => (out += d));
    b.on('exit', (c) => { log(out.trim()); c === 0 ? res() : rej(new Error('build failed')); });
  });
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  if (!noBuild) { log('> building...'); await build(); }
  if (!existsSync(path.join(distDir, 'index.html'))) throw new Error('no dist/index.html');

  log('> serving dist/ on :' + PORT);
  const server = await serve();

  const gpuArgs = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy'];
  const swArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({
    headless: !headed,
    args: swiftshader ? swArgs : gpuArgs
  });
  log(`> browser: ${headed ? 'headed' : 'headless'}, ${swiftshader ? 'swiftshader' : 'gpu'}, q=${qArg}`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  page.on('console', (m) => log('  [console.' + m.type() + ']', m.text()));
  page.on('pageerror', (e) => log('  [pageerror]', e.message));
  page.on('requestfailed', (r) => log('  [reqfail]', r.url(), r.failure()?.errorText));

  log('> loading game...');
  await page.goto(`http://127.0.0.1:${PORT}/?q=${qArg}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  const diag = await page.evaluate(() => ({
    bootErr: window.__BOOT_ERR__ || null,
    hasGame: !!window.__GAME__,
    gameKeys: window.__GAME__ ? Object.keys(window.__GAME__).slice(0, 40) : null,
    hasRender: !!(window.__GAME__ && window.__GAME__.render),
    elapsed: window.__GAME__ ? window.__GAME__.elapsed : null,
    hint: document.querySelector('#loader .hint')?.textContent,
    canvases: document.querySelectorAll('canvas').length
  }));
  log('> diag ' + JSON.stringify(diag, null, 1));

  // wait for boot to either succeed or report an error (frame 3 = shaders warm)
  const status = await page.waitForFunction(() => {
    if (window.__BOOT_ERR__) return { err: window.__BOOT_ERR__ };
    const g = window.__GAME__;
    if (g && g.render && g.frame >= 3) return { ok: true, elapsed: g.elapsed, frame: g.frame };
    return false;
  }, null, { timeout: 180000 }).then((h) => h.jsonValue()).catch((e) => ({ err: 'waitForFunction: ' + e.message }));

  if (status.err) {
    log('!! BOOT ERROR:', status.err);
    // grab a webgl capability probe for context
    const probe = await page.evaluate(() => {
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        return gl ? ('webgl ok: ' + gl.getParameter(gl.VERSION)) : 'no webgl context';
      } catch (e) { return 'probe threw: ' + e.message; }
    });
    log('   webgl probe:', probe);
    await page.screenshot({ path: path.join(outDir, '_bootfail.png') });
    await browser.close(); server.close();
    process.exitCode = 1;
    return;
  }

  log('> game up at elapsed=' + status.elapsed.toFixed(2) + 's');
  await sleep(1200);

  for (const shot of list) {
    log('  · ' + shot.name);
    await page.evaluate((n) => window.__GAME__.shot(n), shot.base || shot.name);
    await sleep(shot.settle * 1000);
    if (shot.after) {
      await page.evaluate(`(function(g){ ${shot.after} })(window.__GAME__)`);
      await sleep((shot.hold ?? 0.2) * 1000);
    }
    await page.screenshot({ path: path.join(outDir, `${shot.name}.png`) });
  }

  await browser.close();
  server.close();
  log('> done -> ' + outDir);
}

main().catch((e) => { log('FATAL ' + (e.stack || e)); process.exitCode = 1; });
