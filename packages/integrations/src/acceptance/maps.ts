// Google Routes acceptance check (INT-29). Google has no sandbox: it runs with the restaurant's own key
// (GOOGLE_ROUTES_API_KEY) and makes two computeRoutes requests (one ETA, one optimised 3-stop plan) billed by Google
// to that project. It checks the response shape Resuto relies on and records durations/distances only.
import { GoogleRoutesClient } from '../maps';
import { expectThat, registerChecks, type AcceptanceCheck } from './index';

const CAIRO = { origin: { latitude: 30.0444, longitude: 31.2357 }, stops: [
  { id: 'zamalek', location: { latitude: 30.0626, longitude: 31.2197 } },
  { id: 'garden_city', location: { latitude: 30.0366, longitude: 31.2316 } },
  { id: 'dokki', location: { latitude: 30.0385, longitude: 31.2123 } },
] };

export const mapsChecks: AcceptanceCheck[] = [
  {
    id: 'google_routes.eta_and_plan', provider: 'google_routes', capability: 'route_eta', modes: ['official_test', 'live'],
    requires: ['GOOGLE_ROUTES_API_KEY'], effect: 'read',
    prerequisites: ['A Google Cloud project with the Routes API enabled and a server API key restricted to it. Two billable Routes requests (one uses waypoint optimisation).'],
    docsUrl: 'https://developers.google.com/maps/documentation/routes/compute_route_directions',
    async run(ctx) {
      const client = new GoogleRoutesClient(ctx.env.GOOGLE_ROUTES_API_KEY!, ctx.adapter.fetch, 15_000);
      const eta = await client.computeRoute({ origin: CAIRO.origin, destination: CAIRO.stops[0]!.location, vehicle: 'car' });
      ctx.evidence('eta', { durationSeconds: eta.durationSeconds, distanceMeters: eta.distanceMeters, legs: eta.legs.length });
      expectThat(eta.durationSeconds > 0 && eta.distanceMeters > 500, 'implausible ETA for a ~3 km urban trip');
      const plan = await client.plan({ origin: CAIRO.origin, stops: CAIRO.stops, vehicle: 'car' });
      ctx.evidence('optimised plan', { algorithm: plan.algorithm, order: plan.order, totalSeconds: plan.totalSeconds, totalDistanceM: plan.totalDistanceM });
      expectThat(plan.order.length === 3 && new Set(plan.order).size === 3, 'the plan must visit each stop once');
      expectThat(plan.algorithm === 'google_routes_optimized_v1', 'waypoint optimisation was not applied');
    },
  },
];

registerChecks(...mapsChecks);
