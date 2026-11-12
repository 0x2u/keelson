# Brand

A keelson is the timber that runs along the inside of a hull, over the keel, and ties the frames to it: what holds the ship together. The mark is that, seen from the bow: two frames of the hull over the keel.

## Files

| File | Use |
|---|---|
| [`keelson-logo-dark.svg`](keelson-logo-dark.svg), [`keelson-logo-light.svg`](keelson-logo-light.svg) | The logo: the mark and the name. `dark` is for a dark background, `light` for a light one. The name is drawn as outlines, so the files need no font. |
| [`keelson-mark-dark.svg`](keelson-mark-dark.svg), [`keelson-mark-light.svg`](keelson-mark-light.svg) | The mark alone, where the name is already next to it or there is no room for it. |
| [`keelson-icon.svg`](keelson-icon.svg), [`keelson-icon-512.png`](keelson-icon-512.png) | The mark on its tile: an avatar, an app icon. |
| [`social-preview.png`](social-preview.png) | 1280 × 640, for the repository's social preview and link cards. |

The dashboard draws the same paths in `dashboard/components/brand.tsx` (the frames take the colour of the text around them) and serves its favicon from `dashboard/app/icon.svg`, `favicon.ico` and `apple-icon.png`, where the mark is larger on its tile so that it reads at 16 pixels.

The vector paths were redrawn from the emblem the project started from (a 1536 × 1024 PNG): straight edges, circular corners and one curve for the underside of the keel. The redraw and the original overlap on 98.6 % of their combined area.

## Colours

| Name | Value | Use |
|---|---|---|
| Keel cyan | `#4DD2FD` | The keel of the mark. In the dashboard: the primary button, the focus ring and the active tab of the dark theme. Never a status. |
| Deep cyan | `#0B7FA3` | The same hue where it has to pass AA on white: the focus ring and the active icon of the light theme. |
| Ink | `#0B1B2B` | The frames of the mark on a light background, the tile of the icon, the text and the primary button of the light theme. |
| Mist | `#F7F9FB` | The frames of the mark on a dark background. |
| Deep | `#070F18` | The background of the dark theme. |

Green, amber, red and blue mean a state in the dashboard (running, needs attention, failed, in progress). The brand cyan never does, and a state never uses it.

## Type

The name and the page titles are set in [Sora](https://github.com/sora-xor/sora-font) SemiBold (SIL Open Font License; a Latin subset is in `dashboard/app/fonts`). Everything else is Geist Sans and Geist Mono.

## Rules

- Keep the keel cyan. The frames are Mist on dark and Ink on light, nothing else.
- Leave clear space around the mark of at least the height of one frame.
- Do not stretch, rotate, outline or add effects to the mark, and do not rebuild the name in another typeface.
- On a photograph or a coloured background, use the icon (the mark on its tile).
