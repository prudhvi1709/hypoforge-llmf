import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.mjs";

const pyodideReadyPromise = loadPyodide();

self.onmessage = async (event) => {
  // make sure loading is done
  const pyodide = await pyodideReadyPromise;
  const { id, code, data, context } = event.data;

  // Now load any packages we need
  await pyodide.loadPackagesFromImports(code);
  // Change the globals() each time
  const dict = pyodide.globals.get("dict");
  const globals = dict(Object.entries(context));
  globals.set("data", pyodide.toPy(data));
  try {
    const resultProxy = await pyodide.runPythonAsync(code, { globals });
    const result = resultProxy.toJs();
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: e.message });
    return;
  }
};
