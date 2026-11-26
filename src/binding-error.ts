// How a binding's thrown or rejected value is sent to the page (see
// Webview.bind). Its own module so the package's tests can import it by path;
// src/index.ts does not re-export it.

// The JSON a binding's thrown or rejected value reaches the page as. An
// `Error` becomes its message (JSON.stringify gives `{}` for one), undefined
// becomes "" (the page's promise rejects with undefined), and anything
// JSON.stringify refuses (a cycle, a BigInt) or drops (a function, a symbol)
// becomes its String() form.
export function serializeBindingError(err: unknown): string {
  if (err === undefined) return "";
  if (err instanceof Error) return JSON.stringify(err.message);
  try {
    const json = JSON.stringify(err);
    if (json !== undefined) return json;
  } catch {
    // Falls through to String().
  }
  try {
    return JSON.stringify(String(err));
  } catch {
    return JSON.stringify("binding failed");
  }
}
