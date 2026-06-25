/* KGLanding UX upgrades — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * Two recommended changes, pinned by behavior:
 *   1. node <-> table cross-highlight is DISCOVERABLE *and real*:
 *      - a dismissable tip explains the interaction (persists via localStorage)
 *      - hovering a graph node bridges to the table: KGGraphViz receives an
 *        onNodeHover callback; invoking it with a method label fires the
 *        app-level onHover(rowId); invoking it with null fires onUnhover().
 *   2. the lower dashboard is SURFACED:
 *      - the graph is shorter (height < 480) so the panels peek, and
 *      - a "jump to insights" affordance scrolls down to the panel band.
 *
 * Cytoscape can't run in jsdom, so KGGraphViz is stubbed to a prop-capturing
 * shim that exposes buttons to drive its onNodeHover callback.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as loader from '../../lib/data-loader';

// Capture the props KGLanding passes to its main graph (height + onNodeHover).
let mockGraphProps = {};
jest.mock('../KGGraphViz', () => (props) => {
  mockGraphProps = props;
  return (
    <div data-testid="kggraphviz">
      <button data-testid="hover-node" onClick={() => props.onNodeHover && props.onNodeHover('AnyGrasp')}>hov</button>
      <button data-testid="unhover-node" onClick={() => props.onNodeHover && props.onNodeHover(null)}>unhov</button>
    </div>
  );
});

import KGLanding from '../KGLanding';

const LANDING = {
  totalNodes: 10,
  temporal: [], benchmarkCoverage: [], topCited: [],
  topInstitutions: [], topAuthors: [], topExternalRefs: [],
  techniqueCooccurrence: { nodes: [] },
  citeFlow: { builds_on: 1, differs_from: 1, neutral: 1 },
  summary: {},
};

function mockLoaders() {
  jest.spyOn(loader, 'loadKgLanding').mockResolvedValue(LANDING);
  jest.spyOn(loader, 'loadKgMacro').mockResolvedValue({ nodes: [], links: [] });
  jest.spyOn(loader, 'loadMethods').mockResolvedValue([]);
  jest.spyOn(loader, 'loadKgPredictions').mockResolvedValue({ nodes: [], links: [] });
}

function renderLanding(extra = {}) {
  const onHover = jest.fn();
  const onUnhover = jest.fn();
  render(
    <KGLanding
      scatterData={[{ id: 7, name: 'AnyGrasp' }, { id: 3, name: 'GPD' }]}
      scatterHighlights={new Set()}
      selectedPoint={null}
      hoveredIndex={null}
      onSelect={() => {}}
      onHover={onHover}
      onUnhover={onUnhover}
      onFilter={() => {}}
      {...extra}
    />
  );
  return { onHover, onUnhover };
}

beforeEach(() => {
  mockGraphProps = {};
  try { window.localStorage.clear(); } catch (_) {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  jest.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  mockLoaders();
});

afterEach(() => jest.restoreAllMocks());

test('1a. discoverability tip renders and is dismissable (persists to localStorage)', async () => {
  renderLanding();
  await screen.findByTestId('kggraphviz');                 // wait for data load

  const tip = screen.getByText(/spotlight/i);
  expect(tip).toBeInTheDocument();

  const dismiss = screen.getByRole('button', { name: /dismiss/i });
  fireEvent.click(dismiss);

  await waitFor(() => expect(screen.queryByText(/spotlight/i)).not.toBeInTheDocument());
  expect(window.localStorage.getItem('kgl-xhighlight-hint')).toBe('dismissed');
});

test('1a. tip stays hidden when previously dismissed', async () => {
  window.localStorage.setItem('kgl-xhighlight-hint', 'dismissed');
  renderLanding();
  await screen.findByTestId('kggraphviz');
  expect(screen.queryByText(/spotlight/i)).not.toBeInTheDocument();
});

test('1b. graph node hover bridges to the table via onHover(rowId)', async () => {
  const { onHover, onUnhover } = renderLanding();
  await screen.findByTestId('kggraphviz');

  expect(typeof mockGraphProps.onNodeHover).toBe('function');

  fireEvent.click(screen.getByTestId('hover-node'));        // onNodeHover('AnyGrasp')
  expect(onHover).toHaveBeenCalledWith(7);                  // AnyGrasp -> row id 7

  fireEvent.click(screen.getByTestId('unhover-node'));      // onNodeHover(null)
  expect(onUnhover).toHaveBeenCalled();
});

test('1b-type. a NON-method node (year/institution) never cross-highlights a row', async () => {
  const { onHover, onUnhover } = renderLanding();
  await screen.findByTestId('kggraphviz');
  expect(typeof mockGraphProps.onNodeHover).toBe('function');

  // Type-aware happy path: a METHOD node still bridges to its table row.
  mockGraphProps.onNodeHover('AnyGrasp', 'method', 'm1');
  expect(onHover).toHaveBeenCalledWith(7);

  // A YEAR node cannot be a method, so it must suppress to onUnhover — this is the
  // exact "hovering 2021 highlights the wrong plot" bug the type-aware resolver fixes.
  onHover.mockClear();
  mockGraphProps.onNodeHover('2021', 'year', 'y1');
  expect(onHover).not.toHaveBeenCalled();
  expect(onUnhover).toHaveBeenCalled();

  // An INSTITUTION node likewise never crowns a method row.
  onHover.mockClear();
  mockGraphProps.onNodeHover('MIT', 'institution', 'i1');
  expect(onHover).not.toHaveBeenCalled();
});

test('2. graph height is reduced so the lower panels peek', async () => {
  renderLanding();
  await screen.findByTestId('kggraphviz');
  expect(typeof mockGraphProps.height).toBe('number');
  expect(mockGraphProps.height).toBeLessThan(480);
});

test('2. a jump-to-insights affordance scrolls down to the panel band', async () => {
  renderLanding();
  await screen.findByTestId('kggraphviz');

  const jump = screen.getByRole('button', { name: /insight panels below|scroll to insight/i });
  fireEvent.click(jump);
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});
