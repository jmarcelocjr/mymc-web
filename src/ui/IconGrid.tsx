import { useEffect, useRef, type RefObject } from 'react';
import { parseIcon, parseIconSys, type ArchiveNode, type MemoryCard, type SaveSummary } from '../core';
import { GridScene, backgroundFor, type IconAction } from './scene/GridScene';
import { IconObject, PlaceholderObject, type GridVisual } from './scene/iconObject';

type IconState = 'normal' | IconAction;

/** One of the save's 3D icons, or a flat tile when it has none or it can't be read. */
function buildVisual(card: MemoryCard, save: SaveSummary, state: IconState): GridVisual {
  if (save.readable && save.iconSys) {
    try {
      const model = parseIcon(card.readFile(`/${save.name}/${save.iconSys.icons[state]}`));
      if (model.vertexCount > 0) return new IconObject(model, save.iconSys);
    } catch {
      // Fall through to the placeholder.
    }
    return new PlaceholderObject('unknown');
  }
  return new PlaceholderObject(save.readable ? save.kind : 'unknown');
}

/** A save that isn't on the card yet (being imported): its icon from its own files. */
function buildNodeVisual(node: ArchiveNode, state: IconState): GridVisual {
  const files = node.dir?.children ?? [];
  try {
    const sysFile = files.find((f) => f.name === 'icon.sys' && f.data);
    if (sysFile) {
      const sys = parseIconSys(sysFile.data!);
      const ico = files.find((f) => f.name === sys.icons[state] && f.data);
      if (ico) {
        const model = parseIcon(ico.data!);
        if (model.vertexCount > 0) return new IconObject(model, sys);
      }
    }
  } catch {
    // Fall through to the placeholder.
  }
  return new PlaceholderObject(sysFileKind(node));
}

const sysFileKind = (node: ArchiveNode) => (node.dir?.children.some((f) => f.name === 'icon.sys') ? 'unknown' : 'ps1');

/** Cache key for a save's icon: saves often use one file for all three states. */
function visualKey(save: SaveSummary, state: IconState): string {
  return `${save.name}/${save.iconSys?.icons[state] ?? ''}`;
}

/** What the rest of the app can ask of the grid. */
export interface GridApi {
  /**
   * Play a save's copy or delete animation; resolves when it's done. With
   * `restore` false the icon stays hidden, for a save that's being removed.
   */
  playAction(name: string, kind: IconAction, restore?: boolean): Promise<void>;
  /** Fade the grid and show a save's icon large on the left (the PS2's save menu). */
  focusSave(name: string, state?: IconState): void;
  /** The same for a save that isn't on the card yet. */
  focusNode(node: ArchiveNode, state?: IconState): void;
  /** Play the copy or delete animation on the large icon. */
  playFocusAction(kind: IconAction, restore?: boolean): Promise<void>;
  /** Back to the grid. */
  clearFocus(): void;
}

interface Props {
  card: MemoryCard;
  saves: SaveSummary[];
  selected: number;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  onColumns: (columns: number) => void;
  apiRef?: RefObject<GridApi | null>;
}

export function IconGrid({ card, saves, selected, onSelect, onOpen, onColumns, apiRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<GridScene | null>(null);
  const visualForRef = useRef<(save: SaveSummary, state: IconState) => GridVisual>(null!);
  const savesRef = useRef(saves);
  const callbacks = useRef({ onSelect, onOpen, onColumns });
  useEffect(() => {
    callbacks.current = { onSelect, onOpen, onColumns };
  });

  // One scene per card. Visuals are built lazily and freed with the scene.
  useEffect(() => {
    const scene = new GridScene(canvasRef.current!);
    const visuals = new Map<string, GridVisual>();
    sceneRef.current = scene;
    // Keep rows clear of the header and footer, whatever size they wrap to.
    const screen = canvasRef.current!.parentElement!;
    scene.getInsets = () => {
      const info = screen.querySelector<HTMLElement>('.card-info');
      const footer = screen.querySelector<HTMLElement>('.hud-bottom');
      return {
        top: info ? info.offsetTop + info.offsetHeight + 8 : 110,
        bottom: footer ? footer.offsetHeight + 8 : 90,
      };
    };
    const visualFor = (save: SaveSummary, state: IconState): GridVisual => {
      const key = visualKey(save, state);
      let visual = visuals.get(key);
      if (!visual) {
        visual = buildVisual(card, save, state);
        visuals.set(key, visual);
      }
      return visual;
    };
    visualForRef.current = visualFor;
    if (apiRef) {
      apiRef.current = {
        playAction: (name, kind, restore = true) => {
          const index = savesRef.current.findIndex((s) => s.name === name);
          const save = savesRef.current[index];
          if (!save) return Promise.resolve();
          return scene.playAction(index, kind, visualFor(save, kind), restore);
        },
        focusSave: (name, state = 'normal') => {
          const index = savesRef.current.findIndex((s) => s.name === name);
          const save = savesRef.current[index];
          if (save) scene.setFocus(visualFor(save, state), index);
        },
        focusNode: (node, state = 'normal') => {
          // Built fresh each time; freed with the scene.
          const visual = buildNodeVisual(node, state);
          visuals.set(`__import__/${visuals.size}`, visual);
          scene.setFocus(visual);
        },
        playFocusAction: (kind, restore = true) => scene.playFocusAction(kind, restore),
        clearFocus: () => scene.clearFocus(),
      };
    }
    scene.onPick = (i) => callbacks.current.onSelect(i);
    scene.onOpen = (i) => callbacks.current.onOpen(i);
    let columns = 0;
    scene.onFrame = () => {
      if (scene.columnCount !== columns) {
        columns = scene.columnCount;
        callbacks.current.onColumns(columns);
      }
    };
    return () => {
      scene.dispose();
      visuals.forEach((v) => v.dispose());
      sceneRef.current = null;
      if (apiRef) apiRef.current = null;
    };
  }, [card, apiRef]);

  useEffect(() => {
    savesRef.current = saves;
    const visualFor = visualForRef.current;
    sceneRef.current!.setItems(saves.map((save) => ({ key: save.name, visual: visualFor(save, 'normal') })));
  }, [card, saves]);

  useEffect(() => {
    sceneRef.current!.setSelected(selected);
    sceneRef.current!.setBackground(backgroundFor(saves[selected]?.iconSys));
  }, [selected, saves]);

  return <canvas ref={canvasRef} className="grid-canvas" aria-label="Saves on the memory card" />;
}
