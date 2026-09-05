import * as THREE from 'three';
import { Sky } from './Sky.js';
import { Ocean } from './Ocean.js';
import { Island } from './Island.js';
import { Arena } from './Arena.js';
import { Rain } from './Rain.js';
import { QUALITY } from '../core/quality.js';
import { ISLANDS, ISLAND_STUBS, SEA_BOUNDS } from './islands/definitions.js';

/** Assembles sky + ocean + the world body (islands, or a battleground arena). */
export class World {
  constructor(scene) {
    this.scene = scene;
    this.bounds = SEA_BOUNDS;
    this.sky = new Sky(scene);
    this.ocean = new Ocean(scene, { size: QUALITY.oceanSize, segments: QUALITY.oceanSegments });
    this.ocean.setSun(this.sky.sunDir, this.sky.uniforms.uSunColor.value);
    this.ocean.setFog(this.scene.fog.color, this.scene.fog.density);

    // weather — an endless clear/rain cycle, layered on top of the day/night
    // clock the Sky already runs on its own
    this.rain = new Rain(scene);
    this._weather = { timer: 15 + Math.random() * 15, raining: false, amount: 0 };   // short first wait so it's easy to see land quickly

    this.isArena = !!(ISLANDS[0] && ISLANDS[0].arena);

    if (this.isArena) {
      // ---- open-air arena: a big circular floor under the normal painterly sky ----
      this.arena = new Arena(scene);
      this.islands = [];
      this.mapMarkers = [];
      this.voidY = this.arena.voidY;
      this.spawn = this.arena.spawn.clone();
      this.startIsland = null;
      this.ocean.mesh.visible = false;   // the floor floats under the sky, no sea
    } else {
      this.islands = ISLANDS.map((def) => new Island(scene, def));
      this.mapMarkers = [
        ...this.islands.map((i) => ({ id: i.id, name: i.name, center: i.center.clone(), radius: i.radius, levelBand: i.levelBand, built: true })),
        ...ISLAND_STUBS.map((s) => ({ id: s.id, name: s.name, center: new THREE.Vector3().fromArray(s.center), radius: s.radius, levelBand: s.levelBand, built: false }))
      ];
      const startIsl = this.islands.find((i) => i.def.start) || this.islands[0];
      const de = startIsl.dockEnd.clone();
      const toCentre = startIsl.center.clone().sub(de).setY(0).normalize();
      const sp = de.clone().addScaledVector(toCentre, 10);
      const g = this.sampleGround(sp.x, sp.z);
      this.spawn = new THREE.Vector3(sp.x, (g.onLand ? g.height : 1.5) + 0.05, sp.z);
      this.startIsland = startIsl;
    }
  }

  /** raycast targets for the camera's collision pull-in */
  get footColliders() {
    return this.isArena ? [this.arena.collision] : this.islands.map((i) => i.terrain);
  }

  /** collect enemy/npc/boss spawn requests */
  collectSpawns() {
    if (this.isArena) return { enemies: this.arena.dummySpawns, npcs: [], bosses: [] };
    const enemies = [], npcs = [], bosses = [];
    for (const isl of this.islands) {
      enemies.push(...isl.enemySpawns);
      npcs.push(...isl.npcSpawns);
      if (isl.bossSpawn) bosses.push(isl.bossSpawn);
    }
    return { enemies, npcs, bosses };
  }

  islandAt(x, z) {
    if (this.isArena) return null;
    for (const isl of this.islands) {
      if (Math.hypot(x - isl.center.x, z - isl.center.z) < isl.radius * 1.05) return isl;
    }
    return null;
  }

  /**
   * @param {number} [fromY] pawn's current Y — lets the arena pick the right
   *   level when walkable surfaces stack. Ignored by the island heightfield.
   * @returns {{height:number,onLand:boolean,island:Island|null}}
   */
  sampleGround(x, z, fromY) {
    if (this.isArena) return this.arena.sampleGround(x, z, fromY);
    let best = -Infinity, isl = null;
    for (const island of this.islands) {
      const h = island.getHeightAt(x, z);
      if (h > best) { best = h; isl = island; }
    }
    if (best > 0.05) return { height: best, onLand: true, island: isl };
    return { height: 0, onLand: false, island: null };
  }

  waterHeight(x, z) { return this.isArena ? this.arena.waterHeight(x, z) : this.ocean.sampleHeight(x, z); }
  waterWave(x, z, target) {
    if (this.isArena) { if (target) { target.height = this.arena.waterHeight(x, z); target.normal.set(0, 1, 0); } return target; }
    return this.ocean.sampleWave(x, z, target);
  }

  /** endless clear<->rain cycle: picks a duration, ramps `amount` smoothly,
      feeds it to the rain volume + the sky's storm darkening, and throws the
      occasional lightning flash once it's raining hard. */
  _updateWeather(dt, focusPos) {
    const w = this._weather;
    w.timer -= dt;
    if (w.timer <= 0) {
      w.raining = !w.raining;
      w.timer = w.raining ? (40 + Math.random() * 70) : (90 + Math.random() * 200);
    }
    w.amount = THREE.MathUtils.damp(w.amount, w.raining ? 1 : 0, 0.15, dt);
    this.rain.setIntensity(w.amount);
    this.sky.setStormy(w.amount);
    if (w.raining && w.amount > 0.6 && Math.random() < dt * 0.06) this.sky.flashLightning();
    this.rain.update(dt, focusPos);
  }

  update(dt, elapsed, focusPos, cameraPos) {
    if (this.isArena) {
      this.sky.update(dt, elapsed, focusPos);
      this.arena.update(dt, elapsed);
      this._updateWeather(dt, focusPos);
      return;
    }
    this.sky.update(dt, elapsed, focusPos);
    {
      this.ocean.setSun(this.sky.sunDir, this.sky.uniforms.uSunColor.value);
      this.ocean.setFog(this.scene.fog.color, this.scene.fog.density);
      this.ocean.update(dt, elapsed, focusPos, cameraPos || focusPos);
      for (const island of this.islands) island.update(dt, elapsed);
      this._updateWeather(dt, focusPos);
    }
  }
}
