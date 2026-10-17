/* A small director for the landing page's scripted product demos (port of
   legacy/public/landing-stage.js). A demo is an async script of waits and Web
   Animations. The stage owns the clock, so one script can be paused,
   cancelled, replayed, and held while it is offscreen or the tab is hidden. */

// Spatial moves get the long, soft curve; state changes get the short one.
export const EASE = { move: 'cubic-bezier(.32,.72,0,1)', state: 'cubic-bezier(.25,1,.5,1)' };
const CANCELLED = Symbol('cancelled');

export interface StageCtx {
  wait(ms: number): Promise<void>;
  to(el: Element, props: Record<string, string | number>, ms?: number, opts?: { ease?: string; delay?: number }): Promise<void>;
  tween(ms: number, draw: (p: number) => void, ease?: (x: number) => number): Promise<void>;
  alive(): void;
  fork<T>(p: Promise<T>): Promise<T | void>;
}
type Script = (c: StageCtx) => Promise<unknown>;

export interface Stage {
  readonly reduced: boolean;
  readonly paused: boolean;
  readonly finished: boolean;
  play(script: Script): void;
  stop(): void;
  loop(script: Script, opts?: { hold?: number; rewind?: Script }): void;
  pause(): void;
  resume(): void;
  toggle(): void;
  whenVisible(start: () => void): void;
  destroy(): void;
}

export function createStage(root: HTMLElement, { reduced = false, onChange = (_: { paused: boolean; finished: boolean; started: boolean }) => {} } = {}): Stage {
  let run = 0, userPaused = false, visible = false, started = false, finished = false, autoStart: (() => void) | null = null;
  const live = new Set<Animation>();
  const held = () => userPaused || !visible || document.hidden;
  const notify = () => onChange({ paused: userPaused, finished, started });
  // Everything in the stage freezes together: scripted moves and CSS transitions alike.
  function sync() {
    for (const a of new Set([...live, ...root.getAnimations({ subtree: true })])) {
      if (held()) a.pause();
      else if (a.playState === 'paused') a.play();
    }
  }
  function context(id: number): StageCtx {
    const alive = () => { if (id !== run) throw CANCELLED; };
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      let left = ms, last = performance.now();
      const tick = (now: number) => {
        if (id !== run) return reject(CANCELLED);
        if (!held()) left -= now - last;
        last = now;
        if (left <= 0) resolve(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Animate from wherever the element is to `props`, then keep them as inline style.
    async function to(el: Element, props: Record<string, string | number>, ms = 300, { ease = EASE.state, delay = 0 } = {}) {
      alive();
      const a = el.animate([props as Keyframe], { duration: ms, delay, easing: ease, fill: 'forwards' });
      live.add(a);
      if (held()) a.pause();
      try { await a.finished; } catch { live.delete(a); throw CANCELLED; }
      live.delete(a);
      Object.assign((el as HTMLElement).style, props);
      a.cancel();
      alive();
    }
    // A value tween for things CSS cannot interpolate, such as SVG points.
    async function tween(ms: number, draw: (p: number) => void, ease = (x: number) => 1 - Math.pow(1 - x, 3)) {
      let spent = 0, last = performance.now();
      draw(0);
      while (spent < ms) {
        await new Promise((r) => requestAnimationFrame(r));
        alive();
        const now = performance.now();
        if (!held()) spent += now - last;
        last = now;
        draw(ease(Math.min(1, spent / ms)));
      }
    }
    return { wait, to, tween, alive, fork: (p) => p.catch((err) => { if (err !== CANCELLED) throw err; }) };
  }
  const io = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1]!.isIntersecting;
    if (visible && autoStart && !started) { const start = autoStart; autoStart = null; start(); }
    sync();
  }, { threshold: 0.35 });
  io.observe(root);
  document.addEventListener('visibilitychange', sync);
  const stage: Stage = {
    reduced,
    get paused() { return userPaused; },
    get finished() { return finished; },
    play(script) {
      const id = ++run;
      for (const a of live) a.cancel();
      live.clear();
      userPaused = false; started = true; finished = false;
      notify();
      script(context(id)).then(() => { if (id === run) { finished = true; notify(); } }, (err) => { if (err !== CANCELLED) console.warn(err); });
    },
    stop() { run++; for (const a of live) a.cancel(); live.clear(); finished = true; notify(); },
    loop(script, { hold = 2000, rewind } = {}) {
      stage.play(async (c) => {
        for (;;) {
          await script(c);
          await c.wait(hold);
          if (rewind) await rewind(c);
        }
      });
    },
    pause() { userPaused = true; sync(); notify(); },
    resume() { userPaused = false; sync(); notify(); },
    toggle() { if (userPaused) stage.resume(); else stage.pause(); },
    whenVisible(start) { autoStart = start; if (visible && !started) { autoStart = null; start(); } },
    destroy() { run++; for (const a of live) a.cancel(); live.clear(); io.disconnect(); document.removeEventListener('visibilitychange', sync); },
  };
  return stage;
}

export interface Cursor {
  el: HTMLDivElement;
  point(target: Element | { x: number; y: number }, fx?: number, fy?: number): { x: number; y: number };
  set(target: Element | { x: number; y: number }, fx?: number, fy?: number): void;
  show(c: StageCtx, ms?: number): Promise<void>;
  hide(c: StageCtx, ms?: number): Promise<void>;
  move(c: StageCtx, target: Element | { x: number; y: number }, ms?: number, fx?: number, fy?: number): Promise<void>;
  press(c: StageCtx): Promise<void>;
}

/* A pointer that lives inside the demo. It never touches the visitor's own cursor. */
export function createCursor(host: HTMLElement): Cursor {
  const el = document.createElement('div');
  el.className = 'lp-demo-cursor';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5 3l14 8.2-6.3 1.6L9.6 19z" fill="#0C2620" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  host.append(el);
  let at = { x: 0, y: 0 };
  const point = (target: Element | { x: number; y: number }, fx = 0.5, fy = 0.5) => {
    if (!(target instanceof Element)) return target;
    const h = host.getBoundingClientRect(), r = target.getBoundingClientRect();
    return { x: r.left - h.left + r.width * fx, y: r.top - h.top + r.height * fy };
  };
  const place = (p: { x: number; y: number }) => `translate(${p.x}px,${p.y}px)`;
  return {
    el, point,
    set(target, fx, fy) { at = point(target, fx, fy); el.style.transform = place(at); },
    show: (c, ms = 200) => c.to(el, { opacity: 1 }, ms),
    hide: (c, ms = 250) => c.to(el, { opacity: 0 }, ms),
    async move(c, target, ms = 620, fx, fy) { at = point(target, fx, fy); await c.to(el, { transform: place(at) }, ms, { ease: EASE.move }); },
    async press(c) { el.classList.add('is-down'); await c.wait(130); el.classList.remove('is-down'); },
  };
}

/* CSS matrix3d that maps a w×h box (origin at its top-left) onto four points,
   given in the order top-left, top-right, bottom-right, bottom-left. */
export function quadMatrix(w: number, h: number, q: Array<[number, number]>) {
  const src: Array<[number, number]> = [[0, 0], [w, 0], [w, h], [0, h]];
  const m: number[][] = [];
  src.forEach(([x, y], i) => {
    const [u, v] = q[i]!;
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  for (let i = 0; i < 8; i++) {
    let p = i;
    for (let r = i + 1; r < 8; r++) if (Math.abs(m[r]![i]!) > Math.abs(m[p]![i]!)) p = r;
    [m[i], m[p]] = [m[p]!, m[i]!];
    for (let r = 0; r < 8; r++) {
      if (r === i) continue;
      const f = m[r]![i]! / m[i]![i]!;
      for (let k = i; k < 9; k++) m[r]![k]! -= f * m[i]![k]!;
    }
  }
  const [a, b, c, d, e, f, g, k] = m.map((row, i) => row[8]! / row[i]!);
  return `matrix3d(${[a, d, 0, g, b, e, 0, k, 0, 0, 1, 0, c, f, 0, 1].join(',')})`;
}

export interface TourApi { stage: Stage; cursor: Cursor | null; takeover(): void; start(): void; readonly manual: boolean; destroy(): void }
export interface TourScriptArgs { c: StageCtx; tap: (c: StageCtx, target: string | Element, o?: { ms?: number; wait?: number }) => Promise<void>; say: (label: string) => void; cursor: Cursor; el: HTMLElement }

/* A guided loop: the section's real controls are worked on a loop while a
   caption says what is happening, and the visitor can take over at any time.
   `pointer`: 'cursor' (demo pointer), 'touch' (fingertip in a phone) or 'none'. */
export function createTour(el: HTMLElement, { t, reduced = false, pointer = 'none', manualHint, script, rewind, hold = 1800, onTakeover }: {
  t: (s: string) => string; reduced?: boolean; pointer?: 'none' | 'cursor' | 'touch'; manualHint: string;
  script: (a: TourScriptArgs) => Promise<unknown>; rewind?: (a: TourScriptArgs) => Promise<unknown>; hold?: number; onTakeover?: () => void;
}): TourApi {
  const bar = el.querySelector<HTMLElement>('[data-guide]')!;
  bar.classList.add('lp-guide');
  bar.innerHTML = `<button type="button" class="lp-guide-toggle" data-guide-act="toggle"></button><span class="lp-guide-text"></span><span class="lp-guide-hint"></span><button type="button" class="lp-guide-resume" data-guide-act="resume"></button>`;
  bar.querySelector('.lp-guide-hint')!.textContent = t(manualHint);
  bar.querySelector('.lp-guide-resume')!.textContent = t('Resume demo');
  const text = bar.querySelector<HTMLElement>('.lp-guide-text')!, toggle = bar.querySelector<HTMLButtonElement>('.lp-guide-toggle')!;
  const cursor = pointer === 'none' ? null : createCursor(el);
  if (pointer === 'touch') cursor!.el.classList.add('is-touch');
  let manual = reduced;
  const stage = createStage(el, { reduced, onChange: () => paint() });
  function paint() {
    bar.dataset.state = reduced ? 'still' : manual ? 'manual' : stage.paused ? 'paused' : 'auto';
    toggle.setAttribute('aria-label', stage.paused ? t('Play demo') : t('Pause demo'));
    if (manual) text.textContent = t('Your turn');
  }
  const say = (label: string) => {
    if (manual) return;
    text.textContent = t(label);
    text.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE.state });
  };
  const find = (target: string | Element) => (typeof target === 'string' ? el.querySelector(target) : target);
  // Show the press on a control, then click it exactly as a visitor would.
  async function tap(c: StageCtx, target: string | Element, { ms = 560, wait = 220 } = {}) {
    const node = find(target);
    if (!node) return;
    if (cursor) await cursor.move(c, node, ms);
    node.classList.add('lp-tapped');
    if (cursor) await cursor.press(c); else await c.wait(170);
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    setTimeout(() => el.querySelectorAll('.lp-tapped').forEach((n) => n.classList.remove('lp-tapped')), 460);
    await c.wait(wait);
  }
  const args = (c: StageCtx): TourScriptArgs => ({ c, tap, say, cursor: cursor!, el });
  function start() {
    manual = false;
    if (cursor) cursor.el.style.opacity = '';
    stage.loop(async (c) => {
      if (cursor) { cursor.set(el, 0.5, 0.6); await cursor.show(c, 180); }
      await script(args(c));
    }, { hold, rewind: rewind && ((c) => rewind(args(c))) });
    paint();
  }
  function takeover() {
    if (manual) return;
    manual = true;
    stage.stop();
    if (cursor) cursor.el.style.opacity = '0';
    el.querySelectorAll('.lp-tapped').forEach((n) => n.classList.remove('lp-tapped'));
    onTakeover?.();
    paint();
  }
  const onBar = (ev: Event) => {
    const act = (ev.target as Element).closest<HTMLElement>('[data-guide-act]')?.dataset.guideAct;
    if (act === 'toggle') stage.toggle();
    if (act === 'resume') start();
  };
  const onDown = (ev: PointerEvent) => { if (ev.isTrusted && !bar.contains(ev.target as Node) && (ev.target as Element).closest('button,a,input,[data-object-id],[role=button]')) takeover(); };
  const onKey = (ev: KeyboardEvent) => { if (ev.isTrusted && !bar.contains(ev.target as Node) && (ev.key === 'Enter' || ev.key === ' ')) takeover(); };
  bar.addEventListener('click', onBar);
  el.addEventListener('pointerdown', onDown, true);
  el.addEventListener('keydown', onKey, true);
  paint();
  if (!reduced) stage.whenVisible(start);
  return {
    stage, cursor, takeover, start, get manual() { return manual; },
    destroy() {
      stage.destroy();
      bar.removeEventListener('click', onBar);
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('keydown', onKey, true);
      cursor?.el.remove();
      bar.innerHTML = '';
    },
  };
}
