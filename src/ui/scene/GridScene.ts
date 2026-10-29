import * as THREE from 'three';
import type { IconSys } from '../../core';
import { PlaceholderObject, type GridVisual } from './iconObject';

/** Horizontal and vertical distance between icons, in icon units (icons are ~4 tall). */
const CELL_X = 5.6;
const CELL_Y = 5.2;
/** Rows that must fit on screen at minimum (the PS2 shows three). */
const MIN_ROWS = 1;
/** How far above its base an icon's cell extends (icons are ~4 tall). */
const CELL_TOP = 4.6;
/** Every icon is scaled so its larger side (width or height) is this tall... */
const ICON_SIZE = 3.8;
/** ...and flat placeholder tiles a bit smaller, like the PS2's generic icons. */
const TILE_SIZE = 3;
/** Widest an icon may be in x or z, so it can turn in place without hitting its neighbors. */
const MAX_SPAN = CELL_X * 0.85;
/** Height above the row's base where every icon's center sits. */
const ICON_CENTER = 2.2;
/** Depth of the glow behind the selected icon. */
const GLOW_Z = -2;
/** How fast the selected icon turns, in radians per second (a turn every ~6 s). */
/** How bright the grid stays behind the save menu, as on the PS2. */
const GRID_DIM = 0.22;
const SPIN_SPEED = 1.05;
/** Length of the copy and delete animations, in seconds. */
const ACTION_SECONDS = { copy: 1.6, delete: 1.8 } as const;

export interface GridItem {
  key: string;
  visual: GridVisual;
}

export type IconAction = keyof typeof ACTION_SECONDS;

interface RunningAction {
  kind: IconAction;
  start: number;
  /** Bring the normal icon back afterwards (false when the save is going away). */
  restore: boolean;
  done: () => void;
}

interface Entry {
  item: GridItem;
  /** Sits at the cell position. */
  holder: THREE.Group;
  /** At the icon's center: spins and scales the icon in place. */
  pivot: THREE.Group;
  /** What's on screen: the normal icon, or the copy/delete icon during an action. */
  shown: GridVisual;
  hit: THREE.Mesh;
  centerY: number;
  size: number;
  /** Current turn around the vertical axis, in radians. */
  spin: number;
  /** Extra fade from an action, multiplied into the edge fade. */
  actionOpacity: number;
  action?: RunningAction | undefined;
  /** Deleted: stays hidden until the grid gets its new list of saves. */
  gone: boolean;
  /** Time the current animation loop started, so actions play from their first frame. */
  animStart: number;
  /** Height of the pivot when the icon is at rest. */
  baseY: number;
}

/** The icon shown large on the left of the save menu (the PS2's options screen). */
interface Focus {
  entry: Entry;
  /** The grid entry whose icon object is borrowed, if any; it gets it back on clear. */
  owner?: Entry | undefined;
  /** Where the icon should sit, and how big; eased toward every frame. */
  scale: number;
}

/** Scale a visual to the common icon size and center it on its pivot. Returns its on-screen size. */
function fitVisual(visual: GridVisual): number {
  const obj = visual.object;
  // Use the model's own bounds, not setFromObject: a reused visual still carries
  // the scale, offset and parent position from the previous layout.
  const geometry = obj.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  // Same on-screen size for every icon, whatever units the game modeled it in.
  const target = visual instanceof PlaceholderObject ? TILE_SIZE : ICON_SIZE;
  const scale = Math.min(target / Math.max(size.x, size.y, 0.001), MAX_SPAN / Math.max(size.x, size.z, 0.001));
  obj.scale.setScalar(scale);
  const center = box.getCenter(new THREE.Vector3());
  obj.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  return Math.max(size.x, size.y) * scale;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

type Rgb = [number, number, number];

// The neutral backdrop of the PS2 browser: light at the top left, dark at the bottom right.
const BACKDROP: [Rgb, Rgb, Rgb, Rgb] = [
  [0.62, 0.62, 0.64],
  [0.46, 0.46, 0.48],
  [0.3, 0.3, 0.32],
  [0.12, 0.12, 0.13],
];

/** Background corners for a save: its icon.sys colors over the backdrop, like the PS2 does. */
export function backgroundFor(sys: IconSys | undefined): [Rgb, Rgb, Rgb, Rgb] {
  if (!sys) return BACKDROP;
  const alpha = Math.min(Math.max(sys.backgroundTransparency / 128, 0), 1) * 0.6;
  return BACKDROP.map((base, i) => {
    const c = sys.backgroundColors[i]!;
    return base.map((b, k) => b * (1 - alpha) + (c[k]! / 255) * alpha) as Rgb;
  }) as [Rgb, Rgb, Rgb, Rgb];
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,240,0.95)');
  grad.addColorStop(0.25, 'rgba(255,255,230,0.55)');
  grad.addColorStop(1, 'rgba(255,255,220,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The BIOS-style icon grid: one WebGL canvas for every icon, so a full card
 * doesn't run into the browser's limit on WebGL contexts.
 */
export class GridScene {
  onPick?: (index: number) => void;
  onOpen?: (index: number) => void;
  /** Called every frame with the time in seconds; Phase 3 drives animation here. */
  onFrame?: (time: number, selected: number) => void;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  private readonly bgScene = new THREE.Scene();
  private readonly bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bgColors: THREE.BufferAttribute;
  private bgTarget: [Rgb, Rgb, Rgb, Rgb] = BACKDROP;
  private readonly glow: THREE.Sprite;
  private readonly hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  private readonly hitGeometry = new THREE.PlaneGeometry(CELL_X * 0.95, CELL_Y * 0.95);
  private readonly raycaster = new THREE.Raycaster();
  private items: Entry[] = [];
  private selected = -1;
  private columns = 5;
  private cameraY = 0;
  private topRow = 0;
  private visibleRows = 3;
  /** Pixels covered by the header and footer overlays, so rows aren't drawn under them. */
  getInsets?: () => { top: number; bottom: number };
  private frame = 0;
  private glowSize = 5;
  private lastTime = 0;
  private focus?: Focus | undefined;
  /** 1 while the grid shows; dimmed behind the save menu, as on the PS2. */
  private gridFade = 1;
  private readonly reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  private readonly start = performance.now();
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;

    // Full-screen gradient quad. PlaneGeometry's vertex order is TL, TR, BL, BR.
    const bgGeometry = new THREE.PlaneGeometry(2, 2);
    this.bgColors = new THREE.BufferAttribute(new Float32Array(12), 3);
    bgGeometry.setAttribute('color', this.bgColors);
    this.setBackgroundNow(BACKDROP);
    const bgMaterial = new THREE.ShaderMaterial({
      vertexShader: 'attribute vec3 color; varying vec3 vColor; void main() { vColor = color; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'varying vec3 vColor; void main() { gl_FragColor = vec4(vColor, 1.0); }',
      depthWrite: false,
    });
    this.bgScene.add(new THREE.Mesh(bgGeometry, bgMaterial));

    this.glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.glow.scale.set(5, 5, 1);
    this.glow.visible = false;
    this.scene.add(this.glow);

    canvas.addEventListener('click', this.handleClick);
    canvas.addEventListener('dblclick', this.handleDoubleClick);
    canvas.addEventListener('wheel', this.handleWheel, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frame = requestAnimationFrame(this.render);
  }

  setItems(items: GridItem[]): void {
    const time = this.now();
    const previous = new Map(this.items.map((e) => [e.item.key, e]));
    for (const e of this.items) {
      this.finishAction(e);
      this.scene.remove(e.holder, e.hit);
    }
    this.items = items.map((item) => {
      const holder = new THREE.Group();
      const pivot = new THREE.Group();
      pivot.position.y = ICON_CENTER;
      const size = fitVisual(item.visual);
      pivot.add(item.visual.object);
      holder.add(pivot);
      const hit = new THREE.Mesh(this.hitGeometry, this.hitMaterial);
      this.scene.add(holder, hit);
      // Keep each icon's turn and animation phase across re-sorts.
      const old = previous.get(item.key);
      const spin = old?.spin ?? 0;
      pivot.rotation.y = spin;
      return {
        item,
        holder,
        pivot,
        shown: item.visual,
        hit,
        centerY: ICON_CENTER,
        size,
        spin,
        actionOpacity: 1,
        gone: false,
        animStart: old?.animStart ?? time,
        baseY: ICON_CENTER,
      };
    });
    this.layout();
    this.selected = Math.min(this.selected, items.length - 1);
    this.updateSelection();
  }

  /**
   * Play the save's copy or delete animation, showing `visual` (its copy or
   * delete icon) meanwhile. Resolves when it's over. With `restore` false the
   * icon stays hidden, for a save that is about to be removed from the grid.
   */
  playAction(index: number, kind: IconAction, visual: GridVisual, restore = true): Promise<void> {
    const e = this.items[index];
    if (!e) return Promise.resolve();
    this.finishAction(e);
    e.gone = false;
    if (visual !== e.shown) this.show(e, visual);
    return new Promise((resolve) => {
      e.animStart = this.now();
      e.action = { kind, start: this.now(), restore, done: resolve };
    });
  }

  /**
   * Open the save menu look: fade the grid out and show `visual` large on the
   * left (on top on narrow screens). With `ownerIndex`, the icon flies there
   * from its place in the grid. Calling again swaps the icon (e.g. to the
   * delete icon) without moving it.
   */
  setFocus(visual: GridVisual, ownerIndex?: number): void {
    if (this.focus) {
      if (this.focus.entry.action) this.finishAction(this.focus.entry);
      if (visual !== this.focus.entry.shown) this.show(this.focus.entry, visual);
      return;
    }
    const owner = ownerIndex === undefined ? undefined : this.items[ownerIndex];
    const holder = new THREE.Group();
    const pivot = new THREE.Group();
    holder.add(pivot);
    this.scene.add(holder);
    const size = fitVisual(visual);
    pivot.add(visual.object);
    const target = this.focusTarget();
    if (owner) {
      // Start where the icon is in the grid, at its grid size.
      holder.position.set(owner.holder.position.x, owner.holder.position.y + owner.centerY, 0);
      holder.scale.setScalar(1);
    } else {
      holder.position.copy(target.position);
      holder.scale.setScalar(0.001);
    }
    const spin = owner?.spin ?? 0;
    pivot.rotation.y = spin;
    visual.setHighlight(0);
    this.focus = {
      owner: owner && owner.shown === visual ? owner : undefined,
      scale: target.scale,
      entry: {
        item: { key: '__focus__', visual },
        holder,
        pivot,
        shown: visual,
        hit: owner?.hit ?? new THREE.Mesh(),
        centerY: 0,
        size,
        spin,
        actionOpacity: 1,
        gone: false,
        animStart: owner?.animStart ?? this.now(),
        baseY: 0,
      },
    };
  }

  /** Back to the grid. */
  clearFocus(): void {
    const focus = this.focus;
    if (!focus) return;
    if (focus.entry.action) focus.entry.action.done();
    this.scene.remove(focus.entry.holder);
    if (focus.entry.shown.object.parent === focus.entry.pivot) focus.entry.pivot.remove(focus.entry.shown.object);
    // Give borrowed icons back to their place in the grid.
    for (const e of this.items) {
      if (e.shown.object.parent !== e.pivot) {
        fitVisual(e.shown);
        e.pivot.add(e.shown.object);
        e.shown.setHighlight(this.items[this.selected] === e ? 0.25 : 0);
      }
    }
    this.focus = undefined;
  }

  /**
   * Play the copy or delete animation on the focused icon. With `restore`
   * false the icon stays hidden afterwards (a deleted save).
   */
  playFocusAction(kind: IconAction, restore = true): Promise<void> {
    const e = this.focus?.entry;
    if (!e) return Promise.resolve();
    if (e.action) this.finishAction(e);
    e.gone = false;
    return new Promise<void>((resolve) => {
      e.animStart = this.now();
      e.action = { kind, start: this.now(), restore, done: resolve };
    });
  }

  get focused(): boolean {
    return this.focus !== undefined;
  }

  setSelected(index: number): void {
    this.selected = index;
    this.updateSelection();
  }

  setBackground(colors: [Rgb, Rgb, Rgb, Rgb]): void {
    this.bgTarget = colors;
  }

  get columnCount(): number {
    return this.columns;
  }

  /** The icon object at an index, for animation. */
  visualAt(index: number): GridVisual | undefined {
    return this.items[index]?.shown;
  }

  holderAt(index: number): THREE.Group | undefined {
    return this.items[index]?.holder;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    for (const e of this.items) e.action?.done();
    this.focus?.entry.action?.done();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('dblclick', this.handleDoubleClick);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.hitGeometry.dispose();
    this.hitMaterial.dispose();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------ internals

  private cellPosition(index: number): THREE.Vector3 {
    const col = index % this.columns;
    const row = Math.floor(index / this.columns);
    return new THREE.Vector3((col - (this.columns - 1) / 2) * CELL_X, -row * CELL_Y, 0);
  }

  private layout(): void {
    this.items.forEach(({ holder, hit }, i) => {
      const p = this.cellPosition(i);
      holder.position.copy(p);
      hit.position.set(p.x, p.y + ICON_CENTER, 1);
    });
  }

  private updateSelection(): void {
    this.items.forEach((e, i) => e.shown.setHighlight(i === this.selected ? 0.25 : 0));
    const sel = this.items[this.selected];
    this.glow.visible = !!sel;
    if (sel) {
      // The PS2 browser lights the selected icon from behind.
      this.glowSize = Math.min(Math.max(sel.size * 1.4, 3.5), 6);
      // Keep the selected row inside the visible rows.
      const row = Math.floor(this.selected / this.columns);
      if (row < this.topRow) this.topRow = row;
      if (row >= this.topRow + this.visibleRows) this.topRow = row - this.visibleRows + 1;
    }
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const columns = w < 560 ? 3 : w < 820 ? 4 : 5;
    if (columns !== this.columns) {
      this.columns = columns;
      this.layout();
      this.updateSelection();
    }
    // Pull the camera back until the grid's width and its visible rows both fit,
    // leaving room for the header and footer overlays.
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const fitWidth = (this.columns * CELL_X) / 2 / Math.tan(hFov / 2);
    const fitHeight = (MIN_ROWS * CELL_Y) / 2 / Math.tan(vFov / 2);
    this.camera.position.z = Math.max(fitWidth, fitHeight);
    this.camera.updateProjectionMatrix();
    this.updateVisibleRows();
  }

  /**
   * The glow sits behind the selected icon. Put it on the line from the camera
   * through the icon's center, so perspective doesn't shift it off to the side,
   * and grow it with the extra distance so it looks the same size.
   */
  private placeGlow(): void {
    const sel = this.items[this.selected];
    if (!sel) return;
    const cam = this.camera.position;
    const center = new THREE.Vector3(sel.holder.position.x, sel.holder.position.y + sel.centerY, 0);
    const t = (cam.z - GLOW_Z) / cam.z;
    this.glow.position.copy(cam).lerp(center, t);
    const size = this.glowSize * t;
    this.glow.scale.set(size, size, 1);
  }

  /** Fade icons out as they move under the header or footer. */
  private fadeEdges(worldHeight: number, px: number, top: number): void {
    const unitsPerPx = worldHeight / px;
    const screenTop = this.cameraY + worldHeight / 2;
    const bandTop = screenTop - top * unitsPerPx; // world y of the header's bottom edge
    const bandBottom = screenTop - (px - this.insets().bottom) * unitsPerPx;
    const fade = 1.0; // world units over which an icon fades
    const edge = (y: number) => clamp01(1 - Math.max(y - bandTop, bandBottom - y) / fade);
    const focusObject = this.focus?.entry.shown.object;
    this.items.forEach((e) => {
      if (e.shown.object === focusObject) return; // shown large in the save menu
      e.shown.setOpacity(edge(e.holder.position.y + e.centerY) * e.actionOpacity * this.gridFade);
    });
    const sel = this.items[this.selected];
    if (sel) {
      (this.glow.material as THREE.SpriteMaterial).opacity =
        edge(sel.holder.position.y + sel.centerY) * sel.actionOpacity * clamp01((this.gridFade - GRID_DIM) / (1 - GRID_DIM));
    }
  }

  private insets(): { top: number; bottom: number } {
    return this.getInsets?.() ?? { top: 110, bottom: 90 };
  }

  /** World units visible from top to bottom at the grid's depth. */
  private worldHeight(): number {
    return 2 * this.camera.position.z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
  }

  /** How many whole rows fit between the header and footer. */
  private updateVisibleRows(): void {
    const px = this.canvas.clientHeight;
    if (!px) return;
    const { top, bottom } = this.insets();
    const usable = (this.worldHeight() * Math.max(px - top - bottom, 0)) / px;
    const rows = Math.max(1, Math.floor(usable / CELL_Y));
    if (rows !== this.visibleRows) {
      this.visibleRows = rows;
      this.updateSelection();
    }
  }

  private setBackgroundNow(colors: [Rgb, Rgb, Rgb, Rgb]): void {
    colors.forEach((c, i) => this.bgColors.setXYZ(i, c[0], c[1], c[2]));
    this.bgColors.needsUpdate = true;
  }

  private render = (now: number): void => {
    this.frame = requestAnimationFrame(this.render);
    const time = this.now(now);

    // Ease the background toward the selected save's colors.
    const arr = this.bgColors.array as Float32Array;
    this.bgTarget.forEach((c, i) => {
      for (let k = 0; k < 3; k++) arr[i * 3 + k]! += (c[k]! - arr[i * 3 + k]!) * 0.12;
    });
    this.bgColors.needsUpdate = true;

    // Ease the camera so the top visible row starts just below the header.
    this.updateVisibleRows();
    const h = this.worldHeight();
    const px = this.canvas.clientHeight || 1;
    const top = this.insets().top;
    const rowTop = -this.topRow * CELL_Y + CELL_TOP;
    const targetY = rowTop - h / 2 + (top / px) * h;
    this.cameraY += (targetY - this.cameraY) * 0.15;
    this.camera.position.y = this.cameraY;
    this.camera.lookAt(0, this.cameraY, 0);
    this.placeGlow();
    this.fadeEdges(h, px, top);

    const dt = Math.min(time - this.lastTime, 0.1);
    this.lastTime = time;
    this.gridFade += ((this.focus ? GRID_DIM : 1) - this.gridFade) * Math.min(1, dt * 8);
    this.animateIcons(time, dt);
    this.animateFocus(time, dt);
    this.onFrame?.(time, this.selected);

    this.renderer.clear();
    this.renderer.render(this.bgScene, this.bgCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  };

  private now(at = performance.now()): number {
    return (at - this.start) / 1000;
  }

  /** Swap what an entry shows (its normal icon or its copy/delete icon). */
  private show(e: Entry, visual: GridVisual): void {
    e.pivot.remove(e.shown.object);
    e.size = fitVisual(visual);
    e.pivot.add(visual.object);
    e.shown = visual;
    visual.setHighlight(this.items[this.selected] === e ? 0.25 : 0);
    if (this.items[this.selected] === e) this.glowSize = Math.min(Math.max(e.size * 1.4, 3.5), 6);
  }

  private finishAction(e: Entry): void {
    const action = e.action;
    if (!action) return;
    e.action = undefined;
    if (action.restore) {
      // Back to the normal icon; animateIcons eases it back to full size.
      if (e.shown !== e.item.visual) this.show(e, e.item.visual);
      e.pivot.position.y = e.baseY;
      e.centerY = e.baseY;
    } else {
      e.gone = true;
      e.actionOpacity = 0;
    }
    action.done();
  }

  /** Idle animation for every visible icon, the selected icon's turn, and copy/delete actions. */
  private animateIcons(time: number, dt: number): void {
    this.items.forEach((e, i) => {
      const visible = e.actionOpacity > 0 && e.shown.object.visible;
      if (e.action) this.stepAction(e, time);
      else if (!e.gone) {
        // The selected icon turns; the others ease back to face the front.
        if (i === this.selected && !this.reducedMotion) e.spin += dt * SPIN_SPEED;
        else {
          const rest = Math.round(e.spin / (2 * Math.PI)) * 2 * Math.PI;
          e.spin += (rest - e.spin) * Math.min(1, dt * 6);
        }
        e.pivot.rotation.y = e.spin;
        // Grow back in after a previewed delete.
        const k = Math.min(1, dt * 8);
        e.pivot.scale.setScalar(e.pivot.scale.x + (1 - e.pivot.scale.x) * k);
        e.actionOpacity += (1 - e.actionOpacity) * k;
      }
      if (visible && (!this.reducedMotion || e.action)) e.shown.animate(time - e.animStart);
    });
  }

  /**
   * Copy: the icon hops up and turns once. Delete: it lifts, spins faster and
   * shrinks away. Both play the icon's own animation from its first frame.
   */
  private stepAction(e: Entry, time: number): void {
    const action = e.action!;
    const t = clamp01((time - action.start) / ACTION_SECONDS[action.kind]);
    if (action.kind === 'copy') {
      const hop = Math.sin(t * Math.PI);
      e.pivot.position.y = e.baseY + hop * 1.2;
      e.pivot.rotation.y = e.spin + easeInOut(t) * 2 * Math.PI;
      e.pivot.scale.setScalar(1 + hop * 0.12);
    } else {
      const lift = easeInOut(clamp01(t / 0.35));
      const vanish = easeInOut(clamp01((t - 0.35) / 0.65));
      e.pivot.position.y = e.baseY + lift * 0.8 - vanish * 2.5;
      e.pivot.rotation.y = e.spin + (t * t) * 4 * Math.PI;
      e.pivot.scale.setScalar(Math.max(1 - vanish, 0.001));
      e.actionOpacity = 1 - vanish;
    }
    e.centerY = e.pivot.position.y;
    if (t >= 1) {
      e.spin = e.pivot.rotation.y % (2 * Math.PI);
      this.finishAction(e);
    }
  }

  /** Where the focused icon goes: left of center on wide screens, above the text on narrow ones. */
  private focusTarget(): { position: THREE.Vector3; scale: number } {
    const h = this.worldHeight();
    const w = h * this.camera.aspect;
    const narrow = this.camera.aspect < 0.9;
    const size = narrow ? Math.min(w * 0.5, h * 0.26) : Math.min(h * 0.42, w * 0.3);
    const position = narrow
      ? new THREE.Vector3(0, this.cameraY + h * 0.17, 0)
      : new THREE.Vector3(-w * 0.24, this.cameraY - h * 0.02, 0);
    return { position, scale: size / ICON_SIZE };
  }

  private animateFocus(time: number, dt: number): void {
    const focus = this.focus;
    if (!focus) return;
    const e = focus.entry;
    const target = this.focusTarget();
    const k = Math.min(1, dt * 7);
    e.holder.position.lerp(target.position, k);
    e.holder.scale.setScalar(e.holder.scale.x + (target.scale - e.holder.scale.x) * k);
    if (e.action) this.stepAction(e, time);
    else if (!e.gone) {
      if (!this.reducedMotion) e.spin += dt * SPIN_SPEED;
      e.pivot.rotation.y = e.spin;
      e.pivot.scale.setScalar(e.pivot.scale.x + (1 - e.pivot.scale.x) * k);
      e.actionOpacity += (1 - e.actionOpacity) * k;
    }
    e.shown.setOpacity(e.gone ? 0 : e.actionOpacity);
    if (!this.reducedMotion || e.action) e.shown.animate(time - e.animStart);
  }

  private pick(event: MouseEvent): number {
    if (this.focus) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.items.map((i) => i.hit));
    return hits.length ? this.items.findIndex((i) => i.hit === hits[0]!.object) : -1;
  }

  private handleClick = (event: MouseEvent): void => {
    const i = this.pick(event);
    if (i >= 0) this.onPick?.(i);
  };

  private wheelAccum = 0;

  /** Scroll rows without changing the selection. */
  private handleWheel = (event: WheelEvent): void => {
    if (this.focus) return;
    this.wheelAccum += event.deltaY;
    if (Math.abs(this.wheelAccum) < 60) return;
    const step = Math.sign(this.wheelAccum);
    this.wheelAccum = 0;
    const rows = Math.ceil(this.items.length / this.columns);
    this.topRow = Math.min(Math.max(this.topRow + step, 0), Math.max(rows - this.visibleRows, 0));
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    const i = this.pick(event);
    if (i >= 0) this.onOpen?.(i);
  };
}
