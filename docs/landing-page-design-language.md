# unottr landing page design language

This document is the source of truth for the marketing site in `website/`. It records the
design system that emerged from the current implementation, the rules that protect it, and
the intended direction for future sections. Product architecture and application UI decisions
remain in the root `DESIGN.md`.

## Core idea

The site presents unottr as a private place where memory and computation meet. Its visual
world combines dreamlike alpine nature with physical, local hardware. Mountains, clouds,
mist, trees, rocks, and pink foliage express memory and depth. Computers, transcript panels,
and contained light express computation. The machine always belongs inside the landscape;
it should never look pasted onto a stock background.

The central promise is concrete: meetings become searchable memory on the user's computer.
AI is optional and uses a connection the user chooses. The design should make that trust
visible before copy has to explain it.

Four principles govern every section:

1. **Private by composition.** Light, particles, and motion stay close to the computer. Avoid
   imagery that suggests uploading, broadcasting, or an invisible cloud service.
2. **Product before decoration.** The transcript interface and local computer are the focal
   artifacts. Scenery establishes the world and creates depth around them.
3. **Scroll reveals meaning.** Long pinned scenes should move from atmosphere to evidence,
   then to the claim. Motion is part of the reading order, not ambient entertainment.
4. **Editorial restraint.** Large type, quiet labels, fine rules, and generous spacing carry
   the interface. Do not fill empty space with generic cards, pills, or floating ornaments.

## Page narrative

The landing page alternates immersive image-led scenes with quiet editorial sections. This
contrast prevents the violet world from becoming visually exhausting and gives factual copy
room to breathe.

| Section | Job | Visual treatment | Motion |
|---|---|---|---|
| Floating header | Keep navigation and purchase available | Deep violet translucent pill with a white action | Small hover lift only |
| Hero | State ownership and demonstrate the product | Full-viewport cloud world with transcript UI between text and foreground | 360svh pinned parallax and staged copy transition |
| Manifesto | Explain what unottr remembers | Pale lavender editorial field with oversized statement and metrics | Simple viewport reveal |
| Workflow | Make local transcription understandable | Warm near-white two-column editorial layout | Sticky introduction with scrolling steps |
| Privacy | Prove that local processing is physical | Dark tall laptop-in-nature scene with contained glow | 280svh pinned image travel and three staggered facts |
| Inference routes, planned | Show where optional AI can run | Light bridge section with three clearly named connection paths | Progressive path reveal, no decorative parallax unless it adds meaning |
| Optional AI proof | Show the actual cited-answer interface | Pale surface with a large product UI frame | Simple reveal, product remains readable |
| Final action | Return to the dream world and lead into pricing | Full-bleed lavender lake scene | Restrained fade-through |

The separate pricing page continues the scenic world in a shorter, sales-focused form. It uses
one large license panel instead of a generic set of pricing tiers. Price, version coverage, and
what the license includes must align on a single reading path. Do not imply that hosted AI usage
is included in the application price.

## Visual world

The primary imagery is cinematic, painterly 3D concept art. It should feel tactile rather
than glossy or synthetic. Rock is irregular, computer materials are matte, foliage is fine
and asymmetrical, and fog has real depth. Scenes use dusk or dawn lighting with indigo
shadows, lavender atmosphere, and small pink or peach highlights.

The palette is intentionally narrow:

| Role | Current value | Use |
|---|---|---|
| Paper | `#f4f0ff` | Main light section background |
| Raised paper | `#fffaff` | Product frames and elevated light surfaces |
| Ink | `#21163a` | Primary text on light surfaces |
| Muted ink | `#6f6483` | Supporting copy on light surfaces |
| Violet | `#7357db` | Labels, active details, and restrained accents |
| Deep violet | `#5136bd` | Strong accent and hero continuity |
| Night | `#17112b` | Dark sections and page boundary |
| Raised night | `#21183b` | Dark reading surfaces |
| Night muted | `#b7adc9` | Supporting copy on dark surfaces |
| Light rule | `#d8cfeb` | Dividers on paper |
| Night rule | `#3d3155` | Dividers on dark surfaces |

Do not treat violet as permission to add arbitrary blue-purple gradients. Color should come
from the scenic world, material surfaces, and controlled overlays. Bright pink belongs in
small highlights, contained processing rings, foliage tips, and selection states.

## Typography

The site uses `Geist Variable` for display and body text. Its plain geometry lets the
imagery carry the atmosphere. Monospaced labels use `SFMono-Regular`, `Cascadia Code`, or
`Liberation Mono` as available.

Type has four clear levels:

- Hero statements are extremely large, tightly tracked, and limited to one or two visual
  lines per side. They act as part of the image composition.
- Section headings use `clamp(2.65rem, 4.8vw, 5rem)`, a weight near 540, tight negative
  tracking, and approximately `0.98` line height.
- Feature statements use a comfortable display size around `1.15rem` to `1.55rem` with
  relaxed line height.
- Eyebrows use the mono face near `0.69rem`, bold, uppercase, and widely tracked. A short
  horizontal rule may precede the label.

Headlines should state an outcome or boundary. Body copy should name the mechanism. Avoid
inflated claims, AI marketing language, long hero paragraphs, and unexplained technical
jargon.

## Layout and spacing

The shared content shell is `min(100% - 2rem, 87.5rem)` and is centered. Major sections use
fluid vertical spacing, normally between 7rem and 12rem. Two-column editorial sections use
an intentionally uneven split, commonly `0.86fr 1.14fr`, with a large responsive gap.

The design may break the content grid only for one of three reasons:

- full-bleed scenery;
- oversized display text;
- a product artifact that must overlap the surrounding narrative.

Otherwise, alignment should be strict. Fine rules establish rows. Labels align to copy, and
large statements should have deliberate line breaks. Avoid repeated equal-width card grids.

Rounded forms are reserved for controls, the floating navigation, and real application
windows. Editorial content blocks should normally remain square or use only a subtle radius.
Blurred surfaces require a readability reason. They are not a default material.

## Image system

Website images live under `website/public/images/` and have a specific role:

- `hero/` contains production parallax layers.
- `hero-concepts/` contains visual explorations and secondary scenic backgrounds.
- `privacy/` contains the local-compute concept sheet and tall privacy scenes.

Production raster assets should ship as optimized WebP with a PNG source kept beside them
when editing or transparency may be needed. Decorative images use empty alt text and
`aria-hidden="true"`; meaningful product screenshots need useful alternative text or nearby
equivalent copy.

The hero is a layered scene, not one animated wallpaper. Its order is:

1. tall sky;
2. atmospheric color wash;
3. opening text;
4. mountain or peak artifact;
5. mist;
6. product screenshot;
7. foreground foliage;
8. closing text.

Every transparent layer must share the same camera, horizon, palette, and native aspect
ratio. Keep `height: auto` unless the asset is intentionally placed in an object-fit frame.
Never stretch a foreground cutout to manufacture coverage.

Banding is a composition failure, not a fog problem. Do not hide a misaligned image seam
with an opaque rectangle or broad haze. Align layers to the same base scene, preserve their
order, and ensure moving layers contain real transparent pixels around the subject.

Foreground foliage should frame the lower corners and may cross the bottom edge. It must
not become a dense hedge, dominate the product, or enlarge because of an unresolved width
constraint.

## Motion system

Lenis supplies smooth scrolling. Section scripts calculate visual progress with
`requestAnimationFrame` and listen to both native `scroll` and the shared `lenis-scroll`
event. Do not create a second easing loop on top of Lenis.

Pinned sections use a tall outer section and a `100svh` sticky stage:

- hero: `360svh`;
- privacy: `280svh`;
- future pinned scenes should justify their duration from the number of narrative states.

Motion follows these rules:

- Different depth planes move at different speeds.
- Foreground, subject, mist, and background remain separate when the effect requires real
  depth.
- Text reveals use opacity, short vertical travel, and blur only when the blur visibly
  resolves into legibility.
- A pinned scene should begin with space to look at the image before facts arrive.
- Sequential facts get distinct progress windows. They do not all trigger when the section
  first intersects the viewport.
- Items that reveal over detailed imagery receive their own dark translucent reading
  surface with backdrop blur. That surface appears with the item and does not cover the
  initial image.
- Scroll motion must be reversible and deterministic. Scrolling upward restores earlier
  states.
- Hover movement remains small, normally one pixel of lift or a restrained color change.

Do not animate every section. The hero and privacy scenes are the main motion moments.
Editorial sections should use simpler reveals so the page has changes of pace.

## Current privacy scene

The privacy section uses `local-laptop-parallax-tall.webp`, a 1122 by 1402 scene with sky,
mountains, laptop ledge, and foreground plants. The image travels vertically through a
pinned viewport. The laptop's closed processing ring visually contains the inference.

The left introduction remains visible as the section's anchor. The three facts on the right
start fully absent and reveal one at a time at separate scroll thresholds. Each fact is one
full-width row whose mono label sits above its larger statement. Its dark translucent
background, border, and backdrop blur reveal with it.

`local-tower-parallax-tall.webp` is the alternate privacy direction. Use it when the story
needs stronger infrastructure imagery, but do not show both in the same section.

## Planned inference routes section

The landing page should add a section that explains optional inference connections. This
belongs after Privacy and before the existing Optional AI product preview. Privacy establishes
the boundary; the new section explains the user's choices; the product preview then shows
the result.

Present three routes, in this order:

1. **Installed agents.** Claude Code and Codex CLI. Codex CLI is currently beta. These run
   on the user's computer, but their provider may still receive transcript text. Do not call
   this route fully local.
2. **Local model servers.** Ollama and LM Studio. These are the clearest fully local
   inference route when configured on localhost.
3. **API connections.** OpenAI, Anthropic, Mistral, and any OpenAI-compatible endpoint.
   A service such as Groq belongs under the compatible-endpoint route until it has a tested
   dedicated preset.

OpenCode and Gemini CLI are detected by the application but are not supported yet. Do not
advertise them as supported. They may appear in a clearly labelled "detected, coming later"
note only when that status is useful and current.

The section should not become a wall of vendor logos. Lead with the three execution routes,
then use compact provider marks or names as evidence. The visual hierarchy must answer two
questions in order: where does inference run, and what leaves the computer? A simple path or
progressive connection map is preferable to a generic integration-card grid.

Copy must preserve the product's privacy distinction:

- transcription and diarization are local and automatic;
- AI inference is optional and explicitly triggered;
- only selected transcript text and context are sent;
- audio, video, frames, and unrelated files are not sent;
- installed CLIs may use a signed-in hosted account;
- localhost model servers can keep inference on the machine.

## Controls and product frames

Primary actions are high-contrast white pills on violet or dark imagery. Purchase actions route
to the pricing page or the configured hosted checkout. Secondary actions
use a thin light border and a transparent or softly tinted fill. Focus indicators use a
three-pixel pink outline with a clear offset.

Product screenshots sit in large, controlled frames with one consistent corner radius and a
real border. Shadows should be broad and low-contrast, used to separate the product from the
scene. Do not scatter multiple small dashboard cards around the page.

The fixed header is a centered translucent violet pill. It keeps the brand on the left,
navigation in the middle, and the download action on the right. On small screens, navigation
may collapse, but the brand and primary action remain accessible.

## Responsive and accessible behavior

At 900px and below, multi-column sections collapse to one column. Pinned privacy motion is
disabled and the scene becomes a stable background crop so content is never trapped in an
overflowing sticky viewport. Mobile layouts prioritize readable copy and intact product
frames over preserving desktop overlap.

When `prefers-reduced-motion: reduce` is active:

- Lenis is destroyed;
- pinned storytelling sections become ordinary-height sections;
- parallax transforms stop;
- staged content remains visible;
- decorative animation durations collapse to near zero.

Maintain WCAG AA contrast for body text, visible keyboard focus, a working skip link, touch
targets suitable for mobile, and semantic headings and definition lists. Never place required
information only inside a generated image.

## Performance rules

- Use WebP for production scenic assets and lazy-load below-the-fold images.
- Reserve width and height on raster images to prevent layout shifts.
- Animate transforms and opacity. Keep filters limited to a few narrative elements.
- Use one animation frame callback per section and coalesce scroll events.
- Avoid `background-attachment: fixed`; sticky stages are more predictable across browsers.
- Do not add a second smooth-scroll library or run competing request-animation-frame loops.
- Keep mobile static where a large parallax image would cost more than it communicates.

## What does not belong

Avoid generic AI imagery and interface patterns:

- glowing brains, robots, shields, locks, fingerprints, binary rain, or server-rack aisles;
- outward data beams or cloud-upload symbols in a privacy claim;
- decorative glass cards covering every image;
- random purple blobs, neon circuitry, or floating UI fragments;
- logo walls without an information hierarchy;
- repeated three-card rows for unrelated sections;
- gradient text, excessive pills, or every label set in uppercase;
- foreground images stretched beyond their native composition;
- motion that continues without scroll input or obscures reading.

## Handoff checklist

Before a landing-page change is considered complete, verify:

- the section advances the page narrative rather than repeating a nearby claim;
- copy matches behavior in `src/main/ai/`, `src/shared/ipc.ts`, and the privacy model here;
- image crops work at desktop and mobile widths without stretching;
- layer order and transparency produce no bands or hard seams;
- text remains readable over the brightest and busiest image positions;
- the first frame, intermediate states, final frame, reverse scroll, and direct-anchor entry
  all work;
- reduced-motion and 900px-or-smaller layouts expose all content without pinning;
- images declare dimensions and below-the-fold images load lazily;
- `pnpm check` passes in `website/`.
