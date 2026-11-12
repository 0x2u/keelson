"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/auth/store";
import { confirmPassword } from "@/lib/auth/confirm";
import { invalidateInstalledRepos } from "@/lib/github-app";
import { connectBase, createConnectState } from "@/lib/github-connect";
import { buildManifest, isOrgLogin, manifestFormAction, validAppName } from "@/lib/github-connect-core";
import { githubAppSummary, webhookSecretSince } from "@/lib/integrations";
import { clientInfo, currentSession, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { githubApp } from "@/lib/step-up-core";

/** What the Connect GitHub button needs to send the operator to GitHub: a form to post, with the one-time state inside its address. */
export interface ConnectState {
  error?: string;
  start?: { action: string; manifest: string };
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/**
 * Starts GitHub's App manifest flow: checks the public address, creates the single-use state bound to this session and
 * returns the manifest to post to GitHub. When an App or a webhook secret already exists, creating another replaces
 * them (the old App's webhooks stop working), so that needs the explicit confirmation and the password again.
 */
export async function startGithubConnectAction(_prev: ConnectState, form: FormData): Promise<ConnectState> {
  await requireSession();
  // The App created here is the one whose installation tokens build and whose webhooks deploy: it is as sensitive as pasting
  // an App's credentials by hand (saveGithubAppAction).
  const locked = await stepUpError(githubApp(), "connecting a GitHub App");
  if (locked) return { error: locked };
  const base = connectBase();
  if (!base.ok) return { error: base.error };
  const session = await currentSession();
  if (!session) return { error: "Your session ended. Sign in again." };

  const name = validAppName(text(form, "name"));
  if (name === null) return { error: "Give the App a name of 1 to 34 characters." };
  const org = text(form, "account") === "org" ? text(form, "org") : null;
  if (org !== null && !isOrgLogin(org)) return { error: "That is not an organization name: use its login, the last part of github.com/<organization>." };

  const replacing = githubAppSummary() !== null || webhookSecretSince() !== null;
  if (replacing) {
    if (form.get("confirmReplace") !== "on") {
      return { error: "Confirm that the current App and webhook secret are replaced and that the old App's webhooks stop working." };
    }
    const rejected = await confirmPassword(form);
    if (rejected) return { error: rejected };
  }

  const state = createConnectState(session.id);
  audit("github_app_connect_started", `${org === null ? "personal account" : `organization ${org}`}, name "${name}"${replacing ? ", replacing the current App" : ""}`, (await clientInfo()).ip);
  return { start: { action: manifestFormAction(org, state), manifest: JSON.stringify(buildManifest(base.origin, name)) } };
}

/** Looks at GitHub again for the App's installations (the listing is otherwise reused for a minute). */
export async function refreshInstallationsAction(): Promise<void> {
  await requireSession();
  invalidateInstalledRepos();
  revalidatePath("/settings/integrations");
}
