/**
 * How a dashboard that has no https address gets one, in the words every place that needs it uses (GitHub's connect page,
 * the passkeys card, the messages of the server actions). The mechanism is the installer's: `--domain` writes
 * KEELSON_DOMAIN and the compose override that puts Caddy (and its certificate) in front; or the operator's own proxy
 * serves the dashboard and `KEELSON_PUBLIC_URL` goes into `dashboard.env`, which compose.yaml reads when it exists.
 */

export const INSTALL_WITH_DOMAIN = "curl -fsSL https://github.com/0x2u/keelson/releases/latest/download/install.sh | sudo sh -s -- --domain keelson.example.com";

/** The folder the installer uses unless it was told another with `--dir`. */
export const INSTALL_DIR = "/opt/keelson";

/** In one sentence, for an error that has no room for steps (a toast, a plain page). It names the variable and where to set it. */
export const PUBLIC_URL_HOW =
  `Serve the dashboard at an https domain: run the installer again with --domain keelson.example.com (the name must point at this machine, ports 80 and 443 open), or, when your own proxy already serves it, add KEELSON_PUBLIC_URL=https://keelson.example.com to ${INSTALL_DIR}/dashboard.env and run docker compose up -d in ${INSTALL_DIR}.`;

/** The page that says how to give a server a proxy and serve apps on a domain (the section is at the top of the page). */
export const PROXY_DOCS_URL = "https://github.com/0x2u/keelson/blob/main/docs/reference/proxy.md#serve-apps-on-a-domain";

/** The command that prints the first-run setup token, run in the installer's folder. */
export const SETUP_TOKEN_COMMAND = `cd ${INSTALL_DIR} && docker compose logs dashboard | grep "setup token"`;

/** Where the docs say how to reset a lost password from the server (there is no "forgot password" screen). */
export const LOST_PASSWORD_DOCS_URL = "https://github.com/0x2u/keelson/blob/main/docs/hosting.md#lost-password";
