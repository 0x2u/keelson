// The query parameters that open a page's dialog already filled in: the links of the command palette's actions and of
// "Saved. Not running yet". A link only ever opens the dialog that asks; nothing is deployed, rolled back, run or restarted
// until the operator confirms in it.

type Params = Record<string, string | string[] | undefined>;

export interface ActionIntent {
  /** `?deploy=<tag>` on an app's page (empty for none): the deploy dialog, with that version typed in. */
  deploy?: string;
  /** `?rollback=1` on an app's page: the rollback confirmation. */
  rollback: boolean;
  /** `?runnow=1` on a job's page: the run confirmation. (`?run=<id>` is taken: it marks a run.) */
  runNow: boolean;
  /** `?restart=1` or `?start=1` on a container's page. */
  container?: "start" | "restart";
  /** `?add=app` or `?add=environment` on a project's Apps tab: the dialog that adds one. */
  add?: "app" | "environment";
}

export function actionIntent(params: Params): ActionIntent {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const deploy = one(params.deploy);
  const add = one(params.add);
  return {
    ...(deploy === undefined ? {} : { deploy }),
    ...(add === "app" || add === "environment" ? { add } : {}),
    rollback: one(params.rollback) === "1",
    runNow: one(params.runnow) === "1",
    ...(one(params.restart) === "1" ? { container: "restart" as const } : one(params.start) === "1" ? { container: "start" as const } : {}),
  };
}
