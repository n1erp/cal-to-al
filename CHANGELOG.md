# Changelog

All notable changes to this project will be documented in this file.

---

## [4.0.0] - 2026-08-12

### ✨ Added — Data Migration Studio

- **SQL Explorer** view in the Activity Bar: save multiple SQL Server connections (SQL auth and Windows/NTLM auth, passwords in Secret Storage) and browse databases → schemas → tables / views / stored procedures.
- **Table preview** webview: paged data grid with search, per-column filters, column sorting, and a metadata tab (SQL type, BC type, nullable, identity, PK, FKs, defaults).
- **Export table data** to CSV, Excel (`.xlsx`), and JSON with streaming for large tables.
- **Database metadata scanner**: full structural model per database, enriched with NAV/BC metadata (BC table IDs, `DataPerCompany` detection, BC data types, keys, relationships, row counts).
- **Database Comparison** panel: tables in both / missing / renamed (fuzzy best match) and per-field differences (SQL type, BC type, nullable, primary key).
- **Smart Mapping Engine**: auto-match tables and fields by BC ID → name → fuzzy similarity, with manual include/exclude overrides in the dashboard (persisted to `.cal2al/mappings.json`).
- **Migration query generator**: `INSERT INTO … SELECT` per mapped table with identity handling and a transformation-rule hook.
- **Migration plan JSON** (`.cal2al/migration-plan.json`): one entry per table with query, estimated rows, status, timings, retry counters, and errors — written atomically on every change so it doubles as the execution log.
- **Migration execution engine**: execute one / selected / all tables, resume pending, retry failed, and stop; transactions with rollback on failure; cross-server migrations via streamed batch bulk copy; logs in the **Data Migration** output channel.
- **Migration Dashboard** webview: live status grid, progress bar, multi-select, SQL preview per row, field mapping editor, and HTML/CSV execution report export.
- New settings: `dataMigration.batchSize`, `dataMigration.queryTimeoutSeconds`, `dataMigration.planFolder`.

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
