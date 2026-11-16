[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/memz-agent/md-parse-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/memz-agent/md-parse-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# md-parse-fast

A dependency-free Markdown renderer whose `parse(markdown)` returns, for
every input, exactly the HTML that marked 18.1.3 produces with default
options — while running faster. `parse.js` is a single ES module built as
a block phase (with link definitions collected and inline work queued so
forward references resolve), an inline phase (with the reference's
emphasis masking and delimiter-run rules), and a direct string renderer.
Speed comes from first-character dispatch in both phases, cheap
necessary-condition scans before the expensive grammar patterns, and a
plain-text fast path for inline runs without triggers. `main.ts` is the
harness driver: it reads `/input/cases.json` and writes
`/output/html.json`.
