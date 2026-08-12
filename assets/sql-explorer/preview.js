// Table preview webview: paged grid + search + per-column filters + metadata tab.
(function () {
  const vscode = acquireVsCodeApi();

  const el = (id) => document.getElementById(id);
  const tableTitle = el('tableTitle');
  const tableSubtitle = el('tableSubtitle');
  const statusBar = el('statusBar');
  const gridHead = el('gridHead');
  const gridBody = el('gridBody');
  const metaBody = el('metaBody');
  const metaKeys = el('metaKeys');
  const pageInfo = el('pageInfo');
  const rowTotal = el('rowTotal');
  const searchBox = el('searchBox');
  const pageSizeSelect = el('pageSize');

  let meta = null;
  let page = 1;
  let pageSize = 100;
  let total = 0;
  let sortColumn = null;
  let sortDir = 'asc';
  let filters = {}; // column -> value
  let searchText = '';
  let searchTimer = null;

  function post(command, data) {
    vscode.postMessage({ command, data });
  }

  function setStatus(kind, text) {
    if (!text) {
      statusBar.classList.add('hidden');
      return;
    }
    statusBar.className = 'status ' + kind;
    statusBar.textContent = text;
  }

  function totalPages() {
    return Math.max(1, Math.ceil(total / pageSize));
  }

  function load() {
    setStatus('info', 'Loading…');
    const filterList = Object.entries(filters)
      .filter(([, v]) => v !== '')
      .map(([column, value]) => ({ column, op: 'contains', value }));
    post('load', {
      page,
      pageSize,
      sortColumn: sortColumn || undefined,
      sortDir,
      search: searchText || undefined,
      filters: filterList,
    });
  }

  function renderHead() {
    gridHead.innerHTML = '';
    if (!meta) return;

    const headRow = document.createElement('tr');
    for (const field of meta.fields) {
      const th = document.createElement('th');
      th.textContent = field.sqlColumn;
      if (field.isPrimaryKey) {
        th.textContent += ' 🔑';
      }
      if (sortColumn === field.sqlColumn) {
        const mark = document.createElement('span');
        mark.className = 'sort-mark';
        mark.textContent = sortDir === 'asc' ? '▲' : '▼';
        th.appendChild(mark);
      }
      th.title = field.sqlTypeFull + (field.nullable ? ', nullable' : '');
      th.addEventListener('click', () => {
        if (sortColumn === field.sqlColumn) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortColumn = field.sqlColumn;
          sortDir = 'asc';
        }
        page = 1;
        renderHead();
        load();
      });
      headRow.appendChild(th);
    }
    gridHead.appendChild(headRow);

    const filterRow = document.createElement('tr');
    filterRow.className = 'filter-row';
    for (const field of meta.fields) {
      const th = document.createElement('th');
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'filter…';
      input.value = filters[field.sqlColumn] || '';
      input.addEventListener('input', () => {
        filters[field.sqlColumn] = input.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          page = 1;
          load();
        }, 400);
      });
      th.appendChild(input);
      filterRow.appendChild(th);
    }
    gridHead.appendChild(filterRow);
  }

  function renderRows(rows) {
    gridBody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        if (cell === null || cell === undefined) {
          td.textContent = 'NULL';
          td.className = 'null';
        } else {
          td.textContent = String(cell);
          td.title = String(cell);
        }
        tr.appendChild(td);
      }
      gridBody.appendChild(tr);
    }
  }

  function renderMeta() {
    if (!meta) return;
    metaBody.innerHTML = '';
    const fkColumns = new Map();
    for (const fk of meta.foreignKeys || []) {
      fk.columns.forEach((c, i) => {
        fkColumns.set(
          c,
          fk.referencedSchema + '.' + fk.referencedTable + '(' + fk.referencedColumns[i] + ')'
        );
      });
    }
    meta.fields.forEach((f, i) => {
      const tr = document.createElement('tr');
      const cells = [
        f.columnId,
        f.fieldName,
        f.sqlTypeFull,
        f.bcType || '',
        f.nullable ? 'Yes' : 'No',
        f.identity ? 'Yes' : 'No',
        f.isPrimaryKey ? 'Yes' : 'No',
        fkColumns.get(f.sqlColumn) || '',
        f.defaultValue || '',
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = String(c);
        tr.appendChild(td);
      }
      metaBody.appendChild(tr);
    });

    metaKeys.innerHTML = '';
    const addSection = (title, items) => {
      if (!items.length) return;
      const h = document.createElement('h3');
      h.textContent = title;
      metaKeys.appendChild(h);
      for (const item of items) {
        const div = document.createElement('div');
        div.textContent = item;
        metaKeys.appendChild(div);
      }
    };
    addSection('Primary Key', meta.primaryKey.length ? [meta.primaryKey.join(', ')] : []);
    addSection(
      'Secondary Keys',
      (meta.secondaryKeys || []).map(
        (k) => k.name + ': ' + k.columns.join(', ') + (k.isUnique ? ' (unique)' : '')
      )
    );
    addSection(
      'Foreign Keys',
      (meta.foreignKeys || []).map(
        (fk) =>
          fk.name +
          ': (' +
          fk.columns.join(', ') +
          ') → ' +
          fk.referencedSchema +
          '.' +
          fk.referencedTable +
          ' (' +
          fk.referencedColumns.join(', ') +
          ')'
      )
    );

    const badges = [];
    if (meta.bcTableId !== null) badges.push('BC Table ID: ' + meta.bcTableId);
    if (meta.dataPerCompany) badges.push('DataPerCompany (' + meta.companyName + ')');
    badges.push('Rows: ' + Number(meta.rowCount).toLocaleString());
    tableSubtitle.textContent = badges.join('  ·  ');
  }

  function updatePager() {
    pageInfo.textContent = 'Page ' + page + ' / ' + totalPages();
    rowTotal.textContent = total.toLocaleString() + ' rows';
  }

  // ── Toolbar events ──────────────────────────────────────────────────────────

  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchText = searchBox.value;
      page = 1;
      load();
    }, 400);
  });

  pageSizeSelect.addEventListener('change', () => {
    pageSize = Number(pageSizeSelect.value);
    page = 1;
    load();
  });

  el('btnFirst').addEventListener('click', () => {
    if (page !== 1) {
      page = 1;
      load();
    }
  });
  el('btnPrev').addEventListener('click', () => {
    if (page > 1) {
      page -= 1;
      load();
    }
  });
  el('btnNext').addEventListener('click', () => {
    if (page < totalPages()) {
      page += 1;
      load();
    }
  });
  el('btnLast').addEventListener('click', () => {
    if (page !== totalPages()) {
      page = totalPages();
      load();
    }
  });

  el('btnRefresh').addEventListener('click', () => post('refresh'));
  el('btnExportCsv').addEventListener('click', () => post('export', { format: 'csv' }));
  el('btnExportXlsx').addEventListener('click', () => post('export', { format: 'xlsx' }));
  el('btnExportJson').addEventListener('click', () => post('export', { format: 'json' }));

  el('tabData').addEventListener('click', () => {
    el('tabData').classList.add('active');
    el('tabMeta').classList.remove('active');
    el('dataView').classList.remove('hidden');
    el('metaView').classList.add('hidden');
  });
  el('tabMeta').addEventListener('click', () => {
    el('tabMeta').classList.add('active');
    el('tabData').classList.remove('active');
    el('metaView').classList.remove('hidden');
    el('dataView').classList.add('hidden');
  });

  // ── Inbound messages ────────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
      case 'init': {
        meta = message.data.meta;
        tableTitle.textContent =
          message.data.database + '.' + message.data.schema + '.' + message.data.table;
        filters = {};
        renderHead();
        renderMeta();
        break;
      }
      case 'page': {
        total = message.data.total;
        page = message.data.page;
        renderRows(message.data.rows);
        updatePager();
        setStatus('', '');
        break;
      }
      case 'error':
        setStatus('error', message.data.message);
        break;
      default:
        break;
    }
  });

  post('ready');
})();
