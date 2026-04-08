# BrowserWire Design System

## Intent
A polished developer tool for mapping web applications through exploration. Warm, confident, opinionated — like Arc meets a field notebook. The browser content is the main attraction; the chrome around it recedes but feels intentional.

## Palette

**Foundation:** Warm stone grays (oklch with slight amber hue shift at 75-85)

| Token | Value | Usage |
|-------|-------|-------|
| background | `oklch(0.985 0.004 85)` | Page/shell background |
| foreground | `oklch(0.17 0.01 75)` | Primary text |
| card | `oklch(0.993 0.002 85)` | Card/popover surfaces |
| muted | `oklch(0.96 0.008 85)` | Subdued surfaces |
| muted-foreground | `oklch(0.52 0.01 75)` | Secondary text, labels |
| border | `oklch(0.91 0.01 80)` | All borders and inputs |

**Accent:** Amber / warm gold

| Token | Value | Usage |
|-------|-------|-------|
| primary | `oklch(0.72 0.15 70)` | CTAs, active indicators, focus rings |
| primary-foreground | `oklch(0.17 0.01 75)` | Text on primary (dark, not white) |
| accent | `oklch(0.92 0.04 80)` | Hover/active surface tint |
| accent-foreground | `oklch(0.22 0.01 75)` | Text on accent surfaces |

**Semantic:**

| Token | Value | Usage |
|-------|-------|-------|
| destructive | `oklch(0.58 0.22 25)` | Errors, stop actions |
| success | `oklch(0.64 0.17 155)` | Completion, GET methods |

## Depth
Borders only. No box-shadows. Surfaces differentiated by background luminance shifts (background → card → muted). This keeps the UI flat and lets the embedded browser content dominate.

## Spacing
4px base grid (Tailwind default). No custom spacing scale.

## Radius
Base: `0.625rem`. Derived: sm (-4px), md (-2px), lg (base), xl (+4px).

## Typography
System font stack. No custom typeface.
- Section headers: `text-sm font-semibold uppercase tracking-wider text-muted-foreground`
- Body: `text-sm`
- Helper text: `text-xs text-muted-foreground`

## Patterns

### Active indicator (ActivityBar)
Left border `border-l-2 border-primary` + `bg-accent` background. Inactive items use `text-muted-foreground` with `hover:bg-accent/50`.

### Recording state
Amber pulsing dot (`bg-primary animate-pulse`) — not green. Recording is the product's signature moment.

### HTTP method badges
- GET: `bg-success/15 text-success`
- POST: `bg-primary/15 text-primary`
- Both use `text-[10px] font-mono` variant secondary base.

### Status indicator
Amber dot (`bg-primary`) for healthy state. Red (`bg-destructive`) for error. Not green — amber is the identity color.

### Tour highlight
Amber ring: `outline: 2px solid oklch(0.72 0.15 70)` with pulse animation.

### Titlebar
Tinted `bg-muted/50` to visually connect with the activity bar frame. Title text uses `tracking-wide`.

### Buttons
- Default: amber `bg-primary` with dark text, `hover:bg-primary/85`
- Destructive: warm red
- Outline: `border-border bg-card`
- Ghost: transparent with `hover:bg-accent`

## What not to do
- No pure grays (hue 0) — always warm stone
- No blue accents — amber is the identity
- No shadows — borders and luminance shifts only
- No hardcoded Tailwind colors (emerald-*, blue-*) — use theme tokens
- Don't fight the embedded browser for attention — chrome should recede
