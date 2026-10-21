import type { Instrumentation } from 'next';

/**
 * Server-side errors of the web app (render, route handlers, server actions, middleware) go to the optional error
 * tracker (audit CR-14; ERROR_TRACKING_DSN, server-only). Only the route PATTERN (e.g. /t/[qr]) is sent, never the
 * requested path, which can hold guest, order or payment tokens. Off when the DSN is unset.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { webErrorReporter } = await import('./lib/error-tracking');
  const requestId = Array.isArray(request.headers['x-request-id']) ? request.headers['x-request-id'][0] : request.headers['x-request-id'];
  await webErrorReporter().capture(error, { route: context.routePath, requestId, source: `web:${context.routerKind}:${context.routeType}` });
};
