import { describe, expect, it } from 'vitest';
import {
  boardSequence, createBoardKeyReader, groupTickets, laneCounts, locate, nthLive, primaryStep, stepCard, stepLane, type BoardTicket,
} from './board';

const tk = (id: string, status: string, fulfillment = 'dine_in', extra: Partial<BoardTicket> = {}): BoardTicket & { id: string } =>
  ({ id, status, fulfillment, lines: [{ kitchenStatus: status === 'ready' ? 'ready' : 'queued' }], ...extra });

const feed = [
  tk('a', 'placed'), tk('b', 'accepted'), tk('c', 'preparing'), tk('d', 'ready'), tk('e', 'ready', 'delivery', { handedOff: true, driverJob: true }),
  tk('f', 'ready', 'delivery', { handedOff: true }),
];
const recent = [tk('z', 'served')];

describe('board grouping', () => {
  it('puts each ticket in its lane, recent ones in Completed, and counts them', () => {
    const g = groupTickets(feed, recent);
    expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((x) => x.id)]))).toEqual({
      new: ['a', 'b'], preparing: ['c'], ready: ['d'], out: ['e', 'f'], done: ['z'],
    });
    expect(laneCounts(g)).toEqual({ new: 2, preparing: 1, ready: 1, out: 2, done: 1 });
  });

  it('a ready order with a line still cooking stays in Preparing', () => {
    const g = groupTickets([tk('r', 'ready', 'dine_in', { lines: [{ kitchenStatus: 'ready' }, { kitchenStatus: 'preparing' }] })]);
    expect(g.preparing.map((x) => x.id)).toEqual(['r']);
  });

  it('reads lane by lane for j/k and finds a card', () => {
    const g = groupTickets(feed, recent);
    expect(boardSequence(g)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'z']);
    expect(locate(g, 'f')).toEqual({ lane: 'out', index: 1 });
    expect(locate(g, 'nope')).toBeNull();
  });
});

describe('moving the focus', () => {
  const g = groupTickets(feed, recent);
  const seq = boardSequence(g);
  it('j/k step through the sequence and stop at the ends', () => {
    expect(stepCard(seq, null, 1)).toBe('a');
    expect(stepCard(seq, null, -1)).toBe('z');
    expect(stepCard(seq, 'a', 1)).toBe('b');
    expect(stepCard(seq, 'a', -1)).toBe('a');
    expect(stepCard(seq, 'z', 1)).toBe('z');
    expect(stepCard([], null, 1)).toBeNull();
  });
  it('lane steps keep the row, skip empty lanes and stop at the last lane', () => {
    expect(stepLane(g, 'b', 1)).toBe('c'); // row 2 of New → the only card of Preparing
    expect(stepLane(g, 'c', -1)).toBe('a');
    expect(stepLane(g, 'd', 1)).toBe('e');
    expect(stepLane(g, 'z', 1)).toBe('z');
    const gaps = groupTickets([tk('a', 'placed'), tk('d', 'ready')]);
    expect(stepLane(gaps, 'a', 1)).toBe('d'); // Preparing is empty
    expect(stepLane(gaps, null, 1)).toBe('a');
  });
  it('the bump bar numbers count only the open lanes', () => {
    expect(nthLive(g, 1)).toBe('a');
    expect(nthLive(g, 6)).toBe('f');
    expect(nthLive(g, 7)).toBeNull(); // Completed is not counted
  });
});

describe('primary step (the bump)', () => {
  it('moves each lane forward and leaves driver jobs to the driver', () => {
    expect(primaryStep(tk('a', 'placed'))).toEqual({ steps: ['preparing'], to: 'preparing' });
    expect(primaryStep(tk('c', 'preparing'))).toEqual({ steps: ['ready'], to: 'ready' });
    expect(primaryStep(tk('d', 'ready'))).toEqual({ steps: ['served'], to: 'done' });
    expect(primaryStep(tk('p', 'ready', 'pickup'))).toEqual({ steps: ['picked_up'], to: 'done' });
    expect(primaryStep(tk('q', 'ready', 'delivery'))).toEqual({ steps: ['delivered'], to: 'out' });
    expect(primaryStep(tk('f', 'ready', 'delivery', { handedOff: true }))).toEqual({ steps: ['delivered'], to: 'done' });
    expect(primaryStep(tk('e', 'ready', 'delivery', { handedOff: true, driverJob: true }))).toBeNull();
    expect(primaryStep(tk('z', 'served'))).toBeNull();
  });
  it('a ready order still cooking in Preparing has no main step until its lines are done', () => {
    expect(primaryStep(tk('r', 'ready', 'dine_in', { lines: [{ kitchenStatus: 'preparing' }] }))).toBeNull();
  });
});

describe('board keys', () => {
  const button = Object.assign(document_like('BUTTON'), {});
  it('orders board: letters, Enter opens, Space bumps, x selects, Escape clears', () => {
    const read = createBoardKeyReader('orders');
    expect(read({ key: 'j' })).toBe('next');
    expect(read({ key: 'k' })).toBe('prev');
    expect(read({ key: 'o' })).toBe('open');
    expect(read({ key: 'Enter' })).toBe('open');
    expect(read({ key: 'a' })).toBe('bump');
    expect(read({ key: ' ' })).toBe('bump');
    expect(read({ key: 'x' })).toBe('select');
    expect(read({ key: 'Escape' })).toBe('clear');
    expect(read({ key: '1' })).toBeNull(); // numbers are the kitchen bump bar's
    expect(read({ key: 'b' })).toBeNull();
  });
  it('kitchen display: arrows, 1-9 (digit row, numpad, Arabic-Indic), Enter / Space / b bump', () => {
    const read = createBoardKeyReader('kds');
    expect(read({ key: 'ArrowDown' })).toBe('next');
    expect(read({ key: 'ArrowUp' })).toBe('prev');
    expect(read({ key: 'Home' })).toBe('first');
    expect(read({ key: 'End' })).toBe('last');
    expect(read({ key: '3', code: 'Digit3' })).toBe('pick3');
    expect(read({ key: 'End', code: 'Numpad1' })).toBe('last'); // NumLock off: the key wins
    expect(read({ key: '7', code: 'Numpad7' })).toBe('pick7');
    expect(read({ key: '٤' })).toBe('pick4');
    expect(read({ key: '0' })).toBeNull();
    expect(read({ key: 'Enter' })).toBe('bump');
    expect(read({ key: ' ' })).toBe('bump');
    expect(read({ key: 'b' })).toBe('bump');
    expect(read({ key: 'x' })).toBeNull();
  });
  it('Left/Right follow the reading direction', () => {
    const read = createBoardKeyReader('kds');
    expect(read({ key: 'ArrowRight' }, false)).toBe('nextLane');
    expect(read({ key: 'ArrowLeft' }, false)).toBe('prevLane');
    expect(read({ key: 'ArrowRight' }, true)).toBe('prevLane');
    expect(read({ key: 'ArrowLeft' }, true)).toBe('nextLane');
  });
  it('the physical key counts on an Arabic layout', () => {
    expect(createBoardKeyReader('orders')({ key: 'ت', code: 'KeyJ' })).toBe('next');
  });
  it('stays quiet while typing, in dialogs, with modifiers, on repeat and after the shell\'s g', () => {
    const read = createBoardKeyReader('orders');
    expect(read({ key: 'j', target: document_like('INPUT') })).toBeNull();
    expect(read({ key: 'j', target: document_like('DIV', true) })).toBeNull();
    expect(read({ key: 'j', ctrlKey: true })).toBeNull();
    expect(read({ key: 'j', shiftKey: true })).toBeNull();
    expect(read({ key: 'Enter', repeat: true })).toBeNull();
    expect(read({ key: 'j', isComposing: true })).toBeNull();
    expect(read({ key: 'g' }, false, 1000)).toBeNull();
    expect(read({ key: 'o' }, false, 1200)).toBeNull(); // g o is the shell's "go to Orders"
    expect(read({ key: 'o' }, false, 1300)).toBe('open');
    expect(read({ key: 'g' }, false, 2000)).toBeNull();
    expect(read({ key: 'o' }, false, 9000)).toBe('open'); // the g timed out
  });
  it('Enter and Space on a focused button or link activate it, not the board', () => {
    const read = createBoardKeyReader('kds');
    expect(read({ key: 'Enter', target: button })).toBeNull();
    expect(read({ key: ' ', target: document_like('A') })).toBeNull();
    expect(read({ key: 'j', target: button })).toBe('next');
  });
});

/** A minimal element for the key reader: tag name, closest() for buttons, links and dialogs. */
function document_like(tag: string, inDialog = false) {
  return {
    tagName: tag, type: tag === 'INPUT' ? 'text' : undefined, getAttribute: () => null,
    closest: (sel: string) => (inDialog && sel.includes('dialog')) || (sel.includes('button') && (tag === 'BUTTON' || tag === 'A')) ? {} : null,
  } as unknown as EventTarget;
}
