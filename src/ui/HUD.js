import * as THREE from 'three';
import { RARITY } from '../combat/DevilFruit.js';
import { pingQuality } from '../net/Ping.js';

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** DOM heads-up display: vitals, skill cooldowns, compass, floating damage. */
export class HUD {
  constructor() {
    this.root = document.getElementById('hud');
    this.hpFill = document.querySelector('#vitals .meter.hp > span');
    this.stFill = document.querySelector('#vitals .meter.stam > span');
    this.skillEls = [...document.querySelectorAll('#fruit .skill')];
    this.thorEl = document.getElementById('thor-charges');
    this.thorPips = this.thorEl ? [...this.thorEl.querySelectorAll('.pips i')] : [];
    this.thorBar = this.thorEl ? this.thorEl.querySelector('.bar > span') : null;
    this.hakiEl = document.getElementById('haki');
    this.hakiBar = this.hakiEl ? this.hakiEl.querySelector('.bar > span') : null;
    this.hakiIcons = this.hakiEl ? {
      armament: this.hakiEl.querySelector('.ico.armament'),
      observation: this.hakiEl.querySelector('.ico.observation'),
      haoshoku: this.hakiEl.querySelector('.ico.haoshoku')
    } : {};
    this.hakiHaoCd = this.hakiEl ? this.hakiEl.querySelector('.ico.haoshoku .cd') : null;
    this.reticle = document.getElementById('reticle');
    this.compass = document.getElementById('compass');
    this.modeTag = document.getElementById('mode-tag');
    this.perf = document.getElementById('perf');

    this.lvEl = document.querySelector('#levelbar .lv');
    this.pctEl = document.querySelector('#levelbar .pct');
    this.xpFill = document.querySelector('#xpmeter > span');
    this.levelupEl = document.getElementById('levelup');
    this.interactEl = document.getElementById('interact');
    this.dialogueEl = document.getElementById('dialogue');
    this.bossEl = document.getElementById('bossbar');
    this.bannerEl = document.getElementById('island-banner');

    this._dmgPool = [];
    this._dmgLayer = document.createElement('div');
    this._dmgLayer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    this.root.appendChild(this._dmgLayer);

    this._fps = 60;
    this._frames = 0;
    this._acc = 0;

    this.setHealth(1);
    this.setStamina(1);
  }

  setHealth(f) { this.hpFill.style.transform = `scaleX(${Math.max(0, f)})`; }

  /** Paso 4 — live latency readout, corner of the screen, color-coded green/yellow/red. */
  setPing(ms) {
    if (!this._pingEl) {
      this._pingEl = document.createElement('div');
      this._pingEl.id = 'ping-hud';
      document.body.appendChild(this._pingEl);
    }
    this._pingEl.className = pingQuality(ms);
    this._pingEl.textContent = `${ms}ms`;
  }
  setStamina(f) { this.stFill.style.transform = `scaleX(${Math.max(0, f)})`; }
  setAim(on) { this.reticle.classList.toggle('aim', !!on); }
  setMode(text) { this.modeTag.textContent = text; }

  setLevel(lv) { this.lvEl.textContent = `Nv ${lv}`; }
  setXp(frac) {
    const p = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    this.xpFill.style.width = `${p}%`;
    this.pctEl.textContent = `${p}%`;
  }
  flashLevelUp(lv) {
    this.setLevel(lv);
    this.levelupEl.textContent = `¡Nivel ${lv}!`;
    this.levelupEl.classList.add('show');
    clearTimeout(this._luT);
    this._luT = setTimeout(() => this.levelupEl.classList.remove('show'), 1400);
  }

  setInteract(text) {
    if (text) {
      this.interactEl.querySelector('.txt').textContent = text;
      this.interactEl.classList.add('show');
    } else {
      this.interactEl.classList.remove('show');
    }
  }
  showDialogue(who, say) {
    this.dialogueEl.querySelector('.who').textContent = who;
    this.dialogueEl.querySelector('.say').textContent = say;
    this.dialogueEl.style.display = 'block';
    this.interactEl.classList.remove('show');
  }
  hideDialogue() { this.dialogueEl.style.display = 'none'; }

  setBoss(name, frac) {
    if (name == null) { this.bossEl.style.display = 'none'; return; }
    this.bossEl.style.display = 'block';
    this.bossEl.querySelector('.bname').textContent = name;
    this.bossEl.querySelector('.track > span').style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  }

  showIslandBanner(name, band) {
    this.bannerEl.querySelector('.n').textContent = name;
    this.bannerEl.querySelector('.lv').textContent = band ? `Nv ${band[0]}-${band[1]}` : '';
    this.bannerEl.classList.add('show');
    clearTimeout(this._banT);
    this._banT = setTimeout(() => this.bannerEl.classList.remove('show'), 3200);
  }

  setFruit(fruit) {
    const s = fruit?.slots || {};
    const names = ['Golpe', s.q?.name ?? '--', s.e?.name ?? '--', s.f?.name ?? '--', s.v?.name ?? '--', s.ult?.name ?? '—'];
    const fc = `#${new THREE.Color(fruit?.color ?? 0xffffff).getHexString()}`;
    this.skillEls.forEach((el, i) => {
      const nm = el.querySelector('.name'); if (nm) nm.textContent = names[i] ?? '--';
      if (i === 0) { el.style.borderColor = 'rgba(255,255,255,0.16)'; return; }
      if (i === 5) {
        const has = !!fruit?.hasUlt?.();
        el.classList.toggle('locked', !has);
        el.style.borderColor = has ? 'rgba(255,210,80,0.6)' : 'rgba(255,255,255,0.1)';
        return;
      }
      el.classList.remove('locked');
      el.style.borderColor = fc;
    });

    const nameEl = document.getElementById('fruit-name');
    if (nameEl && fruit) {
      const rar = RARITY[fruit.rarity] || RARITY.raro;
      nameEl.querySelector('.nm').textContent = fruit.name;
      nameEl.style.color = fc;
      const rarEl = nameEl.querySelector('.rar');
      rarEl.textContent = rar.label;
      rarEl.style.color = `#${new THREE.Color(rar.color).getHexString()}`;
      nameEl.querySelector('.pas').textContent = fruit.passive || '';
    }
    this._fruit = fruit;
  }

  setTransformed(on, label) {
    const nameEl = document.getElementById('fruit-name');
    if (!nameEl) return;
    nameEl.classList.toggle('transformed', !!on);
    if (on && label) nameEl.querySelector('.xform').textContent = label;
    // fruits that only act while transformed: lock every slot but C (the toggle)
    if (this._fruit?.abilitiesNeedForm) {
      const lock = !on;
      this.skillEls[1]?.classList.toggle('locked', lock);
      this.skillEls[2]?.classList.toggle('locked', lock);
      this.skillEls[4]?.classList.toggle('locked', lock);
      this.skillEls[5]?.classList.toggle('locked', lock || !this._fruit?.hasUlt?.());
    }
  }

  setCompass(yaw) {
    let deg = (THREE.MathUtils.radToDeg(yaw) % 360 + 360) % 360;
    const idx = Math.round(deg / 45) % 8;
    this.compass.textContent = DIRS[idx];
  }

  updateCooldowns(fruit) {
    if (!fruit) return;
    const keys = ['q', 'e', 'f', 'v', 'ult'];
    for (let i = 0; i < 5; i++) {
      const el = this.skillEls[i + 1]?.querySelector('.cd');
      if (el) el.style.height = `${fruit.cooldown01(keys[i]) * 100}%`;
    }
  }

  /** El Thor charge pips + 5s window bar. count<=0 hides it. */
  setCharges(count, max = 4, timeFrac = 0) {
    if (!this.thorEl) return;
    const show = count > 0;
    if (this.thorEl.hidden === show) this.thorEl.hidden = !show;
    if (!show) return;
    for (let i = 0; i < this.thorPips.length; i++) this.thorPips[i].classList.toggle('on', i < count);
    if (this.thorBar) this.thorBar.style.width = `${Math.max(0, Math.min(1, timeFrac)) * 100}%`;
  }

  /** Haki meter bar + Busoshoku/Kenbunshoku toggle state + Haoshoku lock/cooldown. */
  setHaki(haki) {
    if (!this.hakiEl) return;
    if (this.hakiBar) this.hakiBar.style.width = `${Math.max(0, Math.min(1, haki.meter / haki.maxMeter)) * 100}%`;
    this.hakiEl.classList.toggle('empty', haki.meter <= 2);
    this.hakiIcons.armament?.classList.toggle('on', haki.armament);
    this.hakiIcons.armament?.classList.toggle('locked', !haki.unlocked.armament);
    this.hakiIcons.observation?.classList.toggle('on', haki.observation);
    this.hakiIcons.observation?.classList.toggle('locked', !haki.unlocked.observation);
    this.hakiIcons.haoshoku?.classList.toggle('locked', !haki.unlocked.haoshoku);
    this.hakiIcons.haoshoku?.classList.toggle('ready', haki.haoReady);
    if (this.hakiHaoCd) this.hakiHaoCd.style.setProperty('--cd', `${(1 - haki.haoCooldownFrac) * 100}%`);
  }

  meleeFlash() {
    const el = this.skillEls[0];
    el.style.transition = 'none';
    el.style.background = 'rgba(255,255,255,0.35)';
    requestAnimationFrame(() => {
      el.style.transition = 'background 0.25s ease';
      el.style.background = 'rgba(8, 16, 32, 0.6)';
    });
  }

  damageNumber(worldPos, amount, opts = {}) {
    let slot = this._dmgPool.find((d) => !d.active);
    if (!slot) {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;font-weight:800;font-size:20px;will-change:transform,opacity;' +
        'text-shadow:0 2px 5px rgba(0,0,0,0.7);letter-spacing:0.02em;';
      this._dmgLayer.appendChild(el);
      slot = { el, active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, max: 0 };
      this._dmgPool.push(slot);
    }
    slot.active = true;
    slot.pos.copy(worldPos);
    slot.vel.set((Math.random() - 0.5) * 1.4, 3.2 + Math.random(), (Math.random() - 0.5) * 1.4);
    slot.life = slot.max = 0.95;
    const crit = opts.crit;
    slot.el.textContent = crit ? `${amount}!` : `${amount}`;
    slot.el.style.color = opts.color || (crit ? '#ffd23f' : '#ffffff');
    slot.el.style.fontSize = `${crit ? 28 : 20}px`;
    slot.el.style.opacity = '1';
  }

  update(dt, camera) {
    // fps
    this._frames++;
    this._acc += dt;
    if (this._acc >= 0.5) {
      this._fps = Math.round(this._frames / this._acc);
      this._frames = 0; this._acc = 0;
    }

    // damage numbers
    const w = window.innerWidth, h = window.innerHeight;
    for (const d of this._dmgPool) {
      if (!d.active) continue;
      d.life -= dt;
      if (d.life <= 0) { d.active = false; d.el.style.opacity = '0'; continue; }
      d.vel.y -= 5 * dt;
      d.pos.addScaledVector(d.vel, dt);
      _p.copy(d.pos).project(camera);
      if (_p.z > 1) { d.el.style.opacity = '0'; continue; }
      const x = (_p.x * 0.5 + 0.5) * w;
      const y = (-_p.y * 0.5 + 0.5) * h;
      const k = d.life / d.max;
      d.el.style.transform = `translate(-50%,-50%) translate(${x}px, ${y}px) scale(${0.8 + k * 0.5})`;
      d.el.style.opacity = `${Math.min(1, k * 1.6)}`;
    }
  }

  setPerf(renderer) {
    const info = renderer.info;
    this.perf.textContent = `${this._fps} fps · ${info.render.calls} calls · ${(info.render.triangles / 1000).toFixed(0)}k tris`;
  }
}

const _p = new THREE.Vector3();
