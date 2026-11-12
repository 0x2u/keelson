import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { describeField, FieldShell, TextAreaField, TextField, WriteOnlySecretField } from "@/components/forms/fields";

/** `createElement` without the component prop types: these tests pass partial and extra props on purpose. */
const h = createElement as unknown as (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("describeField", () => {
  it("points aria-describedby at the help and the error that exist, and marks only an error as invalid", () => {
    expect(describeField("name", true, "Required")).toEqual({ id: "name", "aria-invalid": true, "aria-describedby": "name-help name-error" });
    expect(describeField("name", true, undefined)).toEqual({ id: "name", "aria-invalid": undefined, "aria-describedby": "name-help" });
    expect(describeField("name", false, undefined)).toEqual({ id: "name", "aria-invalid": undefined, "aria-describedby": undefined });
  });
});

describe("FieldShell marks", () => {
  const shell = (props: Record<string, unknown>) => html(h(FieldShell, { id: "f", label: "Name", ...props }, h("input", { id: "f" })));

  it("marks nothing by default", () => {
    const out = shell({});
    expect(out).not.toContain("(required)");
    expect(out).not.toContain("(optional)");
  });

  it("marks '(optional)' for forms where most fields are needed", () => {
    expect(shell({ optional: true })).toContain("(optional)");
  });

  it("marks '(required)' for forms where most fields are optional, and never both", () => {
    const out = shell({ required: true, optional: true });
    expect(out).toContain("(required)");
    expect(out).not.toContain("(optional)");
  });

  it("ties the label to the control by for/id", () => {
    expect(shell({})).toMatch(/<label[^>]*for="f"/);
  });

  it("prints help and error with the ids that describeField points at, the error as an alert in the -text shade", () => {
    const out = shell({ help: "Shown in lists", error: "Too short" });
    expect(out).toContain('id="f-help"');
    expect(out).toContain('id="f-error"');
    expect(out).toMatch(/id="f-error" role="alert" class="[^"]*text-destructive-text/);
    expect(out).not.toMatch(/text-destructive[ "]/);
  });

  it("names a group of controls by its label and describes it by its notes", () => {
    const out = html(h(FieldShell, { id: "g", label: "Scope", help: "Pick one", error: "Pick one", group: true, optional: true }, h("span", null, "x")));
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-labelledby="g-label"');
    expect(out).toContain('aria-describedby="g-help g-error"');
    expect(out).toContain('id="g-label"');
    expect(out).toContain("(optional)");
  });
});

describe("TextField", () => {
  it("wires the input to its help and error and flags the invalid state", () => {
    const out = html(h(TextField, { id: "url", label: "Agent URL", help: "Where it listens", error: "Not a URL", name: "url", defaultValue: "x", optional: true }));
    expect(out).toContain('id="url"');
    expect(out).toContain('name="url"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="url-help url-error"');
    expect(out).toContain("(optional)");
  });

  it("passes input attributes through and keeps spellcheck and autocomplete off unless asked", () => {
    const out = html(h(TextField, { id: "pw", label: "Password", type: "password", autoComplete: "current-password" }));
    expect(out).toContain('type="password"');
    expect(out).toContain('autoComplete="current-password"');
    expect(out).toContain('spellCheck="false"');
  });

  it("is controlled when given a value", () => {
    expect(html(h(TextField, { id: "n", label: "Name", value: "web", onChange: () => {} }))).toContain('value="web"');
  });
});

describe("TextAreaField", () => {
  it("is wired like TextField", () => {
    const out = html(h(TextAreaField, { id: "ca", label: "CA certificate", error: "Not PEM", name: "ca", optional: true }));
    expect(out).toContain("<textarea");
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="ca-error"');
    expect(out).toContain("(optional)");
  });
});

describe("WriteOnlySecretField", () => {
  it("shows a stored secret as Set with a Replace button and no input", () => {
    const out = html(h(WriteOnlySecretField, { id: "token", label: "API token", isSet: true, help: "Never shown again" }));
    expect(out).toContain("Set");
    expect(out).toContain("Replace");
    expect(out).toContain('aria-describedby="token-help"');
    expect(out).not.toContain("<input");
  });

  it("shows the input when nothing is stored, or when it failed, named after the field", () => {
    const empty = html(h(WriteOnlySecretField, { id: "token", label: "API token", isSet: false }));
    expect(empty).toContain('name="token"');
    expect(empty).toContain('type="password"');
    const failed = html(h(WriteOnlySecretField, { id: "token", label: "API token", isSet: true, error: "Too short" }));
    expect(failed).toContain('aria-invalid="true"');
    expect(failed).toContain("Too short");
  });
});
