import { BlockList, isIP } from "node:net";

/** A set of addresses and CIDR ranges, such as "203.0.113.7, 10.0.0.0/8, 2001:db8::/32". */
export interface Allowlist {
  allows(ip: string): boolean;
}

/** Throws with the offending entry, so a typo stops the dashboard instead of silently opening or closing it. */
export function parseAllowlist(spec: string): Allowlist {
  const list = new BlockList();
  const entries = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("KEELSON_ALLOWED_IPS is set but empty");
  for (const entry of entries) {
    const [address, bits, extra] = entry.split("/");
    const family = isIP(address);
    if (family === 0 || extra !== undefined) throw new Error(`KEELSON_ALLOWED_IPS: "${entry}" is not an address or a CIDR range`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(bits);
    if (!/^\d{1,3}$/.test(bits) || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(`KEELSON_ALLOWED_IPS: "${entry}" has an invalid prefix length`);
    }
    list.addSubnet(address, prefix, type);
  }
  return {
    allows(ip: string): boolean {
      // "::ffff:203.0.113.7" is the IPv4 address as an IPv6 socket reports it.
      const plain = ip.replace(/^::ffff:/i, "");
      const family = isIP(plain);
      if (family === 0) return false;
      return list.check(plain, family === 4 ? "ipv4" : "ipv6");
    },
  };
}
