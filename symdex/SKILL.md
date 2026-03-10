---
name: symdex
description: Universal code indexer with semantic search, call graph navigation, and HTTP route discovery. Use SymDex when you need to find symbols, understand code relationships, or search by meaning rather than name.
---

# SymDex

SymDex is a universal code indexer that helps you navigate codebases efficiently. It indexes your code once, then lets you search by name, by meaning (semantic search), or explore call relationships.

## When to Use SymDex

| Use Case | Tool to Use |
|----------|-------------|
| Find a function by exact name | `symdex_search` |
| Find code by what it does (don't know the name) | `symdex_semantic_search` |
| Read a specific function's source | `symdex_get_symbol` (after search) |
| See all symbols in a file | `symdex_file_outline` |
| Understand who calls a function | `symdex_get_callers` |
| Understand what a function calls | `symdex_get_callees` |
| Find HTTP API routes | `symdex_search_routes` |
| Search for text/regex in code | `symdex_text_search` |

## Workflow

### 1. Index First

Always index the project before searching:

```
symdex_index(path: "./myproject", name: "myproject")
```

### 2. Search by Name

When you know the function/class name:

```
symdex_search(query: "validate_email")
```

### 3. Search by Meaning

When you don't know the exact name:

```
symdex_semantic_search(query: "check if email address is valid")
```

### 4. Read the Source

Use byte offsets from search results to read only the relevant code:

```
symdex_get_symbol(file: "auth/utils.py", start_byte: 1024, end_byte: 1340)
```

### 5. Understand Impact

Before changing a function, check who calls it:

```
symdex_get_callers(name: "process_payment")
```

## Best Practices

### Always Index First
Without indexing, all searches return empty results. Index at the start of each session if the project hasn't been indexed.

### Use Semantic Search for Discovery
When exploring an unfamiliar codebase, semantic search is more effective than guessing function names:

```
symdex_semantic_search(query: "handle user authentication")
symdex_semantic_search(query: "send email notification")
symdex_semantic_search(query: "parse CSV file")
```

### Read Precisely
After finding a symbol, use `symdex_get_symbol` with the exact byte offsets instead of reading the entire file. This saves tokens and context window space.

### Explore Call Graphs
Before refactoring, understand the impact:
- `symdex_get_callers` - Who depends on this function?
- `symdex_get_callees` - What does this function depend on?

### Find API Routes
For web applications, use `symdex_search_routes` to discover the API surface without reading route files:

```
symdex_search_routes(method: "POST")
symdex_search_routes(path_pattern: "/users")
```

## Supported Languages

SymDex supports 14+ languages via tree-sitter:
- Python, JavaScript, TypeScript
- Go, Rust, Java, PHP
- C#, C, C++
- Elixir, Ruby, Vue

## Token Savings

SymDex dramatically reduces token usage:

| Approach | Tokens |
|----------|--------|
| Read full file to find function | ~7,500 |
| SymDex search + precise read | ~200 |
| **Savings** | **97%** |

## Quick Commands

- `/symdex:index` - Index current folder
- `/symdex:search <name>` - Search for symbol
- `/symdex:semantic <description>` - Semantic search
- `/symdex:status` - Check indexing status
- `/symdex:routes` - List HTTP routes