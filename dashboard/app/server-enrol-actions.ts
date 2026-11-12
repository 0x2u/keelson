"use server";

import { revalidatePath } from "next/cache";
import { enrolServer, type EnrolResult } from "@/lib/enroll";
import { clientInfo, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { servers } from "@/lib/step-up-core";

/**
 * Enrols an agent from the string `keelson-agent enroll-code` printed. The string holds a one-time code: it is used for this
 * call only and never stored, logged or echoed back.
 */
export async function enrolServerAction(enrolment: string, name: string): Promise<EnrolResult> {
  await requireSession();
  const locked = await stepUpError(servers("add"), "enrolling a server");
  if (locked) return { ok: false, message: locked };
  const result = await enrolServer(enrolment, name, (await clientInfo()).ip);
  if (result.ok) revalidatePath("/", "layout");
  return result;
}
