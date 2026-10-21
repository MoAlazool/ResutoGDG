// React port of legacy/public/floor-shared.js sceneSvg/objectSvg: the same
// true top-down drawing is used by the Floor Studio editor, the live floor,
// guest previews and the landing-page demos. Render inside an <svg>.
import { Fragment, type KeyboardEvent, type ReactNode } from 'react';
import { chairPositions, isTable, type FloorBackground, type FloorObject, type FloorTable } from './model';

export type SceneMode = 'reservation' | 'operations' | 'editor' | 'design' | 'marketing';

export type SceneTable = FloorTable & { state?: string; statusText?: string; disabled?: boolean; hidden?: boolean };
export interface SceneLayout {
  width: number;
  height: number;
  background?: FloorBackground | null;
  zones: FloorObject[];
  objects: FloorObject[];
  tables: SceneTable[];
}

export interface SceneOptions {
  selected?: string[];
  editor?: boolean;
  grid?: boolean;
  mode?: SceneMode;
  /** "4 seats" label (localised by the caller). */
  seatsLabel?: (n: number) => string;
  /** Translates zone/object labels for display (layout data stays as stored). */
  labelOf?: (label: string) => string;
  /** Accessible name for a table: "T1, 4 seats, available". */
  tableAria?: (t: SceneTable) => string;
  /** Accessible name for editor objects. */
  selectAria?: (label: string) => string;
  /** Called when a guest/staff activates a table (click/Enter/Space) outside the editor. */
  onTableActivate?: (id: string) => void;
  /** Extra class names per object id (e.g. landing-demo pulses). */
  classOf?: (id: string) => string | undefined;
}

const STATUS_ICONS: Record<string, string> = {
  available: '✓', recommended: '★', reserved: 'R', occupied: '●', ordering: '•••', preparing: '⌁', ready: '!', eating: '●', payment: '£',
  payment_pending: '£', 'bill-requested': '£', 'partially-paid': '£', paid: '✓', cleaning: '↻', unavailable: '×', 'is-selected': '✓',
};
const stateName = (s: string | undefined) => String(s || 'available').replace(/[^a-z_-]/gi, '');

export function SceneDefs() {
  return (
    <defs>
      <pattern id="material-wood" width="36" height="22" patternUnits="userSpaceOnUse"><path d="M0 1H36M18 1V22" stroke="#735936" opacity=".25" /></pattern>
      <pattern id="material-garden" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="6" cy="6" r="2" fill="#335e32" /></pattern>
      <pattern id="floor-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#31554a" strokeOpacity=".11" strokeWidth="1" /></pattern>
      <filter id="soft-shadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="5" stdDeviation="4" floodColor="#173f36" floodOpacity=".16" /></filter>
      <filter id="tiny-shadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#173f36" floodOpacity=".17" /></filter>
    </defs>
  );
}

function Chair({ x, y, rotation }: { x: number; y: number; rotation: number }) {
  return (
    <g className="chair" transform={`translate(${x} ${y}) rotate(${rotation})`}>
      <rect x="-15" y="-8" width="30" height="16" rx="6" />
      <path d="M-11 5v7m22-7v7" />
    </g>
  );
}

function TableDrawing({ o, mode, seatsLabel }: { o: SceneTable; mode: SceneMode; seatsLabel: (n: number) => string }) {
  const w = o.width, h = o.height, state = stateName(o.state), round = o.shape === 'round';
  const icon = STATUS_ICONS[state] ?? STATUS_ICONS.available;
  const tagLabel = mode === 'operations' && o.statusText ? String(o.statusText).slice(0, 24) : null;
  const tagWidth = tagLabel ? Math.max(96, tagLabel.length * 12 + 26) : 0;
  return (
    <>
      <g className="svg-chairs">{chairPositions(o).map((c, i) => <Chair key={i} {...c} />)}</g>
      {round ? (
        <>
          <ellipse className="table-shadow" cy="5" rx={w / 2} ry={h / 2} />
          <ellipse className="table-surface" rx={w / 2} ry={h / 2} />
          <ellipse className="table-inset" rx={Math.max(2, w / 2 - 8)} ry={Math.max(2, h / 2 - 8)} />
        </>
      ) : (
        <>
          <rect className="table-shadow" x={-w / 2} y={-h / 2 + 5} width={w} height={h} rx="15" />
          <rect className="table-surface" x={-w / 2} y={-h / 2} width={w} height={h} rx="15" />
          <rect className="table-inset" x={-w / 2 + 8} y={-h / 2 + 8} width={Math.max(2, w - 16)} height={Math.max(2, h - 16)} rx="10" />
        </>
      )}
      {/* The worded tag replaces the icon badge — two status markers just compete. */}
      {!tagLabel && (
        <g className="table-badge"><circle r="19" /><text textAnchor="middle" dominantBaseline="central">{icon}</text></g>
      )}
      <text className="table-label" textAnchor="middle" y={mode === 'marketing' ? 5 : -4}>{o.label}</text>
      {mode !== 'marketing' && <text textAnchor="middle" className="svg-seat-label" y="21">{seatsLabel(o.capacity)}</text>}
      {tagLabel && (
        // Lifted clear of the top chairs (seat backs reach -h/2-29).
        <g className="table-status-tag" transform={`translate(0 ${-o.height / 2 - 52})`}>
          <rect x={-tagWidth / 2} y="-17" width={tagWidth} height="34" rx="17" />
          <text textAnchor="middle" dominantBaseline="central" y="1">{tagLabel}</text>
        </g>
      )}
    </>
  );
}

/** Direction of a label from its first strong character (what dir="auto" does for HTML). */
export function labelDirection(s: string): 'ltr' | 'rtl' {
  for (const ch of s) {
    if (/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(ch)) return 'rtl';
    if (/\p{L}/u.test(ch)) return 'ltr';
  }
  return 'ltr';
}

/**
 * A zone caption sits in the zone's top corner on the side its script reads from: Arabic at the top right, Latin at
 * the top left. The direction is set on the text itself, so an Arabic page (where SVG text inherits direction:rtl and
 * "start" means the right edge) no longer pushes the caption out past the zone's left edge (VP-13 / VS-08).
 */
function ZoneLabel({ label, w, h }: { label: string; w: number; h: number }) {
  const dir = labelDirection(label);
  return <text className="zone-label" direction={dir} textAnchor="start" x={dir === 'rtl' ? w / 2 - 24 : -w / 2 + 24} y={-h / 2 + 34}>{label}</text>;
}

function ObjectDrawing({ o, labelOf }: { o: FloorObject; labelOf: (s: string) => string }): ReactNode {
  const w = o.width, h = o.height, label = labelOf(o.label);
  switch (o.type) {
    case 'zone':
      return (
        <>
          <rect className="zone-surface" x={-w / 2} y={-h / 2} width={w} height={h} rx="28" style={{ ['--zone-color' as string]: o.color ?? '#edf1e8' }} />
          {o.material && o.material !== 'stone' && <rect className={`material-${o.material}`} x={-w / 2} y={-h / 2} width={w} height={h} rx="28" pointerEvents="none" />}
          <ZoneLabel label={label} w={w} h={h} />
        </>
      );
    case 'text':
      return (<><rect x={-w / 2} y={-h / 2} width={w} height={h} fill="transparent" /><text className="floor-text" textAnchor="middle" dominantBaseline="middle">{label}</text></>);
    case 'chair':
      return (<><rect className="loose-chair" x={-w / 2} y={-h / 2} width={w} height={h} rx="8" /><path d={`M${-w / 2 + 5} ${h / 2 - 5}V${-h / 2 + 5}H${w / 2 - 5}V${h / 2 - 5}`} /></>);
    case 'plant':
      return (
        <>
          <circle className="plant-pot" r={Math.min(w, h) / 2} />
          <g className="plant-leaves">
            <ellipse rx="9" ry={h * 0.38} transform="rotate(-48)" /><ellipse rx="9" ry={h * 0.4} transform="rotate(48)" /><ellipse rx="8" ry={h * 0.4} />
          </g>
        </>
      );
    case 'door':
    case 'entrance':
      return (
        <>
          <rect className="opening-cut" x={-w / 2} y="-8" width={w} height="16" />
          <path className="door-leaf" d={`M${-w / 2} 0H${w / 2}`} />
          <path className="door-swing" d={`M${-w / 2} 0A${w} ${w} 0 0 1 ${w / 2} ${-w}`} />
          <text y="28" textAnchor="middle" className="structure-label">{label}</text>
        </>
      );
    case 'window':
      return (<><rect className="window-frame" x={-w / 2} y={-h / 2} width={w} height={h} rx="3" /><path className="window-glass" d={`M${-w / 2 + 8} 0H${w / 2 - 8}`} /></>);
    case 'counter':
    case 'bar':
    case 'kitchen':
      return (
        <>
          <rect className="counter-shadow" x={-w / 2} y={-h / 2 + 7} width={w} height={h} rx="12" />
          <rect className="counter-surface" x={-w / 2} y={-h / 2} width={w} height={h} rx="12" />
          <path className="counter-line" d={`M${-w / 2 + 10} ${-h / 2 + 14}H${w / 2 - 10}`} />
          <text textAnchor="middle" dominantBaseline="central" className="structure-label">{label}</text>
        </>
      );
    case 'wall':
    case 'divider':
      return (<><rect className="wall-shadow" x={-w / 2} y={-h / 2 + 5} width={w} height={h} rx="3" /><rect className="wall-core" x={-w / 2} y={-h / 2} width={w} height={h} rx="3" /></>);
    default:
      return (<><rect className="structure-surface" x={-w / 2} y={-h / 2} width={w} height={h} rx="8" /><text textAnchor="middle" dominantBaseline="central" className="structure-label">{label}</text></>);
  }
}

function SceneObject({ o, selected, opts }: { o: SceneTable | FloorObject; selected: boolean; opts: Required<Pick<SceneOptions, 'mode' | 'seatsLabel' | 'labelOf'>> & SceneOptions }) {
  const { editor = false, mode } = opts;
  if ((o as FloorObject).hidden && !editor) return null;
  const table = isTable(o);
  const w = o.width, h = o.height;
  const state = stateName(table ? (o as SceneTable).state : undefined);
  const x = table ? (o as FloorTable).cx : (o as FloorObject).x;
  const y = table ? (o as FloorTable).cy : (o as FloorObject).y;
  const type = table ? 'table' : (o as FloorObject).type;
  const locked = !!(o as FloorObject).locked;
  const interactive = table && !editor && !!opts.onTableActivate;
  const disabled = table && !!(o as SceneTable).disabled;
  const a11y = table && !editor
    ? {
        role: interactive ? 'button' : 'img',
        tabIndex: interactive ? (disabled ? -1 : 0) : undefined,
        'aria-disabled': interactive ? disabled : undefined,
        'aria-label': opts.tableAria ? opts.tableAria(o as SceneTable) : `${o.label}, ${opts.seatsLabel((o as FloorTable).capacity)}, ${state}`,
        onClick: interactive && !disabled ? () => opts.onTableActivate!(o.id) : undefined,
        onKeyDown: interactive && !disabled ? (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onTableActivate!(o.id); } } : undefined,
      }
    : editor ? { role: 'button', tabIndex: 0, 'aria-label': opts.selectAria ? opts.selectAria(opts.labelOf(o.label)) : o.label, 'aria-pressed': selected } : {};
  return (
    <g className={`floor-object svg-${type} state-${state}${selected ? ' is-selected' : ''}${(o as FloorObject).hidden ? ' is-hidden' : ''}${opts.classOf?.(o.id) ? ` ${opts.classOf(o.id)}` : ''}`}
      data-object-id={o.id} transform={`translate(${x} ${y}) rotate(${o.rotation || 0})`} opacity={(o as FloorObject).hidden ? 0.35 : undefined} {...a11y}>
      {table ? <TableDrawing o={o as SceneTable} mode={mode} seatsLabel={opts.seatsLabel} /> : <ObjectDrawing o={o as FloorObject} labelOf={opts.labelOf} />}
      {selected && editor && !locked && (
        <>
          <rect className="selection-box" x={-w / 2 - 7} y={-h / 2 - 7} width={w + 14} height={h + 14} rx="8" />
          <circle className="handle-hit" data-handle="resize" cx={w / 2} cy={h / 2} r="28" />
          <circle className="resize-handle" data-handle="resize" cx={w / 2} cy={h / 2} r="9" />
          <path className="rotation-stem" d={`M0 ${-h / 2}V${-h / 2 - 38}`} />
          <circle className="handle-hit" data-handle="rotate" cx="0" cy={-h / 2 - 38} r="28" />
          <circle className="rotate-handle" data-handle="rotate" cx="0" cy={-h / 2 - 38} r="9" />
        </>
      )}
      {selected && editor && locked && <rect className="selection-box" x={-w / 2 - 7} y={-h / 2 - 7} width={w + 14} height={h + 14} rx="8" />}
    </g>
  );
}

/**
 * Walls and dividers are the room's shell, so they are drawn first: doors, entrances and windows are openings cut into
 * a wall and must sit on top of it whatever order the layout stores them in (a wall added after the door would
 * otherwise paint over the opening). The sort is stable, so every other object keeps its stored order (PAR-01).
 */
const isShell = (o: { type?: string }) => o.type === 'wall' || o.type === 'divider';
export const inDrawOrder = <T extends { type?: string }>(objects: T[]): T[] => [...objects.filter(isShell), ...objects.filter((o) => !isShell(o))];

/** The scene contents (place inside an <svg viewBox=…>). */
export function FloorSceneContent({ layout, ...options }: { layout: SceneLayout } & SceneOptions) {
  const mode: SceneMode = options.mode ?? (options.editor ? 'editor' : 'reservation');
  const opts = { ...options, mode, seatsLabel: options.seatsLabel ?? ((n: number) => `${n} seats`), labelOf: options.labelOf ?? ((s: string) => s) };
  const selected = new Set(options.selected ?? []);
  const bg = layout.background;
  return (
    <>
      <SceneDefs />
      <rect className="canvas-base" width={layout.width} height={layout.height} rx="28" />
      {options.grid && <rect className="floor-grid" width={layout.width} height={layout.height} fill="url(#floor-grid)" />}
      {bg?.image && (
        <image data-background="true" x={bg.x || 0} y={bg.y || 0} width={bg.width || layout.width} height={bg.height || layout.height}
          href={bg.image} opacity={bg.opacity} preserveAspectRatio="none" style={{ pointerEvents: options.editor && !bg.locked ? 'all' : 'none' }} />
      )}
      {[layout.zones, inDrawOrder(layout.objects), layout.tables].map((list, li) => (
        <Fragment key={li}>{list.map((o) => <SceneObject key={o.id} o={o} selected={selected.has(o.id)} opts={opts} />)}</Fragment>
      ))}
    </>
  );
}

/** A complete read-only floor drawing (reservation maps, previews, operations). */
export function FloorScene({ layout, viewBox, ariaLabel, className, ...options }: { layout: SceneLayout; viewBox?: string; ariaLabel: string; className?: string } & SceneOptions) {
  return (
    <svg className={className} viewBox={viewBox ?? `0 0 ${layout.width} ${layout.height}`} role="group" aria-label={ariaLabel}>
      <FloorSceneContent layout={layout} {...options} />
    </svg>
  );
}
