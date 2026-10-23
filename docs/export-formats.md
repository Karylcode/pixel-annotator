**English** | [繁體中文](export-formats.zh-TW.md) · [Documentation index](README.md)

# Export formats

Export from the **匯出** (Export) tab in the right panel. Every single-image format has **下載** (Download)
and **複製** (Copy).

| Format | Contents | Use |
|---|---|---|
| **PNG** | Whole-number nearest-neighbor upscale: 1×, 2×, 4×, 8×, 16× or 32× | Use directly as an asset |
| **SVG** | Same-colored pixels merged into rectangles, one `<path>` per color | Vector; scales without limit |
| **JSON** | Palette plus an index grid, with the existing compatibility fields kept | For your code to read |
| **JS** | The same data as an `export const` ES module | `import` it straight into a project |
| **ZIP** | Every open image: a PNG each, plus JSON for images up to 64×64 | Take everything at once |

## PNG

- Each source pixel becomes an exact N×N block, copied cell by cell, alpha included. No smoothing.
- The file is named `<name>.png` at 1×, or `<name>@4x.png` and so on.
- A scale is disabled when the result would pass 16384 px on a side or 40 megapixels.
- **複製** puts the PNG on the clipboard. If the browser does not allow that, download it instead.

## SVG

- Transparent pixels are skipped. Same-colored pixels are merged greedily into rectangles, and all rectangles
  of one color go into one `<path>`.
- Partly transparent colors get `fill-opacity`.
- The `viewBox` is in pixel cells, so it scales without loss. The default `width` and `height` are a whole-number
  multiple that makes the longest side about 512 px.
- `shape-rendering="crispEdges"` prevents seams between shapes.

## JSON and JS

JSON and JS are only available for images up to 64×64; larger data is too big. Crop or pixelate first.

JSON shape, for a 3×2 image (the real file is indented with one value per line):

```json
{
  "name": "sprite",
  "w": 3,
  "h": 2,
  "palette": [null, "#dfe6ee", "#ffb224"],
  "pixels": [[0, 1, 1], [2, 2, 0]],
  "parts": { "names": {}, "colors": {}, "grid": [[0, 0, 0], [0, 0, 0]] }
}
```

The JS module holds the same data without `name`:

```js
// sprite — 16x16
export const sprite = {
  w: 16,
  h: 16,
  palette: [null, "#dfe6ee", "#9aa7b4", "#ffb224"],
  pixels: [                       // one palette index per cell, 0 = transparent
    [0, 0, 1, 1, 0, 0],
    // …
  ],
  parts: {
    names: {  },
    colors: {  },
    grid: [
      [0, 0, 0, 0, 0, 0],
      // …
    ],
  },
};
```

- `palette[0]` is always `null` (transparent). Other entries are `#rrggbb`, or `#rrggbbaa` when the alpha is not
  255. Colors are listed in order of first appearance.
- `pixels` has one row per line of the image and one palette index per cell. A fully transparent pixel is `0`.
- `parts` is extra data kept for compatibility with existing files. When the data you imported had a valid
  `parts`, it is carried through unchanged; otherwise `names` and `colors` are empty and `grid` is all `0`.
- The JS export name comes from the image name. Characters outside `A–Z a–z 0–9 _ $` become `_`, and a `_` is
  added in front of names that start with a digit or are reserved words.

## ZIP

- Available with two or more images open, from the Export tab or **檔案 → 匯出全部（zip）** (File → Export all).
- Each image's PNG uses the current scale. An image that is too large for that scale goes in at 1×.
- Images up to 64×64 also get a `.json`.
- The archive is named `pixel-export-YYYY-MM-DD.zip`. Files are stored without compression.

## Import

Paste text through the **貼上 JSON / JS** card, **檔案 → 貼上 JSON / JS…**, or `Ctrl+V`. Import takes the
same format as export, plus two more:

- **Palette indexes**: `{ w, h, palette, pixels }` as above. `null` in `pixels` means transparent.
- **Hex strings**: `pixels` holds color strings (`#rgb`, `#rrggbb` or `#rrggbbaa`) directly, with no palette.
- **Flat RGBA**: `{ w, h, rgba: [r, g, b, a, r, g, b, a, …] }`, with `w × h × 4` numbers.
- A bare 2D array is read as `pixels`.

Details:

- `w` and `h` can be left out when `pixels` is given; they come from the array. Sizes go from 1 to 512 per side.
- The parser accepts what the exporter writes: bare keys, single quotes, trailing commas, `//` and `/* */`
  comments. The text is never run as code.
- The image name comes from `name`, then `export const <name>`, then a `// <name>.png` comment, otherwise
  `pasted`.
- If `parts.grid` does not match the image size, the image still loads and that extra data is skipped with a
  warning.
- Dragging a `.json` file onto the page does nothing; drag and drop only takes images. Paste its text instead.
