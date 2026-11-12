import { describe, expect, it } from "vitest";
import config from "../next.config";

describe("next.config", () => {
  // `next dev` logs the arguments of every server action ("createProjectAction(..., [{key, value}])"): several actions
  // take secrets, and a development log is still a log.
  it("never logs the arguments of server functions", () => {
    expect(config.logging).toEqual({ serverFunctions: false });
  });
});
