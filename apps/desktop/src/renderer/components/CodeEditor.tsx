/**
 * Code editor and viewer with CodeMirror 6. It lives in a shadow root because
 * only there does CodeMirror use adoptedStyleSheets; in the document it would
 * add an inline <style>, which the strict CSP blocks. Colours come from the
 * design tokens, which custom properties carry into the shadow root.
 *
 * Template expressions ({{…}}) are marked with the amber variable chip.
 */
import { useEffect, useRef } from "react";
import { Compartment, EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder as placeholderExt, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { json } from "@codemirror/lang-json";
import { tags as t } from "@lezer/highlight";

const highlight = HighlightStyle.define([
  { tag: [t.keyword], color: "var(--syn-kw)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-str)" },
  { tag: [t.number], color: "var(--syn-num)" },
  { tag: [t.bool, t.null, t.atom], color: "var(--syn-lit)" },
  { tag: [t.propertyName], color: "var(--syn-key)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-com)", fontStyle: "italic" },
  { tag: [t.punctuation, t.bracket, t.separator], color: "var(--syn-punct)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "transparent", color: "var(--ink)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "19px", fontVariantLigatures: "none", fontFeatureSettings: '"calt" 0, "liga" 0' },
  ".cm-content": { padding: "8px 0", caretColor: "var(--ink)" },
  ".cm-gutters": { backgroundColor: "var(--field)", border: "none", color: "var(--faint)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "36px", padding: "0 10px 0 4px" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--ink)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--select) !important" },
  ".cm-matchingBracket": { backgroundColor: "var(--select)", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "var(--hover)" },
  ".cm-placeholder": { color: "var(--faint)" },
  ".cm-tpl": { backgroundColor: "var(--var-bg)", color: "var(--var-ink)", borderRadius: "3px" },
  ".cm-tpl *": { color: "var(--var-ink) !important" },
  ".cm-panels": { backgroundColor: "var(--rail)", color: "var(--ink)", borderTop: "1px solid var(--line)" },
});

const tplMark = Decoration.mark({ class: "cm-tpl" });

/** Marks every {{…}} with the amber chip. */
const templateChips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        for (const m of text.matchAll(/\{\{[\s\S]*?\}\}/g)) builder.add(from + m.index, from + m.index + m[0].length, tplMark);
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

export type CodeLanguage = "json" | "text";
const languageExt = (language: CodeLanguage) => (language === "json" ? json() : []);

interface Props {
  value: string;
  onChange?: (value: string) => void;
  language: CodeLanguage;
  readOnly?: boolean;
  placeholder?: string;
  label: string;
  testId?: string;
  /** Called on Ctrl+S inside the editor. */
  onSave?: () => void;
  lineNumbers?: boolean;
}

export function CodeEditor({ value, onChange, language, readOnly = false, placeholder, label, testId, onSave, lineNumbers: showNumbers = true }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const lang = useRef(new Compartment());
  const ro = useRef(new Compartment());

  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        ...(showNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        lang.current.of(languageExt(language)),
        ro.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        syntaxHighlighting(highlight),
        templateChips,
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (onSaveRef.current?.(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap.filter((k) => k.key !== "Mod-Enter"),
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        ...(placeholder ? [placeholderExt(placeholder)] : []),
        EditorView.contentAttributes.of({ "aria-label": label, ...(testId ? { "data-testid": testId } : {}) }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
        }),
        theme,
      ],
    });
    const el = host.current!;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    view.current = new EditorView({ state, root: shadow, parent: shadow });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // The editor is created once; outside changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(languageExt(language)) });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  return <div className={readOnly ? "cm-host ro" : "cm-host"} ref={host} />;
}
