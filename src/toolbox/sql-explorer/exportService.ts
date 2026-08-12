/**
 * Streams table data to CSV, JSON, or Excel (.xlsx built as SpreadsheetML
 * in a zip via fflate).
 *
 * @module sql-explorer/exportService
 */

import * as fs from 'fs';
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import * as vscode from 'vscode';
import type { SqlServices } from '../../sql';
import { quoteIdent } from '../../sql/types';
import type { TableMetadata } from '../../sql/types';
import type { QueryParam } from '../../sql/queryRunner';
import type { PreviewTarget } from './previewPanel';

export type ExportFormat = 'csv' | 'json' | 'xlsx';

const FORMAT_FILTERS: Record<ExportFormat, Record<string, string[]>> = {
  csv: { 'CSV files': ['csv'] },
  json: { 'JSON files': ['json'] },
  xlsx: { 'Excel files': ['xlsx'] },
};

export async function exportTableData(
  services: SqlServices,
  target: PreviewTarget,
  table: TableMetadata,
  format: ExportFormat,
  where: string,
  params: QueryParam[]
): Promise<void> {
  const destination = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${target.objectName}.${format}`),
    filters: FORMAT_FILTERS[format],
    title: `Export ${target.objectName} as ${format.toUpperCase()}`,
  });
  if (!destination) {
    return;
  }

  const columns = table.fields.map((f) => f.sqlColumn);
  const selectList = columns.map((c) => quoteIdent(c)).join(', ');
  const query = `SELECT ${selectList} FROM ${quoteIdent(target.schema)}.${quoteIdent(target.objectName)} ${where}`;

  const rowCount = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting ${target.objectName}…`,
      cancellable: true,
    },
    async (progress, token) => {
      const writer =
        format === 'csv'
          ? new CsvWriter(destination.fsPath, columns)
          : format === 'json'
            ? new JsonWriter(destination.fsPath, columns)
            : new XlsxWriter(destination.fsPath, columns);
      let count = 0;
      try {
        count = await services.runner.stream(
          target.connectionId,
          target.database,
          query,
          {
            token,
            onRow: (row) => {
              writer.writeRow(columns.map((c) => row[c]));
              count += 1;
              if (count % 5000 === 0) {
                progress.report({ message: `${count.toLocaleString()} rows` });
              }
            },
          },
          params
        );
        await writer.finish();
      } catch (err) {
        await writer.abort();
        throw err;
      }
      return count;
    }
  );

  const openChoice = await vscode.window.showInformationMessage(
    `Exported ${rowCount.toLocaleString()} rows to ${destination.fsPath}`,
    'Open File'
  );
  if (openChoice === 'Open File') {
    if (format === 'xlsx') {
      await vscode.env.openExternal(destination);
    } else {
      await vscode.window.showTextDocument(destination);
    }
  }
}

// ── Writers ──────────────────────────────────────────────────────────────────

interface RowWriter {
  writeRow(values: unknown[]): void;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

class StreamFileWriter {
  protected readonly stream: fs.WriteStream;

  constructor(private readonly filePath: string) {
    this.stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  }

  protected write(chunk: string): void {
    this.stream.write(chunk);
  }

  protected close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  async abort(): Promise<void> {
    this.stream.destroy();
    await fs.promises.unlink(this.filePath).catch(() => undefined);
  }
}

class CsvWriter extends StreamFileWriter implements RowWriter {
  constructor(filePath: string, columns: string[]) {
    super(filePath);
    // UTF-8 BOM so Excel opens the file with correct encoding.
    this.write('\uFEFF');
    this.write(columns.map((c) => CsvWriter.escape(c)).join(',') + '\r\n');
  }

  static escape(value: string): string {
    if (/[",\r\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  writeRow(values: unknown[]): void {
    this.write(values.map((v) => CsvWriter.escape(cellText(v))).join(',') + '\r\n');
  }

  finish(): Promise<void> {
    return this.close();
  }
}

class JsonWriter extends StreamFileWriter implements RowWriter {
  private first = true;

  constructor(
    filePath: string,
    private readonly columns: string[]
  ) {
    super(filePath);
    this.write('[\n');
  }

  writeRow(values: unknown[]): void {
    const obj: Record<string, unknown> = {};
    this.columns.forEach((c, i) => {
      const v = values[i];
      obj[c] =
        v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? `0x${v.toString('hex')}` : v;
    });
    this.write(`${this.first ? '' : ',\n'}  ${JSON.stringify(obj)}`);
    this.first = false;
  }

  finish(): Promise<void> {
    this.write('\n]\n');
    return this.close();
  }
}

/**
 * Minimal streaming .xlsx writer: zip container with one worksheet using
 * inline strings (no sharedStrings part needed).
 */
class XlsxWriter implements RowWriter {
  private readonly out: fs.WriteStream;
  private readonly zip: Zip;
  private readonly sheet: ZipDeflate;
  private rowIndex = 1;
  private failed: Error | undefined;
  private readonly done: Promise<void>;

  constructor(
    private readonly filePath: string,
    columns: string[]
  ) {
    this.out = fs.createWriteStream(filePath);
    this.done = new Promise((resolve, reject) => {
      this.out.on('finish', resolve);
      this.out.on('error', reject);
    });
    this.zip = new Zip((err, chunk, final) => {
      if (err) {
        this.failed = err;
        this.out.destroy(err);
        return;
      }
      this.out.write(Buffer.from(chunk));
      if (final) {
        this.out.end();
      }
    });

    this.addStatic(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    );
    this.addStatic(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    );
    this.addStatic(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    );
    this.addStatic(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
    );

    this.sheet = new ZipDeflate('xl/worksheets/sheet1.xml', { level: 6 });
    this.zip.add(this.sheet);
    this.pushSheet(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
    );
    this.writeRow(columns);
  }

  private addStatic(name: string, content: string): void {
    const file = new ZipDeflate(name, { level: 6 });
    this.zip.add(file);
    file.push(strToU8(content), true);
  }

  private pushSheet(xml: string, final = false): void {
    this.sheet.push(strToU8(xml), final);
  }

  private static escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Strip control chars that are invalid in XML 1.0.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  writeRow(values: unknown[]): void {
    if (this.failed) {
      throw this.failed;
    }
    const cells = values
      .map((v) => {
        if (v === null || v === undefined) {
          return '<c/>';
        }
        if (typeof v === 'number' && Number.isFinite(v)) {
          return `<c><v>${v}</v></c>`;
        }
        if (typeof v === 'boolean') {
          return `<c t="b"><v>${v ? 1 : 0}</v></c>`;
        }
        return `<c t="inlineStr"><is><t xml:space="preserve">${XlsxWriter.escapeXml(cellText(v))}</t></is></c>`;
      })
      .join('');
    this.pushSheet(`<row r="${this.rowIndex}">${cells}</row>`);
    this.rowIndex += 1;
  }

  async finish(): Promise<void> {
    this.pushSheet('</sheetData></worksheet>', true);
    this.zip.end();
    await this.done;
    if (this.failed) {
      throw this.failed;
    }
  }

  async abort(): Promise<void> {
    try {
      this.zip.terminate();
    } catch {
      // already ended
    }
    this.out.destroy();
    await fs.promises.unlink(this.filePath).catch(() => undefined);
  }
}
