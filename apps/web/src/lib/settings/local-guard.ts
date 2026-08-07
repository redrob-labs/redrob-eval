/**
 * These endpoints read/write local secrets and browse the local filesystem, so
 * they are only served to loopback clients. If the workbench is ever bound to a
 * non-local interface, remote callers get 403 instead of the settings surface.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

export function isLocalRequest(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  return LOCAL_HOSTS.has(hostname);
}

export function localOnlyResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'Settings are available on localhost only' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}
