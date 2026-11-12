"use client";

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { yaml } from "@codemirror/lang-yaml";
import { tags } from "@lezer/highlight";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { ConfigIssue } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

export interface YamlEditorHandle {
  /** Moves the cursor to the start of a 1-based line and scrolls it into view. */
  scrollToLine(line: number): void;
}

interface Style {
  [property: string]: string | number | Style;
}

/**
 * Builds a theme from the design tokens. CodeMirror ships its own light and dark base styles, which a theme rule
 * only beats when it is more specific, so every value is marked important. The colours are CSS variables, so
 * the editor follows the `.dark` class without being rebuilt.
 */
function themed(styles: Record<string, Style>) {
  const important = (style: Style): Style =>
    Object.fromEntries(Object.entries(style).map(([property, value]) => [property, typeof value === "string" ? `${value} !important` : value]));
  const spec: Record<string, Style> = {};
  for (const [selector, style] of Object.entries(styles)) spec[`&${selector}`] = important(style);
  return EditorView.theme(spec);
}

const SELECTION = "color-mix(in srgb, var(--ring) 28%, transparent)";

const theme = themed({
  "": { height: "100%", backgroundColor: "var(--background)", color: "var(--foreground)", fontSize: "13px" },
  ".cm-focused": { outline: "none" },
  " .cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
  " .cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
  " .cm-cursor": { borderLeftColor: "var(--foreground)" },
  " .cm-selectionBackground": { backgroundColor: SELECTION },
  ".cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { backgroundColor: SELECTION },
  " .cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 70%, transparent)" },
  " .cm-gutters": { backgroundColor: "var(--muted)", color: "var(--muted-foreground)", border: "none", borderRight: "1px solid var(--border)" },
  " .cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", fontVariantNumeric: "tabular-nums" },
  " .cm-activeLineGutter": { backgroundColor: "var(--accent)", color: "var(--foreground)" },
  " .cm-foldPlaceholder": { backgroundColor: "var(--muted)", border: "1px solid var(--border)", color: "var(--muted-foreground)" },
  ".cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--info) 25%, transparent)", outline: "none" },
  ".cm-focused .cm-nonmatchingBracket": { backgroundColor: "color-mix(in srgb, var(--destructive) 25%, transparent)" },
  " .cm-tooltip": { backgroundColor: "var(--card)", color: "var(--foreground)", border: "1px solid var(--border)", borderRadius: "6px", overflow: "hidden" },
  " .cm-diagnostic": { fontFamily: "var(--font-sans)", fontSize: "12px" },
  " .cm-diagnostic-error": { borderLeftColor: "var(--destructive)" },
  " .cm-diagnostic-warning": { borderLeftColor: "var(--warning)" },
  " .cm-yaml-scalar": { color: "var(--warning)" },
});

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--info)" },
    { tag: tags.string, color: "var(--success)" },
    { tag: [tags.lineComment, tags.meta], color: "var(--muted-foreground)", fontStyle: "italic" },
    { tag: [tags.separator, tags.punctuation, tags.squareBracket, tags.brace], color: "var(--muted-foreground)" },
    { tag: [tags.labelName, tags.typeName], fontWeight: "600" },
  ]),
);

/** Numbers, booleans and null written as plain values: the YAML grammar does not tell them from other plain text. */
const scalars = new MatchDecorator({
  regexp: /(?<=[:-] )(?:true|false|null|~|-?\d+(?:\.\d+)?)(?=\s*(?:#.*)?$)/g,
  decoration: Decoration.mark({ class: "cm-yaml-scalar" }),
});

const scalarColours = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = scalars.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = scalars.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const readOnlyState = new Compartment();

/** Marks a change that came from the `value` prop, so it is not reported back through `onChange`. */
const fromProps = Annotation.define<boolean>();

/** One marker per issue that names a line, spanning the line's text. */
function diagnosticsFor(state: EditorState, issues: ConfigIssue[]): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const issue of issues) {
    if (issue.line === undefined || issue.line < 1) continue;
    const line = state.doc.line(Math.min(issue.line, state.doc.lines));
    const from = Math.min(line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0), line.to);
    found.push({
      from,
      to: line.to,
      severity: issue.severity,
      message: issue.path === "yaml" ? issue.message : `${issue.path}: ${issue.message}`,
    });
  }
  return found;
}

/**
 * A YAML editor (CodeMirror 6). The text is controlled through `value`/`onChange`; the editor itself is created once.
 * Escape then Tab moves focus out of the editor, so keyboard users are never trapped by Tab indenting.
 */
export function YamlEditor({
  value,
  onChange,
  issues = [],
  readOnly = false,
  label,
  className,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Issues with a line get an inline marker and a gutter icon. */
  issues?: ConfigIssue[];
  readOnly?: boolean;
  /** Accessible name of the text area. */
  label: string;
  className?: string;
  ref?: Ref<YamlEditorHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange, readOnly, label });

  useEffect(() => {
    latest.current = { value, onChange, readOnly, label };
  });

  useEffect(() => {
    const initial = latest.current;
    const editor = new EditorView({
      parent: host.current ?? undefined,
      state: EditorState.create({
        doc: initial.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          lintGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          EditorState.tabSize.of(2),
          indentUnit.of("  "),
          EditorView.lineWrapping,
          yaml(),
          highlight,
          scalarColours,
          theme,
          readOnlyState.of(EditorState.readOnly.of(initial.readOnly)),
          EditorView.contentAttributes.of({ "aria-label": initial.label }),
          keymap.of([
            // Tab indents, so Escape hands it back to the browser for a moment: Escape, then Tab, leaves the editor.
            {
              key: "Escape",
              run: (target) => {
                target.setTabFocusMode(2000);
                return false;
              },
            },
            indentWithTab,
            ...foldKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromProps))) {
              latest.current.onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) editor.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: fromProps.of(true) });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (editor) editor.dispatch(setDiagnostics(editor.state, diagnosticsFor(editor.state, issues)));
  }, [issues]);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnlyState.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(line) {
        const editor = view.current;
        if (!editor) return;
        const target = editor.state.doc.line(Math.max(1, Math.min(line, editor.state.doc.lines)));
        editor.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
        editor.focus();
      },
    }),
    [],
  );

  return (
    <div
      ref={host}
      className={cn(
        "overflow-hidden rounded-md border bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        className,
      )}
    />
  );
}
