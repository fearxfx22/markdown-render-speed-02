# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/fearxfx22/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/fearxfx22/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free Markdown parser for Node 22 that renders exactly
what [marked 18.1.3](https://github.com/markedjs/marked) renders with its
default options (GFM on, breaks off, pedantic off, async off) — but faster.

Entry for the make.fun bounty
[markdown-render-speed-02](https://make.fun/c/markdown-render-speed-02)
("Make Markdown rendering faster", $250 prize).

## Files

- `parse.js` — the parser. `parse(markdown)` returns the HTML string.
  A hand-written, scanner-based implementation (own code, not a copy of
  marked): a line-based block lexer (headings, fences, lists, blockquotes,
  tables, HTML blocks, link-reference definitions) plus a single-pass
  inline scanner (emphasis via the CommonMark delimiter stack, links,
  images, autolinks, code spans, raw HTML). No dependencies, no network,
  no caching across cases, deterministic.
- `main.ts` — the harness driver. Reads `/input/cases.json`, renders each
  case with `parse`, writes `/output/html.json` (a JSON array of 720
  strings, in the cases' order).
- `LICENSE` — MIT.

## Run

```sh
node main.ts   # with /input/cases.json present (or MAKEFUN_INPUT_DIR set)
```

## Status

Practice set (720 cases: 680 CommonMark/GFM spec examples + 40 generated
README documents): 720/720 byte-identical to marked 18.1.3 (official kit
scorer: passed 1, cases_passed 720/720). Local benchmark on the practice
set: ~550–610 ms vs marked's ~1150–1310 ms (~2x faster). Deterministic:
two runs write byte-identical `html.json`.
