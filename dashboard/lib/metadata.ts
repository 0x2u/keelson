import type { Metadata } from "next";

/**
 * The browser-tab title of a page about one thing: its name first, then where it lives, most specific to least
 * ("web", "staging" gives "web · staging"). The root layout's template adds "· Keelson". Names are decoded route
 * parameters, so an empty or missing part is dropped rather than printed.
 */
export function entityTitle(name: string, ...context: (string | undefined)[]): string {
  return [name, ...context].filter((part): part is string => Boolean(part && part.trim())).join(" · ");
}

/** `generateMetadata` result for a page about one named thing; see `entityTitle`. */
export function entityMetadata(name: string, ...context: (string | undefined)[]): Metadata {
  return { title: entityTitle(name, ...context) };
}

/** A route parameter as the name it stands for (`my%20app` is `my app`); a malformed escape is kept as written. */
export function routeName(param: string): string {
  try {
    return decodeURIComponent(param);
  } catch {
    return param;
  }
}
