/**
 * Helper utilities for Durable Object internal calls
 * 
 * When calling fetch() on a Durable Object stub, the URL host is ignored.
 * Only the pathname is used for routing. This constant provides a clear
 * placeholder URL that makes it obvious these are internal Durable Object calls.
 */

/**
 * Placeholder URL base for Durable Object internal calls.
 * The host is ignored - only the pathname is used for routing.
 * 
 * Example usage:
 *   await system.fetch(DO_INTERNAL("/tick"), { method: "POST" })
 *   await ship.fetch(DO_INTERNAL("/state"))
 */
export const DO_INTERNAL_BASE = "https://internal";

/**
 * Creates a URL string for internal Durable Object calls.
 * Only the pathname matters - the host is ignored.
 * 
 * @param path - The pathname to use (e.g., "/tick", "/state", "/snapshot")
 * @returns A URL string (host is ignored, only pathname is used)
 */
export function DO_INTERNAL(path: string): string {
  // Ensure path starts with /
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${DO_INTERNAL_BASE}${normalizedPath}`;
}

/**
 * Creates a Request object for internal Durable Object calls.
 * This is more explicit than using a string URL.
 * 
 * @param path - The pathname to use
 * @param init - Optional RequestInit (method, headers, body, etc.)
 * @returns A Request object ready to pass to Durable Object fetch()
 */
export function createDORequest(path: string, init?: RequestInit): Request {
  return new Request(DO_INTERNAL(path), init);
}

