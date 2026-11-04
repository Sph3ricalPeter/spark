// Tags JSX with where it lives in the source, so a click in the running app
// can be traced back to a file, line and column.
//
// - A DOM element (`<div>`, `<button>`) gets `data-spark-src="file:line:col"`
//   and `data-spark-comp="<component it is written in>"`.
// - A component call site (`<Button>`) gets `data-spark-call="file:line:col"`.
//   React keeps it in the instance's props, so the client finds it on the
//   fiber: that's how an edit to one instance knows which line to change.
//
// Attributes are inserted on the same line as the tag, so line numbers in
// stack traces and source maps stay right; only columns shift.
import ts from "typescript";

/** Components that don't accept arbitrary props. */
const SKIP = new Set(["Fragment", "StrictMode", "Suspense", "Profiler"]);

export function tagJsx(code: string, fileName: string, relPath: string): string | null {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const inserts: { at: number; text: string }[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const insert = tagFor(node, sf, relPath);
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
): { at: number; text: string } | null {
  // `<Foo.Bar>` and `<svg:rect>` are left alone.
  if (!ts.isIdentifier(node.tagName)) return null;
  const name = node.tagName.text;
  const has = (attr: string) =>
    node.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === attr);

  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const loc = `${relPath}:${line + 1}:${character + 1}`;
  const at = node.attributes.pos;

  if (/^[a-z]/.test(name)) {
    if (has("data-spark-src")) return null;
    const comp = enclosingComponent(node);
    const compAttr = comp ? ` data-spark-comp="${comp}"` : "";
    return { at, text: ` data-spark-src="${loc}"${compAttr}` };
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
