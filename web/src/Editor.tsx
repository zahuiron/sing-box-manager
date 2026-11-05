import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeFromList,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo,
  redo,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  delimitedIndent,
  HighlightStyle,
  indentNodeProp,
  LRLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { styleTags, tags } from "@lezer/highlight";
import { parser } from "lezer-json5";

const configLanguage = LRLanguage.define({
  parser: parser.configure({
    props: [
      styleTags({
        PropertyName: tags.propertyName,
        String: tags.string,
        Number: tags.number,
        "True False": tags.bool,
        Null: tags.null,
        "LineComment BlockComment": tags.comment,
        "{ } [ ]": tags.bracket,
        "PropertyColon ,": tags.separator,
      }),
      indentNodeProp.add({
        Object: delimitedIndent({ closing: "}" }),
        Array: delimitedIndent({ closing: "]" }),
      }),
    ],
  }),
  languageData: {
    closeBrackets: { brackets: ["{", "[", '"'] },
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
  },
});

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--text-md)",
    color: "var(--text)",
    backgroundColor: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.3",
    borderRadius: "var(--radius-md)",
  },
  ".cm-content": { caretColor: "var(--text)", padding: "12px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-gutters": {
    color: "var(--text-faint)",
    backgroundColor: "var(--surface)",
    border: "none",
    padding: "12px 0",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  ".cm-matchingBracket": { backgroundColor: "var(--highlight)" },
  ".cm-searchMatch": {
    backgroundColor: "var(--medium-soft)",
    outline: "1px solid var(--medium)",
  },
  ".cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
  ".cm-panels, .cm-tooltip": {
    color: "var(--text)",
    backgroundColor: "var(--card)",
    border: "1px solid var(--border)",
  },
  ".cm-panel.cm-search": {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
  },
  ".cm-textfield": {
    color: "var(--text)",
    backgroundColor: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-xs)",
  },
  ".cm-button": {
    color: "var(--text)",
    backgroundImage: "none",
    backgroundColor: "var(--hover)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-xs)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    color: "var(--text)",
    background: "var(--accent-soft)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { background: "var(--highlight)" },
});
const highlighting = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--info)" },
  { tag: tags.string, color: "var(--good)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--medium)" },
  { tag: tags.comment, color: "var(--text-faint)", fontStyle: "italic" },
]);
const complete = completeFromList(
  [
    "log",
    "dns",
    "ntp",
    "certificate",
    "certificate_providers",
    "inbounds",
    "outbounds",
    "route",
    "experimental",
    "endpoints",
    "type",
    "tag",
    "server",
    "server_port",
    "listen",
    "listen_port",
    "tls",
    "enabled",
    "domain",
    "certificate_provider",
  ].map((label) => ({ label: `"${label}"`, type: "property" })),
);

export interface EditorHandle {
  undo(): void;
  redo(): void;
}
export default function Editor({
  value,
  onChange,
  onSave,
  disabled,
  editorRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  disabled: boolean;
  editorRef: Ref<EditorHandle>;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const editable = useRef(new Compartment());
  const lineEnding = useRef(new Compartment());
  useImperativeHandle(
    editorRef,
    () => ({
      undo: () => {
        if (view.current) undo(view.current);
      },
      redo: () => {
        if (view.current) redo(view.current);
      },
    }),
    [],
  );
  useEffect(() => {
    const editor = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          theme,
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          configLanguage,
          bracketMatching(),
          closeBrackets(),
          syntaxHighlighting(highlighting),
          search({ top: true }),
          autocompletion({ override: [complete] }),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          editable.current.of(EditorState.readOnly.of(disabled)),
          lineEnding.current.of(
            EditorState.lineSeparator.of(
              value.includes("\r\n") ? "\r\n" : "\n",
            ),
          ),
          EditorView.contentAttributes.of({
            "aria-label": "sing-box configuration",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.sliceDoc());
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
    if (editor && editor.state.sliceDoc() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        effects: lineEnding.current.reconfigure(
          EditorState.lineSeparator.of(value.includes("\r\n") ? "\r\n" : "\n"),
        ),
      });
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorState.readOnly.of(disabled)),
    });
  }, [disabled]);
  return <div className="editor-host" ref={parent} />;
}
