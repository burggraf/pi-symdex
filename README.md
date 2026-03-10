# pi-symdex

SymDex integration for [pi](https://github.com/badlogic/pi) - the universal code indexer with semantic search and call graph navigation.

> **Credit:** This package is based on [SymDex](https://github.com/husnainpk/SymDex) by [husnainpk](https://github.com/husnainpk). SymDex is a universal code-indexer MCP server for AI coding agents. All credit for the underlying indexing technology, semantic search, and MCP server implementation goes to the original author.

## What is SymDex?

SymDex is a universal code-indexer MCP server that pre-indexes your codebase and lets AI agents find any symbol in ~200 tokens instead of reading whole files at ~7,500 tokens. That's a **97% reduction** per lookup.

### Key Features

- **Symbol Search** - Find functions, classes, methods by exact name
- **Semantic Search** - Find code by meaning ("validate email" → finds `validate_email`)
- **Call Graph** - See who calls a function and what it calls
- **HTTP Route Indexing** - Discover API endpoints without reading route files
- **14+ Languages** - Python, JS/TS, Go, Rust, Java, PHP, C#, C/C++, Elixir, Ruby, Vue

## Installation

### 1. Install SymDex

**Standard install:**
```bash
pip install symdex
```

**macOS (Homebrew Python) - if you get `externally-managed-environment` error:**

Use the provided install script which handles the setup with `pipx`:
```bash
./install_symdex.sh
```

Or manually with pipx:
```bash
brew install pipx
pipx install symdex
```

> **Note:** There is a known issue with the `symdex` pip package (v0.1.3) where the `schema.sql` file is not included. The `pi-symdex` extension automatically works around this by creating the missing file on first use. See [Known Issues](#known-issues) for details.

### 2. Install pi-symdex

```bash
# In your pi project
npm install pi-symdex
```

Or add to your pi settings:

```json
{
  "packages": ["pi-symdex"]
}
```

## Quick Start

### Index Your Project

```
/symdex:index
```

Or use the tool directly:

```
symdex_index(path: "./myproject")
```

### Search for Symbols

By name:
```
symdex_search(query: "validate_email")
```

By meaning:
```
symdex_semantic_search(query: "check if email is valid")
```

### Navigate Code

Get symbol source:
```
symdex_get_symbol(file: "auth/utils.py", start_byte: 1024, end_byte: 1340)
```

Find callers:
```
symdex_get_callers(name: "process_payment")
```

Find HTTP routes:
```
symdex_search_routes(method: "POST")
```

## Available Tools

| Tool | Description |
|------|-------------|
| `symdex_index` | Index a folder for searching |
| `symdex_search` | Find symbols by name |
| `symdex_semantic_search` | Find symbols by meaning/description |
| `symdex_get_symbol` | Read symbol source by byte offsets |
| `symdex_file_outline` | List all symbols in a file |
| `symdex_repo_outline` | Get repository structure summary |
| `symdex_get_callers` | Find functions that call a given function |
| `symdex_get_callees` | Find functions called by a given function |
| `symdex_search_routes` | Find HTTP API routes |
| `symdex_text_search` | Search for text/regex in code |
| `symdex_list_repos` | List all indexed repositories |

## Commands

| Command | Description |
|---------|-------------|
| `/symdex:index [path]` | Index current or specified folder |
| `/symdex:search <name>` | Search for symbol by name |
| `/symdex:semantic <description>` | Search by meaning |
| `/symdex:status` | Show indexing status |
| `/symdex:routes` | List HTTP routes |

## Skill

Load the skill for detailed usage guidelines:

```
/skill:symdex
```

## How It Works

1. **Index** - SymDex parses your source files using tree-sitter and stores symbols in SQLite with vector embeddings
2. **Search** - Query by name or semantic meaning (using local embeddings, no API calls)
3. **Navigate** - Get exact byte offsets to read only the code you need

## Requirements

- Python 3.11+ (for SymDex)
- pi coding agent

## Known Issues

### Missing schema.sql in pip package (v0.1.3)

The `symdex` package on PyPI (version 0.1.3) is missing the `schema.sql` file that is required for creating the database. This causes indexing to fail with:

```
FileNotFoundError: [Errno 2] No such file or directory: 
'.../site-packages/symdex/core/schema.sql'
```

**Workaround:** The `pi-symdex` extension automatically detects and fixes this issue by creating the missing `schema.sql` file when the server starts. No manual action is required.

**Upstream fix:** This issue has been reported to the SymDex project. Once fixed upstream, the workaround in `pi-symdex` will become unnecessary but will remain harmless.

## License

MIT

## Links

- [SymDex on GitHub](https://github.com/husnainpk/SymDex)
- [SymDex on PyPI](https://pypi.org/project/symdex/)