import { randomBytes, timingSafeEqual } from "node:crypto";

const isLoopbackSocketPeer = (address: string | undefined): boolean => {
  const ip = address?.replace(/^::ffff:/i, "") ?? "";
  return ip === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
};

/**
 * Tabario fork (TAB-1337): local Studio sharing is off unless `HYPERFRAMES_LOCAL_SHARE=1`.
 *
 * Tabario serves Studio to customers through the compositor's proxy, which forwards from
 * loopback and rewrites `Host` and a same-origin `Origin` to `127.0.0.1:<port>`. Every check in
 * `localShareRequestAllowed` therefore passes for a remote customer, and sharing would publish
 * their project to hyperframes.dev and start a CLI login inside the container. That is egress
 * the no-egress guarantee (TAB-697) forbids, so the share routes and the Studio's share meta tag
 * are not served at all by default.
 */
export function localShareEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HYPERFRAMES_LOCAL_SHARE?.trim() === "1";
}

export function localShareRequestAllowed(
  request: Request,
  socketPeer: string | undefined,
): boolean {
  if (!isLoopbackSocketPeer(socketPeer)) return false;
  const host = request.headers.get("host");
  if (!host || request.headers.get("sec-fetch-site") !== "same-origin") return false;
  try {
    const local = new URL(`http://${host}`);
    if (local.host !== host || !["localhost", "127.0.0.1", "[::1]"].includes(local.hostname))
      return false;
    const origin = request.headers.get("origin");
    if (origin !== null) return origin === local.origin;
    const referer = request.headers.get("referer");
    return referer !== null && new URL(referer).origin === local.origin;
  } catch {
    return false;
  }
}

export function createShareCsrf() {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    accepts(value: string | null) {
      return (
        value !== null &&
        Buffer.byteLength(value) === Buffer.byteLength(token) &&
        timingSafeEqual(Buffer.from(value), Buffer.from(token))
      );
    },
  };
}
