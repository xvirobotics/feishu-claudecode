# Web UI Redesign — "Refined Command Center"

## Design Direction

Premium, warm dark theme inspired by Linear/Arc Browser. A sophisticated control center for AI agents that feels intentionally designed, not AI-generated.

### What Makes Current UI Look "AI-Generated"
- Purple accent (#7c6df5) — the most cliched AI color
- Cold blue-black backgrounds (#08080c, #111118)
- Plus Jakarta Sans — safe/generic font choice
- Gradient breathing orbs on login page — textbook AI slop
- Predictable glowing/pulsing animations everywhere
- Generic card layouts with no personality

### New Design Identity

**Typography** (Google Fonts):
- **UI/Headlines**: "Sora" — geometric, slightly technical, distinctive personality
- **Code**: "IBM Plex Mono" — clean, professional, different from JetBrains Mono
- Single font family for entire UI = cohesive identity

**Color Palette**:
- **Backgrounds**: Warm charcoal (#0c0c10 → #141418 → #1c1c22) — NOT cold blue-black
- **Text**: Warm whites (#e8e6f0, #9b99a9, #5c5a6a)
- **Primary accent**: Teal (#2dd4bf) — fresh, modern, NOT purple
- **Success**: Emerald (#10b981)
- **Error**: Rose (#f43f5e) — refined, not harsh red
- **Warning**: Amber (#f59e0b)
- **Info/Thinking**: Indigo (#6366f1) — used sparingly

**Visual Texture**:
- Subtle CSS noise/grain overlay on backgrounds for depth
- 1px hairline borders with warm tint (rgba(255,255,255,0.06))
- Refined shadows with slight warm undertone
- No breathing orbs, no pulsing glows — purposeful, restrained animations
- Status indicators: small colored dots, not glowing halos

**Light Theme**:
- Clean warm whites (#fafaf9, #f5f5f4, #e7e5e4)
- High contrast text (#1c1917, #57534e)
- Teal accent stays consistent across themes

## Implementation Steps

### Step 1: Update fonts in index.html
Replace Google Fonts link: swap Plus Jakarta Sans → Sora + IBM Plex Mono

### Step 2: Rewrite theme.css (design tokens)
- Complete replacement of all CSS custom properties
- New color palette (warm charcoal + teal accent)
- New typography tokens (Sora + IBM Plex Mono)
- New spacing, radius, shadow, transition tokens
- Add noise texture as pseudo-element mixin
- Updated light theme variables
- Remove old "Midnight Luxe" naming

### Step 3: Redesign LoginPage
- Remove gradient breathing orbs (classic AI slop)
- Replace with subtle geometric grid pattern or clean gradient
- Cleaner card: less border-radius, sharper edges, refined shadows
- Better typography hierarchy
- Minimal changes to TSX (mostly removing orb divs)

### Step 4: Redesign Layout (sidebar + nav)
- Warmer sidebar background
- Cleaner nav items: simpler active state (left border accent, no glow)
- Better session list: cleaner hover, subtle delete button
- Refined bot selector dropdown
- Better brand header (no gratuitous gradients)
- Mobile hamburger menu refinements

### Step 5: Redesign ChatView (main chat)
- Better message styling: cleaner bubbles, better code blocks
- Refined tool call display: smaller, more compact, professional
- Better status indicators: simple dots + text, no spinning/pulsing excess
- Cleaner input area: refined border, better focus state
- Better cost/duration badges
- Phone call overlay: keep functionality, update colors/style
- Code block redesign: header with language label, better copy button

### Step 6: Redesign MemoryView
- Cleaner folder tree
- Better document cards with refined hover states
- Improved search bar styling
- Better document viewer with cleaner metadata

### Step 7: Redesign SettingsView
- Cleaner section layout
- Better toggle switch (teal accent)
- Refined status badges
- Better bot list styling

### Step 8: Redesign VoiceView
- Updated recording button styling (teal accent instead of purple)
- Better waveform visualization colors
- Cleaner provider selection UI

### Step 9: Build & test
- `npm run build:web`
- Test on `https://metabot.xvirobotics.com/web/`
- Verify dark/light themes, all views, phone call mode

### Step 10: Commit & push

## Scope

**Files to modify** (CSS-heavy, minimal TSX changes):
- `web/index.html` — font import
- `web/src/theme.css` — full rewrite (~470 lines)
- `web/src/components/LoginPage.tsx` — remove orb divs
- `web/src/components/LoginPage.module.css` — full restyle
- `web/src/components/Layout.module.css` — full restyle
- `web/src/components/ChatView.module.css` — full restyle
- `web/src/components/MemoryView.module.css` — full restyle
- `web/src/components/SettingsView.module.css` — full restyle
- `web/src/components/VoiceView.module.css` — full restyle

**No functional changes** — all WebSocket, state management, voice/VAD logic stays identical. This is a pure visual redesign.
