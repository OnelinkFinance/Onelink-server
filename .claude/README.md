# Claude Code skills for OneLink

Project skills in `.claude/skills/` load automatically in every Claude Code session opened in this repo,
local or cloud. Each one was copied from upstream and reviewed before it was committed.

| Skill | Use it for | Upstream (commit) | License |
|---|---|---|---|
| `design-taste-frontend` | Art direction and polish for pages and app screens (dashboards, admin views) | Leonxlnx/taste-skill (`12af471`) | MIT |
| `image-to-code` | Generate a design image first, then build the page to match it | Leonxlnx/imagegen-skills (`beb16b0`) | MIT |
| `web-design-guidelines` | Review UI code against Vercel's Web Interface Guidelines (fetched live at review time) | vercel-labs/agent-skills (`1a2c79d`) | MIT |
| `playwright-cli` | Drive a browser from the CLI: snapshots, clicks, screenshots, test generation | microsoft/playwright-cli (`c2d8d19`) | Apache-2.0 |

### Animation and motion

| Skill(s) | Use it for | Upstream (commit) | License |
|---|---|---|---|
| `gsap-core`, `gsap-timeline`, `gsap-scrolltrigger`, `gsap-plugins`, `gsap-utils`, `gsap-react`, `gsap-frameworks`, `gsap-performance` | GSAP tweens, timelines, scroll effects and framework integration (official GreenSock skills) | greensock/gsap-skills (`aed9cfd`) | MIT |
| `threejs-*` (13 skills: fundamentals, geometry, materials, lighting, textures, shaders, animation, interaction, loaders, asset-pipeline, postprocessing, performance, react-three-fiber) | 3D scenes, lighting and camera animation with Three.js | cloudai-x/threejs-skills (`0e18186`) | MIT |
| `design-dna` | Extract design tokens, style and visual effects from reference screenshots/URLs into JSON, then generate from it | zanwei/design-dna (`593e39b`) | MIT |
| `motion-design` | Timing, easing and choreography principles, independent of library | LottieFiles/motion-design-skill (`f9a8a04`) | MIT |
| `animate`, `improve-animations`, `review-animations`, `remove-animations`, `find-animation-opportunities`, `animation-vocabulary`, `animation-performance` | Emil Kowalski's (animations.dev) approach: whether to animate at all, then build, review or audit motion | emilkowalski/skills (`f1090be`) | MIT |

## Design references

`.claude/design-references/` holds five `DESIGN.md` files from VoltAgent/awesome-design-md (`fcc7028`, MIT) for
fintech products: Stripe, Mercury, Wise, Revolut and Linear. They are inspiration only. Point Claude at one
("use the Mercury reference as a starting point"), but don't ship another company's brand. The full set of
about 70 is at https://github.com/VoltAgent/awesome-design-md.

## Requirements

- `design-taste-frontend` scripts need Node 22+ and Chrome/Chromium. `scripts/assets.mjs` fetches openly
  licensed images (Openverse, Wikimedia Commons, museum APIs) and needs network access.
- `playwright-cli` needs the CLI installed: `npm install -g @playwright/cli@latest`.
- `design-dna`'s optional colour-measurement scripts need Node 18.17+ and `sharp`
  (`cd .claude/skills/design-dna/scripts && npm install`). The skill works without them.
- GSAP and Three.js skills assume the project installs `gsap` / `three`. Neither is a dependency yet.
- `image-to-code` works best when an image generation tool is available. Without one, it falls back to coding directly.

## Updating

Re-copy each skill's folder from upstream, review the diff and bump the commit in the table above.
