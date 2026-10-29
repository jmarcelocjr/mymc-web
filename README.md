# mymc-web

A PlayStation 2 memory card viewer and manager that runs entirely in the browser.
Open a PCSX2 memory card (`.ps2`) to browse its saves in a screen inspired by the PS2's own memory card browser, and export, import or delete saves. Nothing is uploaded, and the original file is never changed: edits produce a new card to download.

Work in progress. See [`ps2-memcard-manager-plan.md`](ps2-memcard-manager-plan.md) for the plan (in Portuguese).

## Development

```sh
npm install
npm run dev        # local dev server
npm test           # unit tests
npm run lint
npm run build
```

Test fixtures in `test/fixtures` are synthetic cards built with [mymc++](https://github.com/Adubbz/mymcplusplus). To rebuild them (needs Python 3):

```sh
npm run fixtures
```

To also run the tests against your own card (it never leaves your machine):

```sh
PS2_REAL_CARD=/path/to/Mcd001.ps2 npm test
```

## Credits and license

The memory card format handling is based on mymc by Ross Ridge and mymc++, both GPL-3.0.
This project is licensed under the GNU General Public License v3.0 or later; see [LICENSE](LICENSE).
