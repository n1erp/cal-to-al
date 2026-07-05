# `bin/`

Native tools and data the extension ships with. Everything here is used at
runtime during conversion; nothing is compiled from `src/`.

```
bin/
├─ txt2al/              # Txt2Al converter (exe + dependencies)
├─ 90/                  # NAV 2016 Model Tools (delta generation)
└─ object-mapping.json  # C/AL → AL object reference mapping
```

## `txt2al/`

The Microsoft **Txt2Al** command-line converter and all of its runtime
dependencies (self-contained). `Txt2Al.exe` turns a NAV C/AL `.txt` export into
Business Central `.al` objects. This is the core engine behind every conversion
(Conversion Wizard, explorer right-click, and delta conversion).

- Entry point: `txt2al/Txt2Al.exe`
- The surrounding `.dll` files (CodeAnalysis, Dynamics.Nav.*, Newtonsoft.Json,
  Mono.Cecil, etc.) are dependencies loaded by the exe — keep them next to it.

Resolution order (see `resolveTxt2AlPath` in `src/conversionService.ts`):


## `90/`

The **NAV 2016 Model Tools** (Dynamics NAV Development Shell, version `90`).
Used only for **delta generation**: the extension invokes `NavModelTools.ps1`
and `Compare-NAVApplicationObject` to produce a delta between an old and a new
C/AL export before converting it to AL.

- Script entry point: `90/NavModelTools.ps1`
- Referenced via `DIRECTORY_NAMES.NAV_MODEL_TOOLS` in `src/constants.ts`.

## `object-mapping.json`

A lookup table mapping legacy numeric C/AL object references to their AL object
names (e.g. `Codeunit "1214"` → `Codeunit "Map DataExch To Intermediate"`).
After `txt2al` runs, the extension uses this file to replace stale numeric
references in the generated AL so the output compiles against modern BC.