(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    dialog: document.querySelector('.ssms-dialog'),
    form: document.getElementById('connectForm'),
    serverName: document.getElementById('serverName'),
    serverNameList: document.getElementById('serverNameList'),
    authMode: document.getElementById('authMode'),
    login: document.getElementById('login'),
    password: document.getElementById('password'),
    connectionName: document.getElementById('connectionName'),
    port: document.getElementById('port'),
    domain: document.getElementById('domain'),
    encryptPreset: document.getElementById('encryptPreset'),
    status: document.getElementById('statusMessage'),
    btnConnect: document.getElementById('btnConnect'),
    btnCancel: document.getElementById('btnCancel'),
    btnClose: document.getElementById('btnClose'),
    btnRefreshServers: document.getElementById('btnRefreshServers'),
  };

  const fieldControls = [
    el.connectionName,
    el.serverName,
    el.port,
    el.authMode,
    el.login,
    el.password,
    el.domain,
    el.encryptPreset,
    el.btnRefreshServers,
    el.btnConnect,
  ];

  let editing = false;
  /** True while connecting or while initial/refresh discovery is in progress. */
  let busy = true;
  let loaded = false;

  function setStatus(message, kind) {
    el.status.textContent = message || '';
    el.status.classList.remove('is-error', 'is-ok', 'is-busy');
    if (kind) {
      el.status.classList.add(`is-${kind}`);
    }
  }

  function setFieldsEnabled(enabled) {
    for (const control of fieldControls) {
      if (control) {
        control.disabled = !enabled;
      }
    }
  }

  function setBusy(next) {
    busy = next;
    setFieldsEnabled(!next && loaded);
  }

  function beginLoading(message) {
    loaded = false;
    busy = true;
    setFieldsEnabled(false);
    setStatus(message || 'Looking for SQL Server instances…', 'busy');
  }

  function finishLoading(statusMessage, kind) {
    loaded = true;
    busy = false;
    setFieldsEnabled(true);
    if (statusMessage) {
      setStatus(statusMessage, kind);
    }
  }

  function syncAuthUi() {
    const ntlm = el.authMode.value === 'ntlm';
    el.dialog.classList.toggle('auth-ntlm', ntlm);
    el.login.placeholder = ntlm ? 'DOMAIN\\user or user name' : 'SQL login (e.g. sa)';
  }

  function fillInstances(instances) {
    el.serverNameList.innerHTML = '';
    for (const item of instances || []) {
      const name = typeof item === 'string' ? item : item.name;
      if (!name) {
        continue;
      }
      const opt = document.createElement('option');
      opt.value = name;
      const source = typeof item === 'object' ? item.source : undefined;
      if (source) {
        opt.label = `${name} — ${source}`;
      }
      el.serverNameList.appendChild(opt);
    }
  }

  function encryptFromPreset(preset) {
    switch (preset) {
      case 'azure':
        return { encrypt: true, trustServerCertificate: false };
      case 'none':
        return { encrypt: false, trustServerCertificate: true };
      case 'onprem':
      default:
        return { encrypt: true, trustServerCertificate: true };
    }
  }

  function presetFromProfile(profile) {
    if (!profile) {
      return 'onprem';
    }
    if (!profile.encrypt) {
      return 'none';
    }
    return profile.trustServerCertificate ? 'onprem' : 'azure';
  }

  function applyInit(data) {
    editing = Boolean(data && data.existing);
    const existing = (data && data.existing) || null;

    if (existing) {
      el.connectionName.value = existing.name || '';
      el.serverName.value = existing.port
        ? `${String(existing.server).split('\\')[0]},${existing.port}`
        : existing.server || '';
      if (existing.port && String(existing.server).includes('\\')) {
        el.serverName.value = existing.server;
        el.port.value = String(existing.port);
      } else if (existing.port) {
        el.port.value = String(existing.port);
      } else {
        el.port.value = '';
      }
      el.authMode.value = existing.authMode === 'ntlm' ? 'ntlm' : 'sql';
      el.login.value = existing.username || '';
      el.domain.value = existing.domain || '';
      el.encryptPreset.value = presetFromProfile(existing);
      el.password.value = '';
      el.password.placeholder = 'Leave blank to keep stored password';
    } else {
      el.connectionName.value = '';
      el.serverName.value = '';
      el.login.value = '';
      el.password.value = '';
      el.password.placeholder = '';
      el.port.value = '';
      el.domain.value = '';
      el.authMode.value = 'sql';
      el.encryptPreset.value = 'onprem';
    }

    fillInstances((data && data.instances) || []);
    syncAuthUi();

    if (!el.serverName.value && data && data.instances && data.instances.length) {
      const first = data.instances[0];
      el.serverName.value = typeof first === 'string' ? first : first.name || '';
    }

    const count = (data && data.instances && data.instances.length) || 0;
    const statusMessage = existing
      ? 'Editing saved connection. Leave password blank to keep the stored one.'
      : count
        ? `Found ${count} server name${count === 1 ? '' : 's'}. You can still type a custom name.`
        : 'No instances found. Type the server name manually (host\\instance or host,port).';
    const kind = existing ? null : count ? 'ok' : null;
    finishLoading(statusMessage, kind);

    window.setTimeout(() => {
      if (!busy && loaded) {
        (existing ? el.password : el.serverName).focus();
      }
    }, 50);
  }

  function parseServerInput(raw) {
    let server = (raw || '').trim();
    let port;
    const comma = server.indexOf(',');
    if (comma >= 0) {
      const portPart = server.slice(comma + 1).trim();
      server = server.slice(0, comma).trim();
      if (portPart) {
        port = Number(portPart);
      }
    }
    const portField = (el.port.value || '').trim();
    if (portField) {
      port = Number(portField);
    }
    return { server, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined };
  }

  function collectPayload() {
    const { server, port } = parseServerInput(el.serverName.value);
    const security = encryptFromPreset(el.encryptPreset.value);
    const name = (el.connectionName.value || '').trim() || server || 'SQL Server';

    return {
      name,
      server,
      port,
      authMode: el.authMode.value === 'ntlm' ? 'ntlm' : 'sql',
      username: (el.login.value || '').trim(),
      domain: (el.domain.value || '').trim() || undefined,
      encrypt: security.encrypt,
      trustServerCertificate: security.trustServerCertificate,
      password: el.password.value,
    };
  }

  function validate(payload) {
    if (!payload.server) {
      return 'Server name is required.';
    }
    if (!payload.username) {
      return 'Login is required.';
    }
    if (!editing && !payload.password && payload.authMode === 'sql') {
      return 'Password is required for SQL Server Authentication.';
    }
    if (el.port.value.trim()) {
      const n = Number(el.port.value.trim());
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return 'TCP port must be between 1 and 65535.';
      }
    }
    return undefined;
  }

  function submitConnect() {
    if (busy || !loaded) {
      return;
    }
    const payload = collectPayload();
    const error = validate(payload);
    if (error) {
      setStatus(error, 'error');
      return;
    }
    setBusy(true);
    setStatus(`Connecting to ${payload.server}…`, 'busy');
    vscode.postMessage({ command: 'connect', data: payload });
  }

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitConnect();
  });

  el.btnConnect.addEventListener('click', submitConnect);
  el.btnCancel.addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
  el.btnClose.addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));

  el.btnRefreshServers.addEventListener('click', () => {
    if (busy || !loaded) {
      return;
    }
    beginLoading('Looking for SQL Server instances…');
    vscode.postMessage({ command: 'discoverInstances' });
  });

  el.authMode.addEventListener('change', syncAuthUi);

  el.serverName.addEventListener('change', () => {
    if (!el.connectionName.value.trim() && el.serverName.value.trim()) {
      el.connectionName.placeholder = el.serverName.value.trim();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.command) {
      case 'init':
        applyInit(msg.data || {});
        break;
      case 'instances':
        fillInstances((msg.data && msg.data.instances) || []);
        if (msg.data && msg.data.error) {
          finishLoading(msg.data.error, 'error');
        } else {
          const count = (msg.data && msg.data.instances && msg.data.instances.length) || 0;
          finishLoading(
            count
              ? `Found ${count} server name${count === 1 ? '' : 's'}. You can still type a custom name.`
              : 'No instances found. Type the server name manually (host\\instance or host,port).',
            count ? 'ok' : null
          );
        }
        break;
      case 'connectResult':
        setBusy(false);
        if (msg.data && msg.data.ok) {
          setStatus(msg.data.message || 'Connected and saved.', 'ok');
        } else {
          setStatus((msg.data && msg.data.message) || 'Connection failed.', 'error');
        }
        break;
      case 'status':
        // Host signals discovery start (e.g. edit reopen) — lock the form.
        if (msg.data && msg.data.kind === 'busy') {
          beginLoading(msg.data.message);
        } else {
          setStatus((msg.data && msg.data.message) || '', msg.data && msg.data.kind);
        }
        break;
      default:
        break;
    }
  });

  syncAuthUi();
  beginLoading('Looking for SQL Server instances…');
  vscode.postMessage({ command: 'ready' });
})();
