'use client';
// Port of legacy/public/floor-preview.js: pan (drag), pinch/zoom and fit, now
// with an explicit 2D / 2.5D view switch.
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { FloorSceneContent, type SceneLayout, type SceneMode } from './FloorScene';

export function FloorPreview({ layout, mode = 'reservation', labels, seatsLabel, labelOf, onSelect, defaultView = '3d' }: {
  layout: SceneLayout; mode?: SceneMode; defaultView?: '2d' | '3d';
  labels: { region: string; zoomIn: string; zoomOut: string; fit: string; view2d: string; view3d: string };
  seatsLabel?: (n: number) => string; labelOf?: (s: string) => string; onSelect?: (id: string) => void;
}) {
  const [view, setView] = useState<'2d' | '3d'>(defaultView);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const points = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number; moved: boolean; target?: string } | null>(null);
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const clamp = (z: number) => Math.max(0.7, Math.min(3, z));

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button')) return;
    points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    const target = (e.target as Element).closest('[data-object-id]')?.getAttribute('data-object-id') ?? undefined;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y, moved: false, target };
    if (points.current.size === 2) {
      const [a, b] = [...points.current.values()];
      pinch.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom };
    }
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (!points.current.has(e.pointerId)) return;
    points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.current.size === 2 && pinch.current) {
      const [a, b] = [...points.current.values()];
      setZoom(clamp((pinch.current.zoom * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.current.distance));
      if (drag.current) drag.current.moved = true;
    } else if (drag.current && drag.current.id === e.pointerId) {
      const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
      if (Math.hypot(dx, dy) > 5) drag.current.moved = true;
      setPan({ x: drag.current.ox + dx, y: drag.current.oy + dy });
    }
  };
  const end = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && !d.moved && d.target && e.type !== 'pointercancel') onSelect?.(d.target);
    points.current.delete(e.pointerId);
    drag.current = null;
    pinch.current = null;
  };

  const projection = view === '3d' ? 'rotateX(48deg) rotateZ(-6deg)' : 'none';
  return (
    <div className={`floor-perspective floor-mode-${mode}`} data-view={view} role="region" aria-label={labels.region}
      onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <div className="floor-projection" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) ${projection}` }}>
        <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={labels.region}>
          <FloorSceneContent layout={layout} mode={mode} seatsLabel={seatsLabel} labelOf={labelOf} onTableActivate={onSelect} />
        </svg>
      </div>
      <div className="preview-view-toggle" role="group">
        <button type="button" aria-pressed={view === '2d'} onClick={() => setView('2d')}>{labels.view2d}</button>
        <button type="button" aria-pressed={view === '3d'} onClick={() => setView('3d')}>{labels.view3d}</button>
      </div>
      <div className="preview-controls">
        <button type="button" aria-label={labels.zoomOut} onClick={() => setZoom((z) => clamp(z - 0.2))}>−</button>
        <button type="button" aria-label={labels.fit} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>↺</button>
        <button type="button" aria-label={labels.zoomIn} onClick={() => setZoom((z) => clamp(z + 0.2))}>+</button>
      </div>
    </div>
  );
}
