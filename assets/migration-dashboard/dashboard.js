// Migration Dashboard webview: live plan grid, execution actions, SQL preview,
// field mapping overrides, and progress feedback.
(function () {
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);

  let plan = null;
  let mappings = {};
  let workflow = {
    comparisonExists: false,
    comparisonComparedAt: null,
    comparisonPath: '',
    comparisonMatchedTables: 0,
    planLinkedToComparison: false,
    comparisonStale: false,
  };
  let runState = { running: false, currentEntryId: null, queued: [], currentRows: 0 };
  let selected = new Set();
  let expanded = new Set();
  let search = '';
  let statusFilter = 'all';
  let sortKey = null;
  let sortDir = 1;

  const STATUS_ICONS = {
    Pending: '◌',
    Running: '⟳',
    Completed: '✔',
    Failed: '✖',
    Stopped: '■',
  };

  function post(command, data) {
    vscode.postMessage({ command, data });
  }

  function fmtNum(n) {
    return n === null || n === undefined ? '—' : Number(n).toLocaleString();
  }

  function fmtDuration(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return ms + ' ms';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + ' s';
    return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
  }

  function visibleEntries() {
    if (!plan) return [];
    let entries = plan.entries.filter((e) => {
      if (statusFilter !== 'all' && e.status !== statusFilter) return false;
      if (
        search &&
        !e.table_src.toLowerCase().includes(search.toLowerCase()) &&
        !e.table_trgt.toLowerCase().includes(search.toLowerCase())
      )
        return false;
      return true;
    });
    if (sortKey) {
      entries = entries.slice().sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
        return String(av).localeCompare(String(bv)) * sortDir;
      });
    }
    return entries;
  }

  const FIELD_DIFF_LABELS = {
    'missing-in-source': 'Added in destination',
    'missing-in-destination': 'Missing in destination',
    'sql-type': 'Different SQL type',
    'bc-type': 'Different BC type',
    nullable: 'Nullable difference',
    'primary-key': 'Primary key difference',
  };

  function renderWorkflowBanner() {
    const banner = el('workflowBanner');
    banner.innerHTML = '';
    banner.classList.add('hidden');
    if (!plan && workflow.comparisonExists) {
      banner.classList.remove('hidden');
      banner.className = 'workflow-banner info';
      banner.innerHTML =
        '<span>Step 2 of 2: Comparison ready (' +
        workflow.comparisonMatchedTables +
        ' matched tables). Create a migration plan to generate INSERT queries.</span>' +
        '<button type="button" id="bannerCreatePlan" class="primary">Create Migration Plan</button>';
      banner.querySelector('#bannerCreatePlan').addEventListener('click', () =>
        post('createPlanFromComparison')
      );
      return;
    }
    if (plan && workflow.comparisonStale) {
      banner.classList.remove('hidden');
      banner.className = 'workflow-banner warn';
      banner.textContent =
        'The saved database comparison is newer than this migration plan. Re-run Create Migration Plan to stay aligned.';
    } else if (plan && workflow.comparisonExists && workflow.planLinkedToComparison) {
      banner.classList.remove('hidden');
      banner.className = 'workflow-banner ok';
      banner.textContent =
        'Migration plan is linked to the saved database comparison (' +
        (workflow.comparisonComparedAt || '') +
        ').';
    }
  }

  function renderEmptyState() {
    const box = el('emptyState');
    const lead = el('emptyLead');
    const actions = el('emptyActions');
    actions.innerHTML = '';
    if (plan) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    if (!workflow.comparisonExists) {
      lead.innerHTML =
        'No migration plan yet. Start with <b>CAL to AL: Create Database Comparison</b> ' +
        'to scan source and destination, then create a migration plan from the matched tables.';
      const b1 = document.createElement('button');
      b1.type = 'button';
      b1.className = 'primary';
      b1.textContent = 'Create Database Comparison';
      b1.addEventListener('click', () => post('createDatabaseComparison'));
      actions.appendChild(b1);
      return;
    }
    lead.innerHTML =
      'Comparison loaded (' +
      workflow.comparisonMatchedTables +
      ' matched tables). Run <b>CAL to AL: Create Migration Plan</b> to build INSERT queries for those tables.';
    const b2 = document.createElement('button');
    b2.type = 'button';
    b2.className = 'primary';
    b2.textContent = 'Create Migration Plan';
    b2.addEventListener('click', () => post('createPlanFromComparison'));
    actions.appendChild(b2);
    const b3 = document.createElement('button');
    b3.type = 'button';
    b3.textContent = 'Open Database Comparison';
    b3.addEventListener('click', () => post('openComparisonDashboard'));
    actions.appendChild(b3);
  }

  function renderHeaderInfo() {
    const info = el('planInfo');
    if (!plan) {
      info.textContent = 'No migration plan loaded.';
      return;
    }
    info.textContent =
      'Source: ' +
      plan.source.connectionName +
      ' / ' +
      plan.source.database +
      '\nDestination: ' +
      plan.destination.connectionName +
      ' / ' +
      plan.destination.database;
  }

  function renderProgress() {
    const fill = el('progressFill');
    const bar = fill.parentElement;
    const text = el('progressText');
    const running = el('runningText');

    if (!plan) {
      text.textContent = '';
      running.textContent = '';
      bar.classList.remove('active');
      fill.style.right = '100%';
      return;
    }
    const done = plan.entries.filter((e) => e.status === 'Completed').length;
    const failed = plan.entries.filter((e) => e.status === 'Failed').length;
    const pct = plan.entries.length ? Math.round((done / plan.entries.length) * 100) : 0;
    text.textContent =
      done + ' / ' + plan.entries.length + ' completed (' + pct + '%)' +
      (failed ? '  ·  ' + failed + ' failed' : '');
    bar.classList.add('active');
    fill.style.right = 100 - pct + '%';

    if (runState.running && runState.currentEntryId) {
      const entry = plan.entries.find((e) => e.id === runState.currentEntryId);
      running.textContent = entry
        ? 'Running: ' + entry.table_trgt +
          (runState.currentRows ? '  (' + fmtNum(runState.currentRows) + ' rows)' : '')
        : 'Running…';
    } else {
      running.textContent = runState.running ? 'Running…' : '';
    }
  }

  function makeDetailRow(entry) {
    const tr = document.createElement('tr');
    tr.className = 'detail-row';
    const td = document.createElement('td');
    td.colSpan = 11;

    const grid = document.createElement('div');
    grid.className = 'detail-grid';

    if (!entry.mapping_complete) {
      const warn = document.createElement('div');
      warn.className = 'warn-box';
      warn.textContent =
        'Schema not fully aligned (' +
        (entry.field_diff_count || 0) +
        ' field difference(s) from comparison). Review SQL and field mapping before executing.';
      grid.appendChild(warn);
    }

    // SQL preview.
    const sqlBox = document.createElement('div');
    const sqlTitle = document.createElement('h3');
    sqlTitle.textContent = 'Generated SQL (' + entry.mode + ')';
    const pre = document.createElement('pre');
    pre.className = 'sql';
    pre.textContent = entry.query;
    sqlBox.appendChild(sqlTitle);
    sqlBox.appendChild(pre);
    if (entry.error_message) {
      const err = document.createElement('div');
      err.className = 'error-box';
      err.textContent =
        'Error' + (entry.error_code ? ' ' + entry.error_code : '') + ': ' + entry.error_message;
      sqlBox.appendChild(err);
    }
    grid.appendChild(sqlBox);

    const diffs = entry.field_diffs || [];
    if (diffs.length) {
      const diffBox = document.createElement('div');
      const diffTitle = document.createElement('h3');
      diffTitle.textContent = 'Field Differences (from comparison)';
      diffBox.appendChild(diffTitle);
      const table = document.createElement('table');
      table.className = 'diff-table';
      table.innerHTML =
        '<thead><tr><th>Field</th><th>Difference</th><th>Source</th><th>Destination</th></tr></thead>';
      const tbody = document.createElement('tbody');
      for (const d of diffs) {
        const trd = document.createElement('tr');
        for (const c of [
          d.fieldName,
          FIELD_DIFF_LABELS[d.kind] || d.kind,
          d.sourceValue ?? '—',
          d.destinationValue ?? '—',
        ]) {
          const tdc = document.createElement('td');
          tdc.textContent = c;
          trd.appendChild(tdc);
        }
        tbody.appendChild(trd);
      }
      table.appendChild(tbody);
      diffBox.appendChild(table);
      grid.appendChild(diffBox);
    }

    // Field mapping editor.
    const mapping = mappings[entry.mapping_id];
    const fieldsBox = document.createElement('div');
    const fieldsTitle = document.createElement('h3');
    fieldsTitle.textContent = 'Field Mapping';
    fieldsBox.appendChild(fieldsTitle);
    if (mapping) {
      const list = document.createElement('div');
      list.className = 'fields-list';
      const checkboxes = [];
      for (const pair of mapping.fields) {
        const label = document.createElement('label');
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = pair.included;
        checkboxes.push({ chk, pair });
        const span = document.createElement('span');
        span.textContent =
          pair.sourceColumn +
          (pair.sourceColumn === pair.destinationColumn ? '' : ' → ' + pair.destinationColumn) +
          (pair.matchedBy === 'fuzzy' ? '  (fuzzy)' : '');
        label.appendChild(chk);
        label.appendChild(span);
        list.appendChild(label);
      }
      fieldsBox.appendChild(list);

      const actions = document.createElement('div');
      actions.className = 'detail-actions';
      const apply = document.createElement('button');
      apply.textContent = 'Apply Mapping Changes';
      apply.addEventListener('click', () => {
        post('updateMapping', {
          entryId: entry.id,
          fields: checkboxes.map(({ chk, pair }) => ({
            sourceColumn: pair.sourceColumn,
            destinationColumn: pair.destinationColumn,
            included: chk.checked,
          })),
        });
      });
      actions.appendChild(apply);
      if (!entry.mapping_complete) {
        const execAnyway = document.createElement('button');
        execAnyway.className = 'primary';
        execAnyway.textContent = 'Execute Anyway';
        execAnyway.addEventListener('click', () => post('executeOne', { id: entry.id }));
        actions.appendChild(execAnyway);
      }
      fieldsBox.appendChild(actions);
    } else {
      const p = document.createElement('div');
      p.textContent = 'Mapping details unavailable (mappings.json not loaded).';
      fieldsBox.appendChild(p);
    }
    grid.appendChild(fieldsBox);

    td.appendChild(grid);
    tr.appendChild(td);
    return tr;
  }

  function renderGrid() {
    const body = el('gridBody');
    body.innerHTML = '';
    el('emptyState').classList.toggle('hidden', Boolean(plan));
    renderEmptyState();
    renderWorkflowBanner();

    if (!plan) {
      updateButtons();
      return;
    }

    for (const entry of visibleEntries()) {
      const tr = document.createElement('tr');
      tr.className = 'data-row';
      if (selected.has(entry.id)) tr.classList.add('selected');

      const tdChk = document.createElement('td');
      tdChk.className = 'chk';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = selected.has(entry.id);
      chk.addEventListener('change', () => {
        if (chk.checked) selected.add(entry.id);
        else selected.delete(entry.id);
        tr.classList.toggle('selected', chk.checked);
        updateSelectionInfo();
        updateButtons();
      });
      tdChk.appendChild(chk);
      tr.appendChild(tdChk);

      const tdExpand = document.createElement('td');
      tdExpand.className = 'expand';
      tdExpand.textContent = expanded.has(entry.id) ? '▾' : '▸';
      tdExpand.style.cursor = 'pointer';
      tdExpand.addEventListener('click', () => {
        if (expanded.has(entry.id)) expanded.delete(entry.id);
        else expanded.add(entry.id);
        renderGrid();
      });
      tr.appendChild(tdExpand);

      const tdStatus = document.createElement('td');
      tdStatus.className = 'status-cell st-' + entry.status;
      const icon = STATUS_ICONS[entry.status] || '';
      tdStatus.innerHTML = '';
      const iconSpan = document.createElement('span');
      iconSpan.textContent = icon + ' ';
      if (entry.status === 'Running') iconSpan.classList.add('spin');
      tdStatus.appendChild(iconSpan);
      tdStatus.appendChild(document.createTextNode(entry.status));
      tr.appendChild(tdStatus);

      const tdMatch = document.createElement('td');
      tdMatch.className = entry.mapping_complete ? 'match-ok' : 'match-warn';
      tdMatch.textContent = entry.mapping_complete
        ? 'Complete'
        : entry.field_diff_count + ' diff(s)';
      tdMatch.title = entry.mapping_complete
        ? 'Table mapping matches comparison'
        : 'Schema differences — SQL may be incomplete';
      tr.appendChild(tdMatch);

      const cells = [
        [entry.table_src, ''],
        [entry.table_trgt, ''],
        [fmtNum(entry.rows), 'num'],
        [fmtNum(entry.executed_rows), 'num'],
        [fmtDuration(entry.duration_ms), 'num'],
        [String(entry.retry_count), 'num'],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        tr.appendChild(td);
      }

      const tdErr = document.createElement('td');
      tdErr.className = 'err-cell';
      tdErr.textContent = entry.error_message || '';
      tdErr.title = entry.error_message || '';
      tr.appendChild(tdErr);

      body.appendChild(tr);
      if (expanded.has(entry.id)) {
        body.appendChild(makeDetailRow(entry));
      }
    }
    updateSelectionInfo();
    updateButtons();
  }

  function updateSelectionInfo() {
    el('selectionInfo').textContent = selected.size ? selected.size + ' selected' : '';
  }

  function updateButtons() {
    const hasPlan = Boolean(plan && plan.entries.length);
    const running = runState.running;
    el('btnExecuteSelected').disabled = running || !selected.size;
    el('btnExecuteAll').disabled = running || !hasPlan;
    el('btnRetryFailed').disabled =
      running || !hasPlan || !plan.entries.some((e) => e.status === 'Failed');
    el('btnStop').disabled = !running;
    el('btnExport').disabled = !hasPlan;
    el('btnCreatePlan').disabled = running || !workflow.comparisonExists;
    el('btnCreatePlan').classList.toggle('hidden', Boolean(plan));
  }

  el('btnCreatePlan').addEventListener('click', () => post('createPlanFromComparison'));
  el('btnOpenCompare').addEventListener('click', () => post('openComparisonDashboard'));

  // ── Toolbar events ──────────────────────────────────────────────────────────

  el('btnExecuteSelected').addEventListener('click', () =>
    post('execute', { ids: Array.from(selected) })
  );
  el('btnExecuteAll').addEventListener('click', () => post('executeAll'));
  el('btnRetryFailed').addEventListener('click', () => post('retryFailed'));
  el('btnStop').addEventListener('click', () => post('stop'));
  el('btnExport').addEventListener('click', () => post('exportReport'));

  el('searchBox').addEventListener('input', (e) => {
    search = e.target.value;
    renderGrid();
  });
  el('statusFilter').addEventListener('change', (e) => {
    statusFilter = e.target.value;
    renderGrid();
  });
  el('chkAll').addEventListener('change', (e) => {
    if (e.target.checked) {
      for (const entry of visibleEntries()) selected.add(entry.id);
    } else {
      selected.clear();
    }
    renderGrid();
  });

  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (sortKey === key) {
        sortDir = -sortDir;
      } else {
        sortKey = key;
        sortDir = 1;
      }
      renderGrid();
    });
  }

  // ── Inbound messages ────────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
      case 'plan': {
        plan = message.data.plan;
        mappings = message.data.mappings || {};
        workflow = message.data.workflow || workflow;
        if (plan) {
          const ids = new Set(plan.entries.map((e) => e.id));
          selected = new Set(Array.from(selected).filter((id) => ids.has(id)));
          expanded = new Set(Array.from(expanded).filter((id) => ids.has(id)));
        } else {
          selected.clear();
          expanded.clear();
        }
        renderHeaderInfo();
        renderProgress();
        renderGrid();
        renderWorkflowBanner();
        break;
      }
      case 'runState':
        runState = message.data;
        renderProgress();
        updateButtons();
        break;
      default:
        break;
    }
  });

  post('ready');
})();
