// Tags JSX with where it lives in the source, so a click in the running app
// can be traced back to a file, line and column.
//
// - A DOM element (`<div>`, `<button>`) gets `data-spark-src="file:line:col"`
//   and `data-spark-comp="<component it is written in>"`.
// - A component call site (`<Button>`) gets `data-spark-call="file:line:col"`.
//   React keeps it in the instance's props, so the client finds it on the
//   fiber: that's how an edit to one instance knows which line to change.
//
// - An icon from an icon library (`<Undo2 />` imported from lucide-react) is
//   tagged like a DOM element instead, plus `data-spark-icon="lucide-react:Undo2"`:
//   the library passes the attributes on to the `<svg>` it renders, so the
//   icon is picked as one leaf, written where it's used, and the inspector
//   knows which icon of which library it is.
//
// Attributes are inserted on the same line as the tag, so line numbers in
// stack traces and source maps stay right; only columns shift.
import ts from "typescript";

/** Components that don't accept arbitrary props. */
const SKIP = new Set(["Fragment", "StrictMode", "Suspense", "Profiler"]);

/**
 * Icon libraries whose icons are components that render one `<svg>` and pass
 * extra props on to it. Each is a module of named icon exports (subpaths like
 * `react-icons/fa` are a library each).
 */
export const ICON_LIBRARY =
  /^(lucide-react|lucide-preact|react-icons\/[\w-]+|@heroicons\/react\/[\w/-]+|@tabler\/icons-react|@phosphor-icons\/react|phosphor-react|react-feather|@radix-ui\/react-icons|react-bootstrap-icons|@mui\/icons-material)$/;

/** Local name → `library:Icon` for this file's icon imports. */
function iconImports(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause || st.importClause.isTypeOnly) continue;
    const spec = st.moduleSpecifier.text;
    const clause = st.importClause;
    // MUI: `import Delete from "@mui/icons-material/Delete"`.
    const mui = /^(@mui\/icons-material)\/(\w+)$/.exec(spec);
    if (mui && clause.name) out.set(clause.name.text, `${mui[1]}:${mui[2]}`);
    if (!ICON_LIBRARY.test(spec)) continue;
    const named = clause.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (el.isTypeOnly) continue;
      const name = (el.propertyName ?? el.name).text;
      if (/^[A-Z]/.test(name)) out.set(el.name.text, `${spec}:${name}`);
    }
  }
  return out;
}

export function tagJsx(code: string, fileName: string, relPath: string): string | null {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const inserts: { at: number; text: string }[] = [];
  const icons = iconImports(sf);

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const insert = tagFor(node, sf, relPath, icons);
      if (insert) inserts.push(insert);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (inserts.length === 0) return null;
  // Splice from the end so earlier positions stay valid.
  inserts.sort((a, b) => b.at - a.at);
  let out = code;
  for (const { at, text } of inserts) out = out.slice(0, at) + text + out.slice(at);
  return out;
}

function tagFor(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
  relPath: string,
  icons: Map<string, string>,
): { at: number; text: string } | null {
  // `<Foo.Bar>` and `<svg:rect>` are left alone.
  if (!ts.isIdentifier(node.tagName)) return null;
  const name = node.tagName.text;
  const has = (attr: string) =>
    node.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === attr);

  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const loc = `${relPath}:${line + 1}:${character + 1}`;
  const at = node.attributes.pos;

  const icon = icons.get(name);
  if (/^[a-z]/.test(name) || icon) {
    if (has("data-spark-src")) return null;
    const comp = enclosingComponent(node);
    const compAttr = comp ? ` data-spark-comp="${comp}"` : "";
    const iconAttr = icon ? ` data-spark-icon="${icon}"` : "";
    return { at, text: ` data-spark-src="${loc}"${compAttr}${iconAttr}` };
  }
  if (SKIP.has(name) || has("data-spark-call")) return null;
  return { at, text: ` data-spark-call="${loc}"` };
}

/** The name of the nearest function that looks like a component (Capitalized). */
function enclosingComponent(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isFunctionDeclaration(n) && !ts.isFunctionExpression(n) && !ts.isArrowFunction(n)) continue;
    const name = functionName(n);
    if (name && /^[A-Z]/.test(name)) return name;
  }
  return null;
}

function functionName(fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction): string | null {
  if (fn.name) return fn.name.text;
  // const Foo = () => …, or const Foo = memo(() => …) / forwardRef(…)
  let p: ts.Node = fn.parent;
  while (ts.isCallExpression(p) || ts.isParenthesizedExpression(p)) p = p.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}
