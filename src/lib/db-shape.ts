// src/lib/db-shape.ts
// Pure helpers around DATABASE_URL parsing. Kept side-effect-free so they
// can be unit-tested without spinning up a Postgres container.

/**
 * Returns true when the DATABASE_URL host is anything other than localhost /
 * 127.0.0.1 / ::1 — i.e., when it points at a remote managed Postgres
 * (Neon, Supabase, Render) that requires TLS over the public network.
 *
 * The `pg` driver already auto-parses `?sslmode=` from the URL, but several
 * managed providers (notably Neon) leave it implicit. We treat any non-loopback
 * host as needing TLS so the dev experience "just works" when the URL is
 * swapped at deploy time.
 */
export function shouldUseTls(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    // URL parses IPv6 hosts with brackets (e.g., `[::1]`) — strip them
    // before comparing against the loopback sentinel.
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    // Unparseable URL — be safe and don't force TLS; the driver will surface
    // the real error if the URL is broken.
    return false;
  }
}
