# vendored version data

protocol and registry data for Minecraft versions that the installed
`minecraft-data` release does not ship yet, so botfleet can run on the
newest servers instead of waiting for the upstream prismarine stack.

| version | source | status |
| --- | --- | --- |
| 26.2 | PrismarineJS/minecraft-data PR #1219 (branch `pc_26_2`) | upstream PR open |
| 26.3 | PrismarineJS/minecraft-data PR #1300 + #1301 (branch `pc-26.3-support`, DallasCarraher fork) | upstream PR open |

each `<version>/` folder holds the data types that version owns. shared
types (effects, enchantments, instruments from 26.1; mapIcons from 1.20.2;
windows from 1.20.3) resolve against the official installed minecraft-data,
mirroring how upstream `dataPaths.json` maps them. 26.3 additionally reuses
the vendored 26.2 files for the types upstream maps to `pc/26.2`.

license: MIT, same as minecraft-data itself. generated data, extracted from
the official Mojang server jars by the minecraft-data contributors.

the loader (`../index.js`) skips a vendored version completely once the
installed minecraft-data supports it natively — the overlay is a stopgap,
not a fork. `scripts/version-check.mjs` and the daily `version-guard`
workflow track both sides and open an issue when a brand-new Minecraft
release has no data path at all yet.
