# Fonts

The three faces of the Almanac look ([plan 004](../../../docs/plans/004-the-almanac-look.md)): Atkinson Hyperlegible
for words, IBM Plex Mono for days, times and numbers, Jersey 15 for the few large things (a page's title, the day's
number, a reading's value), at 20 px and above only. All are under the SIL Open Font License 1.1. Each licence is the
`OFL-*.txt` file beside its fonts, and the app serves it with them. The files are copied from aminte
(`~/Projects/aminte/extensions/web/view/html/fonts/`).

The app serves every file of this folder at `/static/fonts/<file>` with a cache of one year, so **a changed file
gets a new name**.

Each face is in two files, as Google Fonts serves it: `latin` and `latin-ext` (the letters of Romanian and the other
Latin languages). `base.css` names both with their `unicode-range`, so a browser fetches `latin-ext` only for a page
that needs it. Any other script is drawn in the system fonts.

The files were fetched on 2026-10-12 from the Google Fonts stylesheets
`https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500`
and `https://fonts.googleapis.com/css2?family=Jersey+15`. The licences are `ofl/atkinsonhyperlegible/OFL.txt`,
`ofl/ibmplexmono/OFL.txt` and `ofl/jersey15/OFL.txt` of `github.com/google/fonts`.

| file | source | sha256 |
|---|---|---|
| `atkinson-hyperlegible-400-latin.woff2` | `fonts.gstatic.com/s/atkinsonhyperlegible/v12/9Bt23C1KxNDXMspQ1lPyU89-1h6ONRlW45G04pIo.woff2` | `d64ba838ef5472bba248620ec4fd8b5aa7cf0db2908e0bb230600caf279ba7bc` |
| `atkinson-hyperlegible-400-latin-ext.woff2` | `fonts.gstatic.com/s/atkinsonhyperlegible/v12/9Bt23C1KxNDXMspQ1lPyU89-1h6ONRlW45G07JIoSwQ.woff2` | `61eeb0eb8b881a84d069e67be1723f5b353b0b9b866ad8e7ad9dba66cdc4dabd` |
| `atkinson-hyperlegible-400-italic-latin.woff2` | `fonts.gstatic.com/s/atkinsonhyperlegible/v12/9Bt43C1KxNDXMspQ1lPyU89-1h6ONRlW45G056IqUwA.woff2` | `bc8825fd435d4aa8e31449937826d583a7daaae15a83832c91b38375131ebf08` |
| `atkinson-hyperlegible-400-italic-latin-ext.woff2` | `fonts.gstatic.com/s/atkinsonhyperlegible/v12/9Bt43C1KxNDXMspQ1lPyU89-1h6ONRlW45G056IkUwCybQ.woff2` | `90d887d541fe6e912d15f826aae6ca1190efcf172b65401704472475ed771049` |
| `atkinson-hyperlegible-700-latin.woff2` | `fonts.gstatic.com/s/atkinsonhyperlegible/v12/9Bt73C1KxNDXMspQ1lPyU89-1h6ONRlW45G8Wbc9dCWP.woff2` | `140e2bd25a7315c8a062508391426b0d8c3297400c947b8d847be28f73a199f0` |
| `atkinson-hyperlegible-700-latin-ext.woff2` | `fonts.gstatic.com/s/atkinsonhyperlegible/v12/9Bt73C1KxNDXMspQ1lPyU89-1h6ONRlW45G8Wbc9eiWPVFw.woff2` | `840ced16f975d8abc2594b436d0206649e0c2a7327e36750ff849d3d37c3c02e` |
| `ibm-plex-mono-400-latin.woff2` | `fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2` | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` |
| `ibm-plex-mono-400-latin-ext.woff2` | `fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1iEq129k.woff2` | `6bc0f226a5b7884a8170e3f62c63d7675609d4631bdc5931b5cdab81821f00eb` |
| `ibm-plex-mono-500-latin.woff2` | `fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgg.woff2` | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` |
| `ibm-plex-mono-500-latin-ext.woff2` | `fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl5FgtIU.woff2` | `6bb06407c97584b0867a959e05e8874693bfeb8c317de190811c51598f2d99ea` |
| `jersey-15-400-latin.woff2` | `fonts.gstatic.com/s/jersey15/v4/_6_9EDzuROGsUuk2TWjiZYAg.woff2` | `244065acc0429b77f9eb21b4f79ccb5547a8eec944ae1c07d4901f1e9ccd8f3b` |
| `jersey-15-400-latin-ext.woff2` | `fonts.gstatic.com/s/jersey15/v4/_6_9EDzuROGsUuk2TWjia4AggCk.woff2` | `c2222da8ac1509998586b7c7d7eb377036fcdd3ed2808701c81e6bc2b2a78375` |
