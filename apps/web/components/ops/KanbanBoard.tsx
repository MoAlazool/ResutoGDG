'use client';
// Kanban board with pointer drag-and-drop, ported from the legacy kitchen board (legacy/public/kitchen-dnd.js):
// an 8 px threshold before a drag starts, every lane painted as a valid or invalid drop while dragging, forward-only
// moves decided by `pathTo` (the server validates each step again), and live polling paused while dragging. Buttons on
// the cards stay the keyboard and screen-reader route; dragging is an accelerator, never the only way.
import { useEffect, useRef, type ReactNode } from 'react';
import { setDragging } from '@/lib/live-pause';

export interface KanbanLane<K extends string> { key: K; title: ReactNode; dot: string; count: number; children: ReactNode; empty?: ReactNode }

const THRESHOLD = 8;

export function KanbanBoard<K extends string>({ lanes, pathTo, onMove, onRefused, label, className }: {
  lanes: Array<KanbanLane<K>>;
  /** Steps that move card `id` to `lane`, or null when that lane is not a valid next step. */
  pathTo: (id: string, lane: K) => string[] | null;
  onMove: (id: string, steps: string[], lane: K) => Promise<void> | void;
  /** A drop on a lane that is not a valid next step (legacy: "An order can only move forward"). */
  onRefused?: (id: string, lane: K) => void;
  label?: string;
  className?: string;
}) {
  const board = useRef<HTMLDivElement>(null);
  const handlers = useRef({ pathTo, onMove, onRefused });
  handlers.current = { pathTo, onMove, onRefused };

  useEffect(() => {
    const root = board.current;
    if (!root) return;
    let drag: { card: HTMLElement; id: string; from: string; x: number; y: number; pointerId: number; moved: boolean } | null = null;
    const columns = () => [...root.querySelectorAll<HTMLElement>('[data-lane]')];
    const reset = () => columns().forEach((c) => c.classList.remove('drop-ok', 'drop-no', 'is-over'));
    const laneUnder = (ev: PointerEvent) => (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-lane]') ?? null;

    const down = (ev: PointerEvent) => {
      const target = ev.target as HTMLElement;
      const card = target.closest<HTMLElement>('[data-card]');
      if (!card || ev.button !== 0 || target.closest('button, a, input, select, textarea')) return;
      drag = { card, id: card.dataset.card!, from: card.closest<HTMLElement>('[data-lane]')?.dataset.lane ?? '', x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId, moved: false };
    };
    const move = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < THRESHOLD) return;
        drag.moved = true;
        setDragging(true);
        try { drag.card.setPointerCapture(drag.pointerId); } catch { /* capture is optional */ }
        drag.card.classList.add('is-dragging');
        for (const c of columns()) {
          const ok = !!handlers.current.pathTo(drag.id, c.dataset.lane as K);
          c.classList.toggle('drop-ok', ok);
          c.classList.toggle('drop-no', !ok && c.dataset.lane !== drag.from);
        }
      }
      ev.preventDefault();
      drag.card.style.transform = `translate(${dx}px, ${dy}px)`;
      const over = laneUnder(ev);
      columns().forEach((c) => c.classList.toggle('is-over', c === over && c.classList.contains('drop-ok')));
    };
    const finish = async (ev: PointerEvent | null) => {
      if (!drag || (ev && ev.pointerId !== drag.pointerId)) return;
      const d = drag;
      drag = null;
      if (!d.moved) return;
      d.card.classList.remove('is-dragging');
      d.card.style.transform = '';
      const over = ev ? laneUnder(ev) : null;
      reset();
      const lane = over?.dataset.lane as K | undefined;
      const steps = lane ? handlers.current.pathTo(d.id, lane) : null;
      try {
        if (lane && steps) await handlers.current.onMove(d.id, steps, lane);
        else if (lane && lane !== d.from) handlers.current.onRefused?.(d.id, lane);
      } finally {
        setDragging(false);
      }
    };
    const up = (ev: PointerEvent) => void finish(ev);
    const cancel = () => void finish(null);
    root.addEventListener('pointerdown', down);
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', cancel);
    root.addEventListener('lostpointercapture', cancel);
    return () => {
      root.removeEventListener('pointerdown', down);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', cancel);
      root.removeEventListener('lostpointercapture', cancel);
      if (drag?.moved) setDragging(false);
    };
  }, []);

  return (
    <div className={['kanban', className].filter(Boolean).join(' ')} ref={board} aria-label={label} data-lanes={lanes.length}>
      {lanes.map((lane) => (
        <section key={lane.key} className="kanban-lane" data-lane={lane.key} style={{ ['--dot' as string]: lane.dot }} aria-label={typeof lane.title === 'string' ? lane.title : undefined}>
          <header className="kanban-head"><i aria-hidden="true" /><span>{lane.title}</span><span className="kanban-count num">{lane.count}</span></header>
          <div className="kanban-cards">{lane.count ? lane.children : <div className="kanban-empty">{lane.empty}</div>}</div>
        </section>
      ))}
    </div>
  );
}
