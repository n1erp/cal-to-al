# Changelog

All notable changes to this project will be documented in this file.

---

## [3.0.0] - 2026-07-06

### ✨ Added
- Activity Bar container **C/AL → AL** with a dedicated toolbox TreeView.
- **C/Side Prettier** toolbox entry for working with NAV C/AL export files.
- **Conversion Wizard** webview in the sidebar for guided txt2al conversion setup.
- **Delta Details** tool to compare two object export files side by side using Diff Match Patch.
- Contributor guide (`src/conversionService.README.md`).
- Conversion Wizard **Settings** tab for all `calToAl.*` configuration options.


---

## [2.0.0] - 2026-06-01

### ✨ Added
- Add all paramters of txt2al in Settings of the extension.
- Enables detailed logging `_conversion.log` for capturing full conversion details to the log file.
- Improved output file naming convention: {type}-{id}.{name}.al and a dedicated src-cal-to-al output folder for cleaner workspace organisation.
- Improve Real-time conversion progress with naming of file that are converting.
- Resolve the issue of  variable declarations are generated using numeric object references instead of readable object names.

---

## [1.1.0] - 2026-01-27

### ✨ Added
- Advanced configuration options to customize txt2al behavior
- Support for advanced txt2al parameter `--tableDataOnly` via VS Code settings (`calToAl.tableDataOnly`)

---

## [1.0.0] - 2026-01-26

### 🎉 Initial Release
- Convert C/AL objects to AL directly from VS Code
- Right-click support on files and folders
- Conversion logs inside VS Code
- Automatic generation of AL output folder
