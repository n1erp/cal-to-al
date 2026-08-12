// Database comparison dashboard: summary cards + expandable table diff list.
(function () {
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);

  let report = null;
  let search = '';
  let section = 'all';

  const DIFF_LABELS = {
    'missing-in-source': 'Added in destination',
    'missing-in-destination': 'Missing in destination',
    'sql-type': 'Different SQL type',
    'bc-type': 'Different BC type',
    nullable: 'Nullable difference',
    'primary-key': 'Primary key difference',
  };

  function matches(name) {
    return !search || name.toLowerCase().includes(search.toLowerCase());
  }

  function setEmpty(empty) {
    el('emptyState').classList.toggle('hidden', !empty);
    el('summary').classList.toggle('hidden', empty);
    el('results').classList.toggle('hidden', empty);
    el('searchBox').disabled = empty;
    el('sectionFilter').disabled = empty;
  }

  function renderSummary() {
    const s = el('summary');
    s.innerHTML = '';
    const identical = report.matched.filter((m) => m.fieldDiffs.length === 0).length;
    const withDiffs = report.matched.length - identical;
    const cards = [
      { n: report.matched.length, l: 'Tables in both', cls: 'ok' },
      { n: identical, l: 'Identical structure', cls: 'ok' },
      { n: withDiffs, l: 'With field differences', cls: 'warn' },
      { n: report.missingInDestination.length, l: 'Tables added', cls: 'err' },
      { n: report.missingInSource.length, l: 'Added in destination', cls: 'err' },
    ];
    for (const c of cards) {
      const div = document.createElement('div');
      div.className = 'card ' + c.cls;
      div.innerHTML = '<div class="num"></div><div class="lbl"></div>';
      div.querySelector('.num').textContent = c.n;
      div.querySelector('.lbl').textContent = c.l;
      s.appendChild(div);
    }
  }

  function makeDetailTable(diffs) {
    const wrap = document.createElement('div');
    if (!diffs.length) {
      wrap.textContent = 'No field differences.';
      return wrap;
    }
    const table = document.createElement('table');
    table.innerHTML =
      '<thead><tr><th>Field</th><th>Difference</th><th>Source</th><th>Destination</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const d of diffs) {
      const tr = document.createElement('tr');
      const cells = [d.fieldName, DIFF_LABELS[d.kind] || d.kind, d.sourceValue ?? '—', d.destinationValue ?? '—'];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function makeRow(title, badges, detailBuilder) {
    const row = document.createElement('div');
    row.className = 'tbl-row';
    const head = document.createElement('div');
    head.className = 'tbl-head';
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = detailBuilder ? '▸' : '';
    const names = document.createElement('span');
    names.className = 'names';
    names.textContent = title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    for (const b of badges) {
      const span = document.createElement('span');
      span.className = 'badge ' + (b.cls || '');
      span.textContent = b.text;
      meta.appendChild(span);
    }
    head.appendChild(chev);
    head.appendChild(names);
    head.appendChild(meta);
    row.appendChild(head);

    if (detailBuilder) {
      let detail = null;
      head.addEventListener('click', () => {
        if (detail) {
          detail.classList.toggle('hidden');
          chev.textContent = detail.classList.contains('hidden') ? '▸' : '▾';
          return;
        }
        detail = document.createElement('div');
        detail.className = 'tbl-detail';
        detail.appendChild(detailBuilder());
        row.appendChild(detail);
        chev.textContent = '▾';
      });
    }
    return row;
  }

  function renderResults() {
    const container = el('results');
    container.innerHTML = '';

    const addSection = (title, rows) => {
      const h = document.createElement('h2');
      h.className = 'section-title';
      h.textContent = title;
      container.appendChild(h);
      if (!rows.length) {
        const p = document.createElement('div');
        p.className = 'empty';
        p.textContent = 'None';
        container.appendChild(p);
        return;
      }
      for (const r of rows) {
        container.appendChild(r);
      }
    };

    if (section === 'all' || section === 'matched' || section === 'diffs') {
      let matched = report.matched.filter(
        (m) => matches(m.source.tableName) || matches(m.destination.tableName)
      );
      if (section === 'diffs') {
        matched = matched.filter((m) => m.fieldDiffs.length > 0);
      }
      addSection(
        'Tables existing in both (' + matched.length + ')',
        matched.map((m) => {
          const badges = [];
          if (m.matchedBy === 'fuzzy') {
            badges.push({ text: 'renamed · ' + Math.round(m.confidence * 100) + '%', cls: 'warn' });
          } else if (m.matchedBy === 'bc-id') {
            badges.push({ text: 'BC ID ' + m.source.bcTableId, cls: 'ok' });
          }
          badges.push(
            m.fieldDiffs.length === 0
              ? { text: 'identical', cls: 'ok' }
              : { text: m.fieldDiffs.length + ' differences', cls: 'warn' }
          );
          badges.push({ text: Number(m.source.rowCount).toLocaleString() + ' rows' });
          const title =
            m.source.tableName === m.destination.tableName
              ? m.source.schema + '.' + m.source.tableName
              : m.source.tableName + '  →  ' + m.destination.tableName;
          return makeRow(title, badges, () => makeDetailTable(m.fieldDiffs));
        })
      );
    }

    if (section === 'all' || section === 'missing-dest') {
      const rows = report.missingInDestination.filter((t) => matches(t.tableName));
      addSection(
        'Tables added (' + rows.length + ')',
        rows.map((t) =>
          makeRow(t.schema + '.' + t.tableName, [
            { text: t.fieldCount + ' fields' },
            { text: Number(t.rowCount).toLocaleString() + ' rows' },
            { text: 'Tables added', cls: 'err' },
          ])
        )
      );
    }

    if (section === 'all' || section === 'missing-src') {
      const rows = report.missingInSource.filter((t) => matches(t.tableName));
      addSection(
        'Added in destination (' + rows.length + ')',
        rows.map((t) =>
          makeRow(t.schema + '.' + t.tableName, [
            { text: t.fieldCount + ' fields' },
            { text: Number(t.rowCount).toLocaleString() + ' rows' },
            { text: 'Added in destination', cls: 'err' },
          ])
        )
      );
    }
  }

  function applyReport(payload) {
    report = payload.report;
    if (!report) {
      el('compareSubtitle').textContent = payload.reportPath
        ? 'No file at ' + payload.reportPath
        : 'No comparison loaded.';
      setEmpty(true);
      return;
    }
    setEmpty(false);
    el('compareSubtitle').textContent =
      'Source: ' +
      report.source.connectionName +
      ' / ' +
      report.source.database +
      '\nDestination: ' +
      report.destination.connectionName +
      ' / ' +
      report.destination.database;
    renderSummary();
    renderResults();
  }

  el('searchBox').addEventListener('input', (e) => {
    search = e.target.value;
    if (report) {
      renderResults();
    }
  });

  el('sectionFilter').addEventListener('change', (e) => {
    section = e.target.value;
    if (report) {
      renderResults();
    }
  });

  el('btnOpenMigration').addEventListener('click', () =>
    vscode.postMessage({ command: 'openMigrationDashboard' })
  );

  el('btnOpenFile').addEventListener('click', () => vscode.postMessage({ command: 'openReportFile' }));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.command === 'report') {
      applyReport(message.data);
    }
    if (message.command === 'init') {
      applyReport({ report: message.data.report, reportPath: '' });
    }
  });

  vscode.postMessage({ command: 'ready' });
})();
