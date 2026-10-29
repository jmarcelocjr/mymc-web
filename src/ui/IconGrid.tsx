import { useEffect, useRef } from 'react';
import { parseIcon, type MemoryCard, type SaveSummary } from '../core';
import { GridScene, backgroundFor } from './scene/GridScene';
import { IconObject, PlaceholderObject, type GridVisual } from './scene/iconObject';

/** The save's 3D icon, or a flat tile when it has none or it can't be read. */
function buildVisual(card: MemoryCard, save: SaveSummary): GridVisual {
  if (save.readable && save.iconSys) {
    try {
      const model = parseIcon(card.readFile(`/${save.name}/${save.iconSys.icons.normal}`));
      if (model.vertexCount > 0) return new IconObject(model, save.iconSys);
    } catch {
      // Fall through to the placeholder.
    }
    return new PlaceholderObject('unknown');
  }
  return new PlaceholderObject(save.readable ? save.kind : 'unknown');
}

interface Props {
  card: MemoryCard;
  saves: SaveSummary[];
  selected: number;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  onColumns: (columns: number) => void;
}

export function IconGrid({ card, saves, selected, onSelect, onOpen, onColumns }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<GridScene | null>(null);
  const visualsRef = useRef(new Map<string, GridVisual>());
  const callbacks = useRef({ onSelect, onOpen, onColumns });
  useEffect(() => {
    callbacks.current = { onSelect, onOpen, onColumns };
  });

  // One scene per card. Visuals are built lazily and freed with the scene.
  useEffect(() => {
    const scene = new GridScene(canvasRef.current!);
    const visuals = new Map<string, GridVisual>();
    sceneRef.current = scene;
    visualsRef.current = visuals;
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
    };
  }, [card]);

  useEffect(() => {
    const scene = sceneRef.current!;
    const visuals = visualsRef.current;
    scene.setItems(
      saves.map((save) => {
        let visual = visuals.get(save.name);
        if (!visual) {
          visual = buildVisual(card, save);
          visuals.set(save.name, visual);
        }
        return { key: save.name, visual };
      }),
    );
  }, [card, saves]);

  useEffect(() => {
    sceneRef.current!.setSelected(selected);
    sceneRef.current!.setBackground(backgroundFor(saves[selected]?.iconSys));
  }, [selected, saves]);

  return <canvas ref={canvasRef} className="grid-canvas" aria-label="Saves on the memory card" />;
}
