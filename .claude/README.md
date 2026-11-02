# Claude Code skills for OneLink

Project skills in `.claude/skills/` load automatically in every Claude Code session opened in this repo,
local or cloud. Each one was copied from upstream and reviewed before it was committed.

| Skill | Use it for | Upstream (commit) | License |
|---|---|---|---|
| `design-taste-frontend` | Art direction and polish for pages and app screens (dashboards, admin views) | Leonxlnx/taste-skill (`12af471`) | MIT |
| `image-to-code` | Generate a design image first, then build the page to match it | Leonxlnx/imagegen-skills (`beb16b0`) | MIT |
| `web-design-guidelines` | Review UI code against Vercel's Web Interface Guidelines (fetched live at review time) | vercel-labs/agent-skills (`1a2c79d`) | MIT |
| `playwright-cli` | Drive a browser from the CLI: snapshots, clicks, screenshots, test generation | microsoft/playwright-cli (`c2d8d19`) | Apache-2.0 |

## Design references

`.claude/design-references/` holds five `DESIGN.md` files from VoltAgent/awesome-design-md (`fcc7028`, MIT) for
fintech products: Stripe, Mercury, Wise, Revolut and Linear. They are inspiration only. Point Claude at one
("use the Mercury reference as a starting point"), but don't ship another company's brand. The full set of
about 70 is at https://github.com/VoltAgent/awesome-design-md.

## Requirements

- `design-taste-frontend` scripts need Node 22+ and Chrome/Chromium. `scripts/assets.mjs` fetches openly
  licensed images (Openverse, Wikimedia Commons, museum APIs) and needs network access.
- `playwright-cli` needs the CLI installed: `npm install -g @playwright/cli@latest`.
- `image-to-code` works best when an image generation tool is available. Without one, it falls back to coding directly.

## Updating

Re-copy each skill's folder from upstream, review the diff and bump the commit in the table above.
