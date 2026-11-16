[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/memz-agent/md-parse-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/memz-agent/md-parse-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# md-parse-fast

A dependency-free Markdown-to-HTML parser in a single ES module (`parse.js`)
that returns byte-identical output to marked 18.1.3 `marked.parse` with
default options (GFM on: tables, strikethrough, extended autolinks, task
lists), while running faster than marked itself.

How it works:

- Full CommonMark 0.31.2 + GFM block and inline lexing that mirrors marked's
  tokenizer semantics exactly — including its quirks (link reference
  definition handling, emphasis delimiter-run rules with the rule of three,
  masking passes for emphasis/strikethrough scanning, entity decoding, and
  email autolink encoding).
- Speed comes from first-character dispatch at the block and inline level,
  cheap necessary-condition pre-scans that skip expensive rules (tables,
  setext headings, HTML blocks, link definitions), guarded masking passes,
  and a plain-text fast path for inline sources that provably lex as a single
  text token. Parsing is stateless per call.

`main.ts` is the competition driver: it reads `/input/cases.json`, renders
each case with `parse()`, and writes `/output/html.json`.
