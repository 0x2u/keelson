import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The regression guard of the step-up policy (lib/step-up-core.ts): a server action that changes something must either ask
 * for the unlock or be on the reviewed list below, with the reason it does not need it. A new action that does neither fails
 * here, so "forgot to ask for the unlock" cannot reach a release unnoticed (the review of 0.1.0-rc1 found seven such).
 *
 * "Asks" is looked for in the action's own source: a call to `stepUpError(...)`, or `change(...)` given a `check:` (the
 * configuration wrapper of lib/config-change.ts). The check is textual on purpose: it is cheap, and an action that hides the
 * call behind a helper is put on the list, with the helper named in its reason.
 */

const APP_DIR = path.resolve(__dirname, "../app");

interface Action {
  key: string;
  file: string;
  name: string;
  source: string;
}

/** Every exported function of every "use server" file under app/, with its source text. */
function actions(): Action[] {
  const files = readdirSync(APP_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => /(^|\/)[^/]*actions\.ts$/.test(f) && !/ 2\.ts$/.test(f))
    .sort();
  const found: Action[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(APP_DIR, file), "utf8");
    if (!/^\s*["']use server["']/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const node of sf.statements) {
      const exported = ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isFunctionDeclaration(node) && node.name) found.push({ key: `${file}:${node.name.text}`, file, name: node.name.text, source: node.getText(sf) });
      else if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
            found.push({ key: `${file}:${d.name.text}`, file, name: d.name.text, source: d.getText(sf) });
          }
        }
      }
    }
  }
  return found;
}

const asksForUnlock = (source: string): boolean => /\bstepUpError\(/.test(source) || /\bchange\([\s\S]*\bcheck:/.test(source);

/** Do not need a session: they are how one starts. */
const PUBLIC: Record<string, string> = {
  "actions.ts:login": "the sign-in form: the password (and the throttle) are the check",
  "actions.ts:verifySecondFactor": "the second step of the sign-in: the pending-login cookie and the code are the check",
  "actions.ts:logout": "ends the caller's own session, whoever holds it",
  "setup/actions.ts:completeSetupAction": "first run only: the one-time setup token is the check, and it is spent with the password",
  "setup/actions.ts:finishRecoveryAction": "the setup step of the session that just set the password: it reads the session itself and only closes the recovery step",
};

/**
 * Reviewed: need a session (checked below) but not the unlock. Each says why; add to this list only after asking whether a
 * stolen session could use the action to make a server run something else, reach somewhere else, or hold a secret it should not.
 */
const NO_UNLOCK: Record<string, string> = {
  // day-to-day work: the policy file says deploying, rolling back and running what is configured never need it
  "actions.ts:deployAction": "deploys a tag or digest of the app's configured image: day-to-day work (step-up-core.ts header)",
  "actions.ts:rollbackAction": "goes back to a version that already ran: day-to-day work",
  "actions.ts:runJobAction": "runs a job as configured; the job's definition is what is guarded (jobChange)",
  "container-actions.ts:containerAction": "start or restart of a container that exists: day-to-day work",
  "projects-actions.ts:promoteAction": "deploys the digest serving in one environment to another: a deployment, day-to-day work",
  "github-actions.ts:buildAction": "builds and deploys the linked repository's commit: a deployment; the link and the build: block are guarded",
  "github-actions.ts:deletePreviewAction": "removes a preview environment: only takes something down",
  // asks for the password again instead
  "api-token-actions.ts:createApiTokenAction": "asks for the password again (confirmPassword); a token can deploy, which is day-to-day work",
  "auth-actions.ts:confirmTotpAction": "finishes the setup that startTotpSetupAction began behind the unlock; proves possession of the new secret",
  "auth-actions.ts:disableTotpAction": "asks for the password again (confirmPassword)",
  "auth-actions.ts:regenerateRecoveryCodesAction": "asks for the password again (confirmPassword)",
  "auth-actions.ts:deletePasskeyAction": "asks for the password again (confirmPassword)",
  "domain-actions.ts:connectCloudflareAction": "asks for the password again (confirmPassword)",
  "domain-actions.ts:disconnectCloudflareAction": "asks for the password again (confirmPassword)",
  "step-up-actions.ts:unlockAction": "is the unlock: the password and the code are checked inside, and failures are throttled",
  // only read, check or plan; nothing is written or reached that the page does not already show
  "auth-actions.ts:pendingTotpSetupAction": "shows the secret of a setup that startTotpSetupAction (unlock) began",
  "step-up-actions.ts:unlockStatusAction": "reads until when this session is unlocked",
  "config-actions.ts:validateConfigAction": "a dry run: nothing is written",
  "project-config-actions.ts:validateProjectConfigAction": "a dry run: nothing is written",
  "project-config-actions.ts:planSplitAction": "a dry run: nothing is written",
  "project-lifecycle-actions.ts:renameFactsAction": "reads what a rename would touch; renameProjectAction (unlock) writes",
  "config-version-actions.ts:configVersionAction": "reads a stored version of the configuration",
  "domain-actions.ts:checkDomainAction": "probes only host names the agent declares, and only the server's own address",
  "github-actions.ts:repoBranchesAction": "lists the branches of a repository the GitHub token or App can read",
  "github-connect-actions.ts:refreshInstallationsAction": "asks GitHub again which repositories the App is installed on",
  "new-project-actions.ts:inspectRepoAction": "reads a repository with the App's token; nothing is applied from here",
  "readiness-actions.ts:verifyKeyAction": "checks a backup key the operator pastes against a backup: no change",
  "readiness-actions.ts:startRestoreTestAction": "restores a backup into a scratch database to prove it works: the live data is untouched",
  "readiness-actions.ts:restoreTestAction": "reads the result of a restore test",
  "readiness-actions.ts:testAlertAction": "sends a test alert to the destinations already configured",
  "relay-actions.ts:connectProgressAction": "reads whether a machine has connected since a time: no code, no secret",
  "relay-actions.ts:relayUpdateProgressAction": "reads which version a server's agent runs and when it last connected, to tell whether an update happened: no code, no secret, starts nothing",
  "relay-actions.ts:connectAddressAction": "reads whether the dashboard's own address is loopback, to warn before a code is made: no secret, nothing started",
  "server-install-actions.ts:hostFingerprintAction": "reads a public SSH host key; the install that trusts it (installOverSshAction) is guarded",
  "release-actions.ts:checkReleaseAction": "asks GitHub which release is the latest (once a minute at most): a read of a public page, sends and changes nothing",
  "server-uninstall-actions.ts:previewUninstallAction": "a dry run: asks what an uninstall would remove; uninstallAgentAction (unlock) does it",
  // only takes access or work away, or touches the dashboard's own bookkeeping
  "api-token-actions.ts:revokeApiTokenAction": "revokes a token: only takes access away",
  "auth-actions.ts:revokeSessionAction": "ends a session: only takes access away",
  "auth-actions.ts:revokeOtherSessionsAction": "ends the other sessions: only takes access away",
  "config-actions.ts:deleteJobAction": "removes a job: a job's definition is what is guarded, removing one only stops it",
  "project-config-actions.ts:splitProjectAction": "moves entities into a file of their own: the agent applies the plan the hash names, so no content changes",
  "github-actions.ts:disconnectGithubAction": "removes the GitHub token: only takes access away",
  "github-actions.ts:removeGithubAppAction": "removes the App: builds stop; only takes access away",
  "github-actions.ts:removeWebhookSecretAction": "removes the secret: webhooks answer 404; only takes access away",
  "github-actions.ts:unlinkRepoAction": "removes the link: builds of the app stop",
  // dashboard-side settings that start nothing by themselves
  "github-actions.ts:connectGithubAction": "the personal token is used to read commits and compare them; builds and webhooks use the App",
  "github-actions.ts:setBuildModesAction": "switches on and off builds of a repository that is already linked (the link is guarded)",
  "github-actions.ts:setAutoDeployAction": "names the workflow of an already linked repository that deploys on success (the link is guarded)",
  "github-actions.ts:setPreviewsAction": "switches previews of an already linked repository (the link and the previews: block are guarded)",
  "apps-domain-actions.ts:saveAppsDomainAction": "a suggestion for new projects' host names; the app that uses one is written behind the unlock",
  "notifications-actions.ts:saveNotificationsDefaultAction": "stores a template in the dashboard; applying it to a server is guarded (lib/notifications-apply.ts)",
  "notifications-actions.ts:applyNotificationsDefaultAction": "lib/notifications-apply.ts asks for the unlock itself, with the destinations it would write",
};

const all = actions();

describe("every server action either asks for the unlock or is reviewed", () => {
  it("finds the actions (the scan itself works)", () => {
    expect(all.length).toBeGreaterThan(60);
    expect(all.map((a) => a.key)).toContain("config-actions.ts:saveAppAction");
    expect(all.map((a) => a.key)).toContain("new-project-actions.ts:createProjectAction");
  });

  it("asks for the unlock, or is on the reviewed list with a reason", () => {
    const unreviewed = all.filter((a) => !asksForUnlock(a.source) && !(a.key in NO_UNLOCK) && !(a.key in PUBLIC)).map((a) => a.key);
    expect(unreviewed, "ask for the unlock (lib/step-up.ts stepUpError, with a policy function of lib/step-up-core.ts), or add it to NO_UNLOCK with the reason").toEqual([]);
  });

  it("keeps the list honest: no entry for an action that is gone or that asks for the unlock now", () => {
    const byKey = new Map(all.map((a) => [a.key, a]));
    for (const key of [...Object.keys(NO_UNLOCK), ...Object.keys(PUBLIC)]) {
      const action = byKey.get(key);
      expect(action, `${key} is on a list but is not an exported action`).toBeDefined();
      if (key in NO_UNLOCK) expect(asksForUnlock(action!.source), `${key} asks for the unlock: take it off NO_UNLOCK`).toBe(false);
    }
    for (const [key, reason] of [...Object.entries(NO_UNLOCK), ...Object.entries(PUBLIC)]) expect(reason.length, key).toBeGreaterThan(15);
  });

  it("starts from a session: everything not public checks one before doing anything", () => {
    // `change` (lib/config-change.ts) and `prepare` (new-project-actions.ts) check it themselves, first thing.
    const withoutSession = all.filter((a) => !(a.key in PUBLIC) && !/\b(requireSession|currentSession|agentOf|change|prepare)\(/.test(a.source)).map((a) => a.key);
    expect(withoutSession).toEqual([]);
  });
});
