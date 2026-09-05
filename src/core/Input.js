/**
 * Keyboard + mouse input with pointer-lock mouse-look.
 * Poll `isDown` / `justPressed` from systems; read `look` for accumulated
 * mouse delta (consumed once per frame by the camera rig).
 */
export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.pressed = new Set();      // edge: pressed this frame
    this.released = new Set();     // edge: released this frame
    this.mouse = { x: 0, y: 0, dx: 0, dy: 0 };
    this.buttons = new Set();
    this.buttonsPressed = new Set();
    this.wheel = 0;
    this.pointerLocked = false;
    this._enabled = true;

    this._onKeyDown = (e) => {
      if (!this._enabled) return;
      const c = e.code;
      if (!this.keys.has(c)) this.pressed.add(c);
      this.keys.add(c);
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    };
    this._onMouseMove = (e) => {
      if (this.pointerLocked) {
        this.mouse.dx += e.movementX;
        this.mouse.dy += e.movementY;
      }
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    };
    this._onMouseDown = (e) => {
      if (!this.buttons.has(e.button)) this.buttonsPressed.add(e.button);
      this.buttons.add(e.button);
      this.onButtonDown && this.onButtonDown(e.button);
    };
    this._onMouseUp = (e) => { this.buttons.delete(e.button); this.onButtonUp && this.onButtonUp(e.button); };
    this._onWheel = (e) => { this.wheel += Math.sign(e.deltaY); };
    this._onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
    };
    this._onContext = (e) => e.preventDefault();
    this._onBlur = () => { this.keys.clear(); this.buttons.clear(); };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    this.dom.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: true });
    document.addEventListener('pointerlockchange', this._onLockChange);
    this.dom.addEventListener('contextmenu', this._onContext);
    window.addEventListener('blur', this._onBlur);
  }

  requestPointerLock() {
    if (!this.pointerLocked) this.dom.requestPointerLock?.();
  }
  exitPointerLock() {
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  /** pointer position in normalised device coords (-1..1, y up) */
  cursorNDC() {
    return {
      x: (this.mouse.x / window.innerWidth) * 2 - 1,
      y: -(this.mouse.y / window.innerHeight) * 2 + 1
    };
  }

  isDown(code) { return this.keys.has(code); }
  justPressed(code) { return this.pressed.has(code); }
  justReleased(code) { return this.released.has(code); }
  mouseDown(btn) { return this.buttons.has(btn); }
  mouseJustPressed(btn) { return this.buttonsPressed.has(btn); }

  /** Consume the per-frame mouse delta. Call once, from the camera rig. */
  consumeLook() {
    const d = { dx: this.mouse.dx, dy: this.mouse.dy };
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    return d;
  }
  consumeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Clear per-frame edges. Call at the very end of the frame. */
  lateUpdate() {
    this.pressed.clear();
    this.released.clear();
    this.buttonsPressed.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.dom.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.dom.removeEventListener('contextmenu', this._onContext);
    window.removeEventListener('blur', this._onBlur);
  }
}
