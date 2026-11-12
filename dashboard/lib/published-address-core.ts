import type { Port } from "@/lib/agent-types";
import { urlHost } from "@/lib/address-core";

/**
 * Where an app that has no domain answers: a port the agent publishes on the server, on 127.0.0.1 (only the server itself
 * reaches it) or on every interface. The address a person types is `host:port`, with the host the dashboard knows the
 * server by; a browser can open it only when that host is reachable from where the browser is.
 */
export interface LocalAddress {
  port: number;
  /** Published on 127.0.0.1 of the server: reachable on the server itself, or through an SSH tunnel. */
  loopback: boolean;
  /** `host:port` as typed; `127.0.0.1:port` for a loopback port, `:port` when the server's host is not known. */
  address: string;
  /** Opens it from a browser; null when the host is not reachable from here (a loopback port of a remote server, an unknown host). */
  url: string | null;
}

/** The host a server answers on: its public address when set, else the host of the agent's URL; null for a server that connects out. */
export function serverHostOf(server: { url: string; publicIp: string | null }): string | null {
  const set = server.publicIp?.trim() ?? "";
  if (set !== "") return set;
  return server.url === "" ? null : urlHost(server.url);
}

/** Whether the host is the machine the dashboard runs on, so that a loopback port of the server is the machine's own. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.[0-9]{1,3}){3}$/.test(h);
}

const bracketed = (host: string): string => (host.includes(":") ? `[${host}]` : host);

/** The address of one published port. `loopback`: it is published on 127.0.0.1 only. */
export function localAddress(port: number, loopback: boolean, host: string | null): LocalAddress {
  if (loopback) {
    // a browser reaches 127.0.0.1 only when the dashboard and the server are one machine
    const same = host !== null && isLoopbackHost(host);
    return { port, loopback, address: `127.0.0.1:${port}`, url: same ? `http://127.0.0.1:${port}` : null };
  }
  if (host === null) return { port, loopback, address: `:${port}`, url: null };
  return { port, loopback, address: `${bracketed(host)}:${port}`, url: `http://${bracketed(host)}:${port}` };
}

/**
 * The ports a running container publishes, as addresses to open: what Docker reports (a port published on both IPv4 and
 * IPv6 is listed twice and is one address), TCP only, the lowest port first.
 */
export function publishedAddresses(ports: readonly Port[] | null | undefined, host: string | null): LocalAddress[] {
  const found = new Map<string, LocalAddress>();
  for (const p of ports ?? []) {
    if (p.public_port === undefined || p.public_port === 0 || p.type !== "tcp") continue;
    const loopback = p.ip === "127.0.0.1" || p.ip === "::1";
    found.set(`${loopback}:${p.public_port}`, localAddress(p.public_port, loopback, host));
  }
  return [...found.values()].sort((a, b) => a.port - b.port);
}
