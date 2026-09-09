# Nicepage "PHP Developer" — extracted design system

Source: https://nicepage.com/website-design/preview/php-developer-483569
Live template: https://website159223.nicepage.io/Page-2.html
Extracted: 2026-09-10 from `nicepage.css` (1.08 MB) + inline `<style class="u-style">`

---

## Typography

| Role | Value |
|---|---|
| Heading family | `Roboto, sans-serif` (100–900) |
| Body family | `'Open Sans', sans-serif` (300–800) |
| Root size | `html { font-size: 16px }` |
| Body | `1rem / 1.6` |
| h1 | `2.25rem` (36px) |
| h2 | `1.5rem` (24px) |
| h3 | `1.25rem` (20px) |
| h4 | `1.25rem` (20px) |
| h5 / h6 | `1.125rem` (18px) |
| All headings | `line-height: 1.2`, `font-weight: 500`, `margin-bottom: 0.5rem` |
| Display numeral | `4.5rem` (72px), `font-weight: 700` |
| Eyebrow / label | `1rem`, `letter-spacing: 3px`, `text-transform: uppercase`, `font-weight: 700` |
| Section lead | `1.5rem` |

The eyebrow treatment (uppercase + 3px tracking + bold) is the template's single most
recognisable typographic device.

## Colour

| Role | Hex |
|---|---|
| Text | `#111111` |
| Ground | `#ffffff` |
| Contrast text | `#ffffff` |
| Accent 1 (primary) | `#ec8145` — warm orange |
| Accent 1 dark | `#e96e29` |
| Accent 1 light | `#f2a57a` |
| Accent 1 tint | `#fdf2eb` / `#f7cbb1` |
| Accent 2 | `#61427b` — deep purple |
| Accent 3 | `#bd967b` — tan |
| Accent 4 | `#b9c1cc` — blue-grey |
| Accent 5 | `#958a7c` — warm grey |
| Neutral tints | `#f5f7fa`, `#f7f6f4`, `#f8f3f0`, `#f5f0f9` |

## Layout & spacing

- Content container: **1140px**, centred (`.u-sheet`)
- Section vertical padding: **96–98px** (very generous)
- Card / cell padding: **20–30px**
- Button radius: **50px** (full pill)
- Grid gaps: 0–30px depending on block

## Character

Generous whitespace, a large type scale, uppercase letter-spaced eyebrows above
headings, oversized bold display numerals for statistics, flat white ground with one
warm accent carrying all emphasis. No heavy borders — separation comes from space and
tint blocks rather than rules.

---

## Adaptation notes for the NSE screener

The template is a marketing/portfolio page; the screener is a dense data tool. Applied
literally, several values would break the product:

| Template value | Why it cannot apply verbatim | Adaptation |
|---|---|---|
| 1140px container | Tables need 12 columns; a fixed 1140px would clip or cramp them | Keep fluid width for table panels; apply 1140px rhythm to prose sections (Research, Formula Sheet) |
| 96px section padding | Would push a data tool into endless scrolling | Scale to ~40–56px between research sections; keep table panels tight |
| 4.5rem display numerals | KPI tiles would dominate the viewport | Adopt the *proportion* (bold, dominant) at ~2.25rem for KPI values |
| body 1rem / 1.6 | Table rows become much taller, fewer rows visible per screen | Keep 1rem base for prose; hold table cells at ~15px with 1.45 line-height |

What transfers cleanly and should be adopted in full: both font families, the heading
scale and its 1.2 line-height, the uppercase 3px-tracked eyebrow device, the warm accent
palette, pill buttons, generous card padding, and the tint-block-over-borders approach to
separation.
