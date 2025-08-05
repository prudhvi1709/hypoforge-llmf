// import { render, html } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { asyncLLM } from "https://cdn.jsdelivr.net/npm/asyncllm@2";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import hljs from "https://cdn.jsdelivr.net/npm/highlight.js@11/+esm";
import { parse } from "https://cdn.jsdelivr.net/npm/partial-json@0.1.7/+esm";
import sqlite3InitModule from "https://esm.sh/@sqlite.org/sqlite-wasm@3.46.1-build3";
// import { getProfile } from "https://aipipe.org/aipipe.js";

const pyodideWorker = new Worker("./pyworker.js", { type: "module" });

const $demos = document.getElementById("demos");
const $hypotheses = document.getElementById("hypotheses");
const $hypothesisPrompt = document.getElementById("hypothesis-prompt");
const $synthesis = document.getElementById("synthesis");
const $synthesisResult = document.getElementById("synthesis-result");
const $status = document.getElementById("status");
const $fileUpload = document.getElementById("file-upload");
const loading = /* html */ `<div class="text-center my-5"><div class="spinner-border" role="status"></div></div>`;

let data;
let description;
let hypotheses;

const marked = new Marked();
marked.use({
  renderer: {
    table(header, body) {
      return `<table class="table table-sm">${header}${body}</table>`;
    },
    code(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return /* html */ `<pre class="hljs language-${language}"><code>${hljs
        .highlight(code, { language })
        .value.trim()}</code></pre>`;
    },
  },
});

// Ensure that the user is logged in
let token = "";
async function fetchToken() {
  try {
    const response = await fetch("https://llmfoundry.straive.com/token", {
      credentials: "include"
    });
    const data = await response.json();
    token = data.token || "";
    if (!token) {
      throw new Error("Failed to get token");
    }
    return token;
  } catch (error) {
    console.error("Error fetching token:", error);
    $status.innerHTML = `<div class="alert alert-danger">Failed to authenticate. Please login to LLM Foundry first.</div>`;
    throw error;
  }
}

// Load configurations and render the demos
$status.innerHTML = loading;
const { demos } = await fetch("config.json").then((r) => r.json());
$demos.innerHTML = demos
  .map(
    ({ title, body }, index) => /* html */ `
      <div class="col py-3">
        <a class="demo card h-100 text-decoration-none" href="#" data-index="${index}">
          <div class="card-body">
            <h5 class="card-title">${title}</h5>
            <p class="card-text">${body}</p>
          </div>
        </a>
      </div>
    `
  )
  .join("");

// Get token before proceeding
try {
  await fetchToken();
} catch (error) {
  // Already handled in fetchToken
}

const numFormat = new Intl.NumberFormat("en-US", {
  style: "decimal",
  notation: "compact",
  compactDisplay: "short",
});
const num = (val) => numFormat.format(val);
const dateFormat = d3.timeFormat("%Y-%m-%d %H:%M:%S");

const hypothesesSchema = {
  type: "object",
  properties: {
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hypothesis: {
            type: "string",
          },
          benefit: {
            type: "string",
          },
        },
        required: ["hypothesis", "benefit"],
        additionalProperties: false,
      },
    },
  },
  required: ["hypotheses"],
  additionalProperties: false,
};

const describe = (data, col) => {
  const values = data.map((d) => d[col]);
  const firstVal = values[0];
  if (typeof firstVal === "string") {
    // Return the top 3 most frequent values
    const freqMap = d3.rollup(
      values,
      (v) => v.length,
      (d) => d
    );
    const topValues = Array.from(freqMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([val, count]) => `${val.length > 100 ? val.slice(0, 100) + "..." : val} (${count})`);
    return `string. ${[...freqMap.keys()].length} unique values. E.g. ${topValues.join(", ")}`;
  } else if (typeof firstVal === "number") {
    return `numeric. mean: ${num(d3.mean(values))} min: ${num(d3.min(values))} max: ${num(d3.max(values))}`;
  } else if (firstVal instanceof Date) {
    return `date. min: ${dateFormat(d3.min(values))} max: ${dateFormat(d3.max(values))}`;
  }
  return "";
};

const testButton = (index) =>
  /* html */ `<button type="button" class="btn btn-sm btn-primary test-hypothesis" data-index="${index}">Test</button>`;

// Add support for SQLite files
async function loadData(source) {
  // Handle file upload
  if (source instanceof File) {
    const fileName = source.name.toLowerCase();
    if (fileName.match(/\.(sqlite3|sqlite|db|s3db|sl3)$/i)) {
      // Load SQLite database from uploaded file
      const buffer = await source.arrayBuffer();
      const dbName = source.name;
      await sqlite3.capi.sqlite3_js_posix_create_file(dbName, new Uint8Array(buffer));
      // Copy tables from the uploaded database to a new DB instance
      const uploadDB = new sqlite3.oo1.DB(dbName, "r");
      const tables = uploadDB.exec("SELECT name FROM sqlite_master WHERE type='table'", { rowMode: "object" });
      if (!tables.length) {
        throw new Error("No tables found in database");
      }
      // Get data from the first table
      const tableName = tables[0].name;
      const result = uploadDB.exec(`SELECT * FROM "${tableName}"`, { rowMode: "object" });
      // Clean up
      uploadDB.close();
      return result;
    } else if (fileName.endsWith('.csv')) {
      // Load CSV from uploaded file
      const text = await source.text();
      return d3.csvParse(text, d3.autoType);
    } else {
      throw new Error("Unsupported file format. Please upload a CSV or SQLite file.");
    }
  } else if (typeof source === 'object' && source.href) {
    // Handle demo data
    if (source.href.match(/\.(sqlite3|sqlite|db|s3db|sl3)$/i)) {
      // Load SQLite database
      const response = await fetch(source.href);
      const buffer = await response.arrayBuffer();
      const dbName = source.href.split("/").pop();
      await sqlite3.capi.sqlite3_js_posix_create_file(dbName, new Uint8Array(buffer));
      // Copy tables from the uploaded database to a new DB instance
      const uploadDB = new sqlite3.oo1.DB(dbName, "r");
      const tables = uploadDB.exec("SELECT name FROM sqlite_master WHERE type='table'", { rowMode: "object" });
      if (!tables.length) {
        throw new Error("No tables found in database");
      }
      // Get data from the first table
      const tableName = tables[0].name;
      const result = uploadDB.exec(`SELECT * FROM "${tableName}"`, { rowMode: "object" });
      // Clean up
      uploadDB.close();
      return result;
    } else {
      // Load CSV as before
      return d3.csv(source.href, d3.autoType);
    }
  }
}

// Handle file upload - trigger automatically when file is selected
$fileUpload.addEventListener("change", async () => {
  if (!$fileUpload.files.length) {
    return;
  }

  const file = $fileUpload.files[0];
  $status.innerHTML = loading;
  
  try {
    // Refresh token before making API calls
    await fetchToken();
    
    data = await loadData(file);
    const columnDescription = Object.keys(data[0])
      .map((col) => `- ${col}: ${describe(data, col)}`)
      .join("\n");
    const numColumns = Object.keys(data[0]).length;
    description = `The Pandas DataFrame df has ${data.length} rows and ${numColumns} columns:\n${columnDescription}`;
    
    // Use existing prompt or default for uploaded files
    const systemPrompt = $hypothesisPrompt.value || "You are an expert data analyst. Generate hypotheses that would be valuable to test on this dataset. Each hypothesis should be clear, specific, and testable.";
    
    const body = {
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: description },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "HypothesesResponse",
          schema: hypothesesSchema
        }
      }
    };

    $hypotheses.innerHTML = loading;
    for await (const { content } of asyncLLM("https://llmfoundry.straive.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:hypoforge` },
      credentials: "include",
      body: JSON.stringify(body),
    })) {
      if (!content) continue;
      ({ hypotheses } = parse(content));
      drawHypotheses();
    }
    $synthesis.classList.remove("d-none");
    // Clear the status spinner after processing completes
    $status.innerHTML = "";
  } catch (error) {
    $status.innerHTML = `<div class="alert alert-danger">${error.message}</div>`;
    // Auto-clear error message after 5 seconds
    setTimeout(() => {
      $status.innerHTML = "";
    }, 5000);
  }
});

// When the user clicks on a demo, analyze it
$demos.addEventListener("click", async (e) => {
  e.preventDefault();
  const $demo = e.target.closest(".demo");
  if (!$demo) return;

  const demo = demos[+$demo.dataset.index];
  $status.innerHTML = loading;
  
  try {
    // Refresh token before making API calls
    await fetchToken();
    
    data = await loadData(demo);
    const columnDescription = Object.keys(data[0])
      .map((col) => `- ${col}: ${describe(data, col)}`)
      .join("\n");
    const numColumns = Object.keys(data[0]).length;
    description = `The Pandas DataFrame df has ${data.length} rows and ${numColumns} columns:\n${columnDescription}`;
    const systemPrompt = $hypothesisPrompt.value || demo.audience;
    const body = {
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: description },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "HypothesesResponse",
          schema: hypothesesSchema
        }
      }
    };

    $hypotheses.innerHTML = loading;
    for await (const { content } of asyncLLM("https://llmfoundry.straive.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:hypoforge` },
      credentials: "include",
      body: JSON.stringify(body),
    })) {
      if (!content) continue;
      ({ hypotheses } = parse(content));
      drawHypotheses();
    }
    $synthesis.classList.remove("d-none");
    // Clear the status spinner after processing completes
    $status.innerHTML = "";
  } catch (error) {
    $status.innerHTML = `<div class="alert alert-danger">${error.message}</div>`;
    // Auto-clear error message after 5 seconds
    setTimeout(() => {
      $status.innerHTML = "";
    }, 5000);
  }
});

function drawHypotheses() {
  if (!Array.isArray(hypotheses)) return;
  $hypotheses.innerHTML = hypotheses
    .map(
      ({ hypothesis, benefit }, index) => /* html */ `
      <div class="hypothesis col py-3" data-index="${index}">
        <div class="card h-100">
          <div class="card-body">
            <h5 class="card-title hypothesis-title">${hypothesis}</h5>
            <p class="card-text hypothesis-benefit">${benefit}</p>
          </div>
          <div class="card-footer">
            <div class="result">${testButton(index)}</div>
            <div class="outcome"></div>
          </div>
        </div>
      </div>
    `
    )
    .join("");
}

$hypotheses.addEventListener("click", async (e) => {
  const $hypothesis = e.target.closest(".test-hypothesis");
  if (!$hypothesis) return;
  const index = $hypothesis.dataset.index;
  const hypothesis = hypotheses[index];

  // Refresh token before making API calls
  try {
    await fetchToken();
  } catch (error) {
    return; // Error already handled in fetchToken
  }

  const systemPrompt = document.getElementById("analysis-prompt").value;
  const body = {
    model: "gpt-4.1-nano",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Hypothesis: ${hypothesis.hypothesis}\n\n${description}` },
    ],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
  };

  const $resultContainer = $hypothesis.closest(".card");
  const $result = $resultContainer.querySelector(".result");
  const $outcome = $resultContainer.querySelector(".outcome");
  let generatedContent;
  for await (const { content } of asyncLLM("https://llmfoundry.straive.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:hypoforge` },
    credentials: "include",
    body: JSON.stringify(body),
  })) {
    if (!content) continue;
    generatedContent = content;
    $result.innerHTML = marked.parse(content);
  }

  // Extract the code inside the last ```...``` block
  let code = [...generatedContent.matchAll(/```python\n*([\s\S]*?)\n```(\n|$)/g)].at(-1)[1];
  code += "\n\ntest_hypothesis(pd.DataFrame(data))";

  $outcome.innerHTML = loading;

  const listener = async (event) => {
    const { result, error } = event.data;
    pyodideWorker.removeEventListener("message", listener);

    if (error) {
      $outcome.innerHTML = `<pre class="alert alert-danger">${error}</pre>`;
      return;
    }
    const [success, pValue] = result;
    $outcome.classList.add(pValue < 0.05 ? "success" : "failure");
    const body = {
      model: "gpt-4.1-nano",
      messages: [
        {
          role: "system",
          content: `You are an expert data analyst.
Given a hypothesis and its outcome, provide a plain English summary of the findings as a crisp H5 heading (#####), followed by 1-2 concise supporting sentences.
Highlight in **bold** the keywords in the supporting statements.
Do not mention the p-value but _interpret_ it to support the conclusion quantitatively.`,
        },
        {
          role: "user",
          content: `Hypothesis: ${hypothesis.hypothesis}\n\n${description}\n\nResult: ${success}. p-value: ${num(
            pValue
          )}`,
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
    };
    for await (const { content } of asyncLLM("https://llmfoundry.straive.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:hypoforge` },
      credentials: "include",
      body: JSON.stringify(body),
    })) {
      if (!content) continue;
      $outcome.innerHTML = marked.parse(content);
    }
    $result.innerHTML = /* html */ `<details>
      <summary class="h5 my-3">Analysis</summary>
      ${marked.parse(generatedContent)}
    </details>`;
  };

  $outcome.innerHTML = loading;
  pyodideWorker.addEventListener("message", listener);
  pyodideWorker.postMessage({ id: "1", code, data, context: {} });
});

document.querySelector("#run-all").addEventListener("click", async (e) => {
  const $hypotheses = [...document.querySelectorAll(".hypothesis")];
  const $pending = $hypotheses.filter((d) => !d.querySelector(".outcome").textContent.trim());
  $pending.forEach((el) => el.querySelector(".test-hypothesis").click());
});

document.querySelector("#synthesize").addEventListener("click", async (e) => {
  // Refresh token before making API calls
  try {
    await fetchToken();
  } catch (error) {
    return; // Error already handled in fetchToken
  }

  const hypotheses = [...document.querySelectorAll(".hypothesis")]
    .map((h) => ({
      title: h.querySelector(".hypothesis-title").textContent,
      benefit: h.querySelector(".hypothesis-benefit").textContent,
      outcome: h.querySelector(".outcome").textContent.trim(),
    }))
    .filter((d) => d.outcome);

  const body = {
    model: "gpt-4.1-nano",
    messages: [
      {
        role: "system",
        content: `Given the below hypotheses and results, summarize the key takeaways and actions in Markdown.
Begin with the hypotheses with lowest p-values AND highest business impact. Ignore results with errors.
Use action titles has H5 (#####). Just reading titles should tell the audience EXACTLY what to do.
Below each, add supporting bullet points that
  - PROVE the action title, mentioning which hypotheses led to this conclusion.
  - Do not mention the p-value but _interpret_ it to support the action
  - Highlight key phrases in **bold**.
Finally, after a break (---) add a 1-paragraph executive summary section (H5) summarizing these actions.
`,
      },
      {
        role: "user",
        content: hypotheses
          .map((h) => `Hypothesis: ${h.title}\nBenefit: ${h.benefit}\nResult: ${h.outcome}`)
          .join("\n\n"),
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
  };

  $synthesisResult.innerHTML = loading;
  for await (const { content } of asyncLLM("https://llmfoundry.straive.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:hypoforge` },
    credentials: "include",
    body: JSON.stringify(body),
  })) {
    if (!content) continue;
    $synthesisResult.innerHTML = marked.parse(content);
  }
});

document.querySelector("#reset").addEventListener("click", async (e) => {
  for (const $hypothesis of document.querySelectorAll(".hypothesis")) {
    $hypothesis.querySelector(".result").innerHTML = testButton($hypothesis.dataset.index);
    $hypothesis.querySelector(".outcome").textContent = "";
  }
});

$status.innerHTML = "";

// Initialize SQLite
const sqlite3 = await sqlite3InitModule({ printErr: console.error });
