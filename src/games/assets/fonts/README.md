# Bundled board fonts

These fonts are checked into the application so board rendering never depends on fonts installed on the host.

| File | Upstream | Pinned source | SHA-256 | License |
| --- | --- | --- | --- | --- |
| `NotoSansSymbols-Regular.ttf` | Noto Symbols | `notofonts/symbols`, release `NotoSansSymbols-v2.003`, `NotoSansSymbols/full/ttf/NotoSansSymbols-Regular.ttf` | `0088617baec0e8ac47e022cc1f38695f772301c9ef6d1f24a785abbeF1e05d79` | SIL Open Font License 1.1; see `NotoSansSymbols-OFL.txt` |
| `Cubic_11.ttf` | Cubic 11 | `ACh-K/Cubic-11`, tag `v1.500`, `fonts/ttf/Cubic_11.ttf` | `0193f5f033612496df6b45ee92ac3b335bc6a5a24ff95da55ca87b33e57dcf62` | SIL Open Font License 1.1; see `Cubic_11-OFL.txt` |

Acquired on 2026-09-22 from the pinned official GitHub release/tag. The renderer loads these byte buffers with system-font loading disabled.
