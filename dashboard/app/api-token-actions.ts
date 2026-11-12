"use server";

import { revalidatePath } from "next/cache";
import { createApiToken, DuplicateTokenNameError, revokeApiToken } from "@/lib/api-tokens";
import { validateNewToken, type ApiScope } from "@/lib/api-tokens-core";
import { audit } from "@/lib/auth/store";
import { confirmPassword } from "@/lib/auth/confirm";
import { listServers } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";

// Tokens are managed here, from the signed-in browser, and nowhere else: no route under /api/v1 can create, list or
// revoke one, so a token can never mint another.

/** What the dialog is shown once, right after creation. The secret is in no other response and nowhere in storage. */
export interface CreatedToken {
  token: string;
  name: string;
  scope: ApiScope;
  servers: string[] | null;
  expiresAt: number;
}

export interface ApiTokenState {
  error?: string;
  created?: CreatedToken;
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** Creating a token hands out access to the fleet: it needs the password again, like a change to the account's factors. */
export async function createApiTokenAction(_prev: ApiTokenState, form: FormData): Promise<ApiTokenState> {
  await requireSession();
  const rejected = await confirmPassword(form);
  if (rejected) return { error: rejected };

  const known = new Set(listServers().map((s) => s.id));
  const limited = text(form, "limit") === "some";
  const chosen = form.getAll("server").filter((v): v is string => typeof v === "string");
  if (limited && chosen.length === 0) return { error: "Choose at least one server, or let the token use all of them." };
  if (limited && chosen.some((id) => !known.has(id))) return { error: "One of the servers no longer exists. Reload the page and try again." };

  const checked = validateNewToken({
    name: text(form, "name"),
    scope: text(form, "scope"),
    servers: limited ? chosen : null,
    days: Number(text(form, "days")),
  });
  if (!checked.ok) return { error: checked.error };

  let made;
  try {
    made = createApiToken(checked.values);
  } catch (err) {
    if (err instanceof DuplicateTokenNameError) return { error: "An active token already has this name. Pick another, or revoke that one." };
    throw err;
  }
  const { record, token } = made;
  audit(
    "api_token_created",
    `${record.name} (${record.prefix}…): ${record.scope}, ${record.servers === null ? "all servers" : `${record.servers.length} server(s)`}, expires ${new Date(record.expiresAt).toISOString().slice(0, 10)}`,
    (await clientInfo()).ip,
  );
  revalidatePath("/settings/api-tokens");
  return { created: { token, name: record.name, scope: record.scope, servers: record.servers, expiresAt: record.expiresAt } };
}

/** Takes effect at once: the next call with the token is a 401. */
export async function revokeApiTokenAction(id: string): Promise<void> {
  await requireSession();
  const revoked = revokeApiToken(id);
  if (revoked) audit("api_token_revoked", `${revoked.name} (${revoked.prefix}…)`, (await clientInfo()).ip);
  revalidatePath("/settings/api-tokens");
}
