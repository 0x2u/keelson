/** A short "Browser on OS" label for a User-Agent header, for telling sessions apart. */
export function parseUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown browser";
  const browser = browserOf(ua);
  const os = osOf(ua);
  if (!browser) return os ? `Unknown browser on ${os}` : "Unknown browser";
  return os ? `${browser} on ${os}` : browser;
}

// Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari".
function browserOf(ua: string): string | null {
  if (/\b(Edg|EdgA|EdgiOS|Edge)\//.test(ua)) return "Edge";
  if (/\b(OPR|Opera)\//.test(ua)) return "Opera";
  if (/\b(Firefox|FxiOS)\//.test(ua)) return "Firefox";
  if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) return "Chrome";
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "Safari";
  return null;
}

// Order matters: Android and iOS user agents also mention Linux and Mac OS X.
function osOf(ua: string): string | null {
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return "iOS";
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macOS";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bLinux\b|\bX11\b/.test(ua)) return "Linux";
  return null;
}
