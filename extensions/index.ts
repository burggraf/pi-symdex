import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

// SymDex MCP client
interface SymDexClient {
  process: ReturnType<typeof spawn> | null;
  requestId: number;
  pendingRequests: Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>;
  initialized: boolean;
}

let symdexClient: SymDexClient | null = null;
let symdexAvailable: boolean | null = null;

/**
 * Check if symdex is installed and available
 */
function checkSymDexAvailable(): boolean {
  if (symdexAvailable !== null) return symdexAvailable;
  
  try {
    const result = spawnSync("symdex", ["--help"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    symdexAvailable = result.status === 0;
  } catch {
    symdexAvailable = false;
  }
  
  return symdexAvailable;
}

/**
 * Fix missing schema.sql file in symdex installation.
 * This is a workaround for https://github.com/husnainpk/SymDex/issues
 * where the schema.sql file is not included in the pip package.
 */
function ensureSchemaSqlExists(): boolean {
  try {
    // Find the symdex executable and its Python
    const whichResult = spawnSync("which", ["symdex"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    
    if (whichResult.status !== 0 || !whichResult.stdout) {
      return false;
    }
    
    const symdexPath = whichResult.stdout.trim();
    // symdex is usually a symlink, resolve it
    const realSymdexPath = fs.realpathSync(symdexPath);
    // Go up from bin/symdex to the venv root
    const venvRoot = path.dirname(path.dirname(realSymdexPath));
    const pythonPath = path.join(venvRoot, "bin", "python");
    
    // Find the symdex package location using the correct Python
    const result = spawnSync(pythonPath, ["-c", "import symdex.core; print(symdex.core.__file__)"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    
    if (result.status !== 0 || !result.stdout) {
      return false;
    }
    
    const coreDir = path.dirname(result.stdout.trim());
    const schemaPath = path.join(coreDir, "schema.sql");
    
    // Check if schema.sql already exists
    if (fs.existsSync(schemaPath)) {
      return true;
    }
    
    // Schema.sql content from symdex source
    const schemaContent = `-- SymDex Database Schema

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    file TEXT NOT NULL,
    start_byte INTEGER NOT NULL,
    end_byte INTEGER NOT NULL,
    signature TEXT,
    docstring TEXT,
    embedding BLOB,
    repo TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_symbols_repo ON symbols(repo);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_name ON symbols(repo, name);

CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_id INTEGER NOT NULL,
    callee_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    FOREIGN KEY (caller_id) REFERENCES symbols(id) ON DELETE CASCADE,
    FOREIGN KEY (callee_id) REFERENCES symbols(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_calls_repo ON calls(repo);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_id);

CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    handler TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER,
    repo TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_routes_repo ON routes(repo);
CREATE INDEX IF NOT EXISTS idx_routes_method ON routes(method);
CREATE INDEX IF NOT EXISTS idx_routes_handler ON routes(handler);

CREATE TABLE IF NOT EXISTS repos (
    name TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    db_path TEXT NOT NULL,
    last_indexed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;
    
    fs.writeFileSync(schemaPath, schemaContent);
    console.log(`[SymDex] Fixed missing schema.sql at ${schemaPath}`);
    return true;
  } catch (error) {
    console.error("[SymDex] Failed to fix schema.sql:", error);
    return false;
  }
}

/**
 * Start the SymDex MCP server
 */
async function startSymDexServer(ctx: ExtensionContext): Promise<boolean> {
  if (symdexClient?.initialized) return true;
  if (!checkSymDexAvailable()) {
    ctx.ui.notify("SymDex not found. Install with: pip install symdex", "error");
    return false;
  }

  // Workaround: Ensure schema.sql exists (missing from pip package)
  // See: https://github.com/husnainpk/SymDex/issues
  if (!ensureSchemaSqlExists()) {
    ctx.ui.notify("Failed to setup SymDex schema. Please check the installation.", "error");
    return false;
  }

  try {
    const process = spawn("symdex", ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    symdexClient = {
      process,
      requestId: 0,
      pendingRequests: new Map(),
      initialized: false,
    };

    // Handle stdout (JSON-RPC responses)
    // FastMCP 3.x uses newline-delimited JSON (not LSP-style Content-Length framing)
    let buffer = "";
    process.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      
      // Process complete JSON-RPC messages (line-delimited)
      const lines = buffer.split("\n");
      // Keep the last line in buffer if it's incomplete (no trailing newline)
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        try {
          const message = JSON.parse(trimmed);
          handleJsonRpcMessage(message);
        } catch (e) {
          console.error("[SymDex] Failed to parse JSON-RPC message:", trimmed.substring(0, 200));
        }
      }
    });

    // Handle stderr (logging)
    process.stderr?.on("data", (data: Buffer) => {
      const log = data.toString().trim();
      if (log) {
        console.log(`[SymDex] ${log}`);
      }
    });

    // Handle process exit
    process.on("exit", (code) => {
      console.log(`SymDex server exited with code ${code}`);
      symdexClient = null;
    });

    // Send initialize request
    const initResult = await sendJsonRpcRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-symdex", version: "0.1.0" },
    });

    if (initResult) {
      symdexClient.initialized = true;
      // Send initialized notification
      sendJsonRpcNotification("initialized", {});
      return true;
    }

    return false;
  } catch (error) {
    ctx.ui.notify(`Failed to start SymDex server: ${error}`, "error");
    return false;
  }
}

/**
 * Stop the SymDex MCP server
 */
function stopSymDexServer() {
  if (symdexClient?.process) {
    symdexClient.process.kill();
    symdexClient = null;
  }
}

/**
 * Send a JSON-RPC request to SymDex
 */
function sendJsonRpcRequest(method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!symdexClient?.process?.stdin) {
      reject(new Error("SymDex server not running"));
      return;
    }

    const id = ++symdexClient.requestId;
    symdexClient.pendingRequests.set(id, { resolve, reject });

    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    // FastMCP 3.x uses newline-delimited JSON (not LSP-style Content-Length framing)
    symdexClient.process.stdin.write(message + "\n");

    // Timeout after 30 seconds
    setTimeout(() => {
      if (symdexClient?.pendingRequests.has(id)) {
        symdexClient.pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }
    }, 30000);
  });
}

/**
 * Send a JSON-RPC notification to SymDex (no response expected)
 */
function sendJsonRpcNotification(method: string, params: any) {
  if (!symdexClient?.process?.stdin) return;

  const message = JSON.stringify({ jsonrpc: "2.0", method, params });
  // FastMCP 3.x uses newline-delimited JSON (not LSP-style Content-Length framing)
  symdexClient.process.stdin.write(message + "\n");
}

/**
 * Handle incoming JSON-RPC messages
 */
function handleJsonRpcMessage(message: any) {
  if (!symdexClient) return;

  if (message.id !== undefined && symdexClient.pendingRequests.has(message.id)) {
    const { resolve, reject } = symdexClient.pendingRequests.get(message.id)!;
    symdexClient.pendingRequests.delete(message.id);
    
    if (message.error) {
      reject(new Error(message.error.message || "Unknown error"));
    } else {
      resolve(message.result);
    }
  }
}

/**
 * Call a SymDex tool via MCP
 */
async function callSymDexTool(toolName: string, args: any): Promise<any> {
  if (!symdexClient?.initialized) {
    throw new Error("SymDex server not initialized");
  }

  const result = await sendJsonRpcRequest("tools/call", {
    name: toolName,
    arguments: args,
  });

  if (result.content && result.content[0]?.type === "text") {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  }

  return result;
}

/**
 * Get the current project name from the working directory
 */
function getProjectName(cwd: string): string {
  return path.basename(cwd);
}

/**
 * Check if a repo is already indexed
 */
async function isRepoIndexed(repoName: string): Promise<boolean> {
  try {
    const result = await callSymDexTool("list_repos", {});
    return result.repos?.some((r: any) => r.name === repoName) ?? false;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  // Track indexed repos for this session
  const indexedRepos = new Set<string>();

  // Start SymDex server on session start
  pi.on("session_start", async (_event, ctx) => {
    if (checkSymDexAvailable()) {
      const started = await startSymDexServer(ctx);
      if (started) {
        ctx.ui.notify("SymDex ready", "success");
        
        // Check if current project is indexed
        const projectName = getProjectName(ctx.cwd);
        if (await isRepoIndexed(projectName)) {
          indexedRepos.add(projectName);
          ctx.ui.setStatus("symdex", `📚 ${projectName}`);
        }
      }
    } else {
      ctx.ui.notify("SymDex not installed. Run: pip install symdex", "warning");
    }
  });

  // Stop server on shutdown
  pi.on("session_shutdown", async () => {
    stopSymDexServer();
  });

  // Register SymDex tools
  
  // 1. Index folder
  pi.registerTool({
    name: "symdex_index",
    label: "SymDex Index",
    description: "Index a folder with SymDex for fast symbol search. Run this first before using other SymDex tools.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to folder to index (defaults to current directory)" }),
      name: Type.Optional(Type.String({ description: "Repository name (defaults to folder name)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!symdexClient?.initialized) {
        throw new Error("SymDex server not initialized");
      }

      const folderPath = params.path || ctx.cwd;
      const repoName = params.name || getProjectName(folderPath);

      onUpdate?.({ content: [{ type: "text", text: `Indexing ${folderPath}...` }] });

      const result = await callSymDexTool("index_folder", {
        path: folderPath,
        name: repoName,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      indexedRepos.add(repoName);
      ctx.ui.setStatus("symdex", `📚 ${repoName}`);
      ctx.ui.notify(`Indexed ${result.indexed} symbols in ${repoName}`, "success");

      return {
        content: [{ 
          type: "text", 
          text: `Successfully indexed ${result.indexed} symbols (${result.skipped} skipped) in repository "${result.repo}".` 
        }],
        details: result,
      };
    },
  });

  // 2. Search symbols
  pi.registerTool({
    name: "symdex_search",
    label: "SymDex Search",
    description: "Search for symbols (functions, classes, methods) by name. Returns exact file paths and byte offsets for precise reading.",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name to search for" }),
      repo: Type.Optional(Type.String({ description: "Repository name (omit to search all indexed repos)" })),
      kind: Type.Optional(Type.String({ description: "Filter by symbol kind: function, class, method, constant, variable" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results (default: 20)", default: 20 })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const repo = params.repo || getProjectName(ctx.cwd);
      
      if (!indexedRepos.has(repo) && !(await isRepoIndexed(repo))) {
        throw new Error(`Repository "${repo}" not indexed. Run symdex_index first.`);
      }

      const result = await callSymDexTool("search_symbols", {
        query: params.query,
        repo: params.repo,
        kind: params.kind,
        limit: params.limit ?? 20,
      });

      if (result.error) {
        if (result.error.code === 404) {
          return {
            content: [{ type: "text", text: `No symbols found matching "${params.query}".` }],
            details: result,
          };
        }
        throw new Error(result.error.message);
      }

      const symbols = result.symbols || [];
      const summary = symbols.map((s: any) => 
        `${s.kind} ${s.name} in ${s.file}:${s.start_byte}`
      ).join("\n");

      return {
        content: [{ 
          type: "text", 
          text: `Found ${symbols.length} symbol(s):\n\n${summary}` 
        }],
        details: result,
      };
    },
  });

  // 3. Semantic search
  pi.registerTool({
    name: "symdex_semantic_search",
    label: "SymDex Semantic Search",
    description: "Search for symbols by meaning/description using embeddings. Use when you don't know the exact function name but know what it should do.",
    parameters: Type.Object({
      query: Type.String({ description: "Description of what you're looking for (e.g., \"validate email address\")" }),
      repo: Type.Optional(Type.String({ description: "Repository name (omit to search all indexed repos)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results (default: 10)", default: 10 })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const repo = params.repo || getProjectName(ctx.cwd);
      
      if (!indexedRepos.has(repo) && !(await isRepoIndexed(repo))) {
        throw new Error(`Repository "${repo}" not indexed. Run symdex_index first.`);
      }

      onUpdate?.({ content: [{ type: "text", text: "Searching by semantic meaning..." }] });

      const result = await callSymDexTool("semantic_search", {
        query: params.query,
        repo: params.repo,
        limit: params.limit ?? 10,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      const symbols = result.symbols || [];
      const summary = symbols.map((s: any) => 
        `${s.name} (${s.kind}) - score: ${(s.score * 100).toFixed(1)}% in ${s.file}`
      ).join("\n");

      return {
        content: [{ 
          type: "text", 
          text: `Semantic search results for "${params.query}":\n\n${summary}` 
        }],
        details: result,
      };
    },
  });

  // 4. Get symbol source
  pi.registerTool({
    name: "symdex_get_symbol",
    label: "SymDex Get Symbol",
    description: "Get the source code of a specific symbol by file path and byte offsets. Use this after search_symbols to read only the relevant code.",
    parameters: Type.Object({
      file: Type.String({ description: "File path relative to repo root" }),
      start_byte: Type.Number({ description: "Start byte offset" }),
      end_byte: Type.Number({ description: "End byte offset" }),
      repo: Type.Optional(Type.String({ description: "Repository name (defaults to current project)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const repo = params.repo || getProjectName(ctx.cwd);
      
      const result = await callSymDexTool("get_symbol", {
        file: params.file,
        start_byte: params.start_byte,
        end_byte: params.end_byte,
        repo,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      return {
        content: [{ 
          type: "text", 
          text: result.source || "No source found" 
        }],
        details: result,
      };
    },
  });

  // 5. Get file outline
  pi.registerTool({
    name: "symdex_file_outline",
    label: "SymDex File Outline",
    description: "Get all symbols defined in a specific file. Useful for understanding file structure without reading the entire file.",
    parameters: Type.Object({
      file: Type.String({ description: "File path relative to repo root" }),
      repo: Type.Optional(Type.String({ description: "Repository name (defaults to current project)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const repo = params.repo || getProjectName(ctx.cwd);
      
      const result = await callSymDexTool("get_file_outline", {
        file: params.file,
        repo,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      const symbols = result.symbols || [];
      const outline = symbols.map((s: any) => 
        `${s.kind} ${s.name} (${s.start_byte}-${s.end_byte})`
      ).join("\n");

      return {
        content: [{ 
          type: "text", 
          text: `File outline for ${params.file}:\n\n${outline}` 
        }],
        details: result,
      };
    },
  });

  // 6. Get repo outline
  pi.registerTool({
    name: "symdex_repo_outline",
    label: "SymDex Repo Outline",
    description: "Get a summary of the entire repository structure including symbol counts per file.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Repository name (defaults to current project)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const repo = params.repo || getProjectName(ctx.cwd);
      
      const result = await callSymDexTool("get_repo_outline", {
        repo,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      const files = result.files || [];
      const outline = files.map((f: any) => 
        `${f.file}: ${f.symbol_count} symbols`
      ).join("\n");

      return {
        content: [{ 
          type: "text", 
          text: `Repository outline for ${repo}:\n\n${outline}` 
        }],
        details: result,
      };
    },
  });

  // 7. Get callers (call graph)
  pi.registerTool({
    name: "symdex_get_callers",
    label: "SymDex Get Callers",
    description: "Find all functions that call a specific function. Use for impact analysis before making changes.",
    parameters: Type.Object({
      name: Type.String({ description: "Function name to find callers for" }),
      repo: Type.Optional(Type.String({ description: "Repository name (defaults to current project)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const repo = params.repo || getProjectName(ctx.cwd);
      
      const result = await callSymDexTool("get_callers", {
        name: params.name,
        repo,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      const callers = result.callers || [];
      if (callers.length === 0) {
        return {
          content: [{ type: "text", text: `No callers found for "${params.name}".` }],
          details: result,
        };
      }

      const summary = callers.map((c: any) => 
        `${c.kind} ${c.name} in ${c.file}`
      ).join("\n");

      return {
        content: [{ 
          type: "text", 
          text: `Functions calling "${params.name}":\n\n${summary}` 
        }],
        details: result,
      };
    },
  });

  // 8. Get callees (call graph)
  pi.registerTool({
    name: "symdex_get_callees",
    label: "SymDex Get Callees",
    description: "Find all functions called by a specific function. Use for understanding dependencies.",
    parameters: Type.Object({
      name: Type.String({ description: "Function name to find callees for" }),
      repo: Type.Optional(Type.String({ description: "Repository name (defaults to current project)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const repo = params.repo || getProjectName(ctx.cwd);
      
      const result = await callSymDexTool("get_callees", {
        name: params.name,
        repo,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      const callees = result.callees || [];
      if (callees.length === 0) {
        return {
          content: [{ type: "text", text: `No callees found for "${params.name}".` }],
          details: result,
        };
      }

      const summary = callees.map((c: any) => 
        `${c.kind} ${c.name} in ${c.file}`
      ).join("\n");

      return {
        content: [{ 
          type: "text", 
          text: `Functions called by "${params.name}":\n\n${summary}` 
        }],
        details: result,
      };
    },
  });

  // 9. Search routes
  pi.registerTool({
    name: "symdex_search_routes",
    label: "SymDex Search Routes",
    description: "Search for HTTP routes (API endpoints) in the codebase. Supports Flask, FastAPI, Django, and Express.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Repository name (defaults to current project)" })),
      method: Type.Optional(Type.String({ description: "Filter by HTTP method: GET, POST, PUT, DELETE, PATCH" })),
      path_pattern: Type.Optional(Type.String({ description: "Filter by path pattern (e.g., \"/users\")" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const repo = params.repo || getProjectName(ctx.cwd);
      
      const result = await callSymDexTool("search_routes", {
        repo,
        method: params.method,
        path_pattern: params.path_pattern,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      const routes = result.routes || [];
      if (routes.length === 0) {
        return {
          content: [{ type: "text", text: "No HTTP routes found." }],
          details: result,
        };
      }

      const summary = routes.map((r: any) => 
        `${r.method} ${r.path} → ${r.handler} (${r.file})`
      ).join("\n");

      return {
        content: [{ 
          type: "text", 
          text: `HTTP Routes:\n\n${summary}` 
        }],
        details: result,
      };
    },
  });

  // 10. Text search
  pi.registerTool({
    name: "symdex_text_search",
    label: "SymDex Text Search",
    description: "Search for text or regex patterns in indexed code. Returns matching lines with context.",
    parameters: Type.Object({
      query: Type.String({ description: "Text or regex pattern to search for" }),
      repo: Type.Optional(Type.String({ description: "Repository name (omit to search all indexed repos)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results (default: 50)", default: 50 })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await callSymDexTool("search_text", {
        query: params.query,
        repo: params.repo,
        limit: params.limit ?? 50,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      const matches = result.matches || [];
      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No matches found for "${params.query}".` }],
          details: result,
        };
      }

      const summary = matches.slice(0, 20).map((m: any) => 
        `${m.file}:${m.line}: ${m.content}`
      ).join("\n");

      const more = matches.length > 20 ? `\n\n... and ${matches.length - 20} more matches` : "";

      return {
        content: [{ 
          type: "text", 
          text: `Found ${matches.length} match(es):\n\n${summary}${more}` 
        }],
        details: result,
      };
    },
  });

  // 11. List repos
  pi.registerTool({
    name: "symdex_list_repos",
    label: "SymDex List Repos",
    description: "List all indexed repositories.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await callSymDexTool("list_repos", {});

      if (result.error) {
        throw new Error(result.error.message);
      }

      const repos = result.repos || [];
      if (repos.length === 0) {
        return {
          content: [{ type: "text", text: "No repositories indexed yet." }],
          details: result,
        };
      }

      const summary = repos.map((r: any) => 
        `${r.name} (${r.root_path}) - last indexed: ${r.last_indexed}`
      ).join("\n");

      return {
        content: [{ 
          type: "text", 
          text: `Indexed repositories:\n\n${summary}` 
        }],
        details: result,
      };
    },
  });

  // Register commands
  
  pi.registerCommand("symdex:index", {
    description: "Index current folder with SymDex",
    handler: async (args, ctx) => {
      const path = args.trim() || ctx.cwd;
      const repoName = getProjectName(path);
      
      pi.sendUserMessage(`Please index the folder at ${path} with SymDex using repo name "${repoName}"`, {
        deliverAs: "followUp",
      });
    },
  });

  pi.registerCommand("symdex:search", {
    description: "Search for symbols by name",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /symdex:search <symbol-name>", "warning");
        return;
      }
      
      pi.sendUserMessage(`Search for symbol "${args.trim()}" using SymDex`, {
        deliverAs: "followUp",
      });
    },
  });

  pi.registerCommand("symdex:semantic", {
    description: "Search for symbols by meaning/description",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /symdex:semantic <description>", "warning");
        return;
      }
      
      pi.sendUserMessage(`Search SymDex semantically for: "${args.trim()}"`, {
        deliverAs: "followUp",
      });
    },
  });

  pi.registerCommand("symdex:status", {
    description: "Show SymDex indexing status",
    handler: async (_args, ctx) => {
      if (!checkSymDexAvailable()) {
        ctx.ui.notify("SymDex not installed. Run: pip install symdex", "error");
        return;
      }

      const result = await callSymDexTool("list_repos", {});
      const repos = result.repos || [];
      
      if (repos.length === 0) {
        ctx.ui.notify("No repositories indexed yet", "info");
      } else {
        const currentProject = getProjectName(ctx.cwd);
        const currentRepo = repos.find((r: any) => r.name === currentProject);
        
        if (currentRepo) {
          ctx.ui.notify(`Current project "${currentProject}" is indexed`, "success");
        } else {
          ctx.ui.notify(`Indexed repos: ${repos.map((r: any) => r.name).join(", ")}`, "info");
        }
      }
    },
  });

  pi.registerCommand("symdex:routes", {
    description: "List HTTP routes in the codebase",
    handler: async (_args, ctx) => {
      pi.sendUserMessage("List all HTTP routes in this project using SymDex", {
        deliverAs: "followUp",
      });
    },
  });
}