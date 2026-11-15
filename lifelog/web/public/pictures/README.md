# Pictures

The pixel art of the Almanac look ([plan 004](../../../docs/plans/004-the-almanac-look.md)), copied as PNG files
from aminte (`~/Projects/aminte/extensions/web/view/html/`):

| file | what | where `app.css` uses it |
|---|---|---|
| `wood.png` | the wood tile (84 by 160 pixels, drawn at 3) | the rail and the phone's bars |
| `ground.png` | the faint tile of boards (160 by 96 pixels, drawn at 3) | the floor under the page |
| `icons.png` | the icon sheet: 14 glyphs of 10 by 10 in cells of 16 | `span.icon` (a mask over the text colour) |

The app icons (`../icon.svg`, `../icon-192.png`, `../icon-512.png`) come from the same place.

The Go code that draws them is not in lifelog. Its source is aminte's package `pixelart/` (and `tools/pixelart`,
which writes the files; aminte plans 137, 138 and 139). To change a picture, draw it there and copy the PNG here.
The order of the cells of `icons.png` is `pixelart.IconNames`: today, calendar, browse, people, files, metrics,
search, new, more, image, video, audio, week, chat.
