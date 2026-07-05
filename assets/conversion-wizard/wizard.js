(function () {
  const vscode = acquireVsCodeApi();

  const inputStandard = document.getElementById('inputStandard');
  const inputCustomized = document.getElementById('inputCustomized');
  const outputFile = document.getElementById('outputFile');
  const statusEl = document.getElementById('status');
  const convertBtn = document.getElementById('convertBtn');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');

  const tabConversion = document.getElementById('tab-conversion');
  const tabSettings = document.getElementById('tab-settings');
  const panelConversion = document.getElementById('panel-conversion');
  const panelSettings = document.getElementById('panel-settings');

  const SETTING_FIELDS = [
    'type',
    'extensionStartId',
    'objectFileNamePattern',
    'extensionObjectFileNamePattern',
    'injectDotNetAddIns',
    'dotNetAddInsPackage',
    'dotNetTypePrefix',
    'addLegacyTranslationInfo',
    'runtime',
    'dataClassificationDefaulting',
    'tableDataOnly',
    'verboseLogging',
    'txt2alPath',
    'logFilePath',
    'objectMappingPath',
  ];

  function isTxtFile(path) {
    return /\.txt$/i.test((path || '').trim());
  }

  function isFormValid() {
    const baseline = inputStandard.value.trim();
    const customized = inputCustomized.value.trim();
    const output = outputFile.value.trim();
    return (
      baseline.length > 0 &&
      customized.length > 0 &&
      output.length > 0 &&
      isTxtFile(baseline) &&
      isTxtFile(customized)
    );
  }

  function updateConvertButton() {
    convertBtn.disabled = !isFormValid();
  }

  function setStatus(level, text) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (level ? ' ' + level : '');
  }

  function setConverting(active) {
    convertBtn.disabled = active || !isFormValid();
    document.getElementById('viewLogBtn').disabled = active;
    saveSettingsBtn.disabled = active;
    document.querySelectorAll('[data-browse]').forEach(function (btn) {
      btn.disabled = active;
    });
  }

  function activateTab(name) {
    const isConversion = name === 'conversion';
    tabConversion.classList.toggle('active', isConversion);
    tabSettings.classList.toggle('active', !isConversion);
    tabConversion.setAttribute('aria-selected', isConversion ? 'true' : 'false');
    tabSettings.setAttribute('aria-selected', isConversion ? 'false' : 'true');
    panelConversion.classList.toggle('active', isConversion);
    panelSettings.classList.toggle('active', !isConversion);
    panelConversion.hidden = !isConversion;
    panelSettings.hidden = isConversion;
  }

  function applySettings(settings) {
    if (!settings) {
      return;
    }

    SETTING_FIELDS.forEach(function (key) {
      const el = document.querySelector('[data-setting="' + key + '"]');
      if (!el || settings[key] === undefined) {
        return;
      }
      if (el.type === 'checkbox') {
        el.checked = !!settings[key];
      } else {
        el.value = settings[key];
      }
    });
  }

  function collectSettings() {
    const settings = {};
    SETTING_FIELDS.forEach(function (key) {
      const el = document.querySelector('[data-setting="' + key + '"]');
      if (!el) {
        return;
      }
      if (el.type === 'checkbox') {
        settings[key] = el.checked;
      } else if (el.type === 'number') {
        settings[key] = Number(el.value) || 0;
      } else {
        settings[key] = el.value.trim();
      }
    });
    return settings;
  }

  function validateBeforeConvert() {
    const baseline = inputStandard.value.trim();
    const customized = inputCustomized.value.trim();
    const output = outputFile.value.trim();

    if (!baseline) {
      setStatus('error', 'Standard NAV objects export (.txt) is required.');
      inputStandard.focus();
      return false;
    }
    if (!customized) {
      setStatus('error', 'Customized NAV objects export (.txt) is required.');
      inputCustomized.focus();
      return false;
    }
    if (!output) {
      setStatus('error', 'Output folder is required.');
      outputFile.focus();
      return false;
    }
    if (!isTxtFile(baseline)) {
      setStatus('error', 'Standard objects export must be a .txt file.');
      inputStandard.focus();
      return false;
    }
    if (!isTxtFile(customized)) {
      setStatus('error', 'Customized objects export must be a .txt file.');
      inputCustomized.focus();
      return false;
    }
    return true;
  }

  tabConversion.addEventListener('click', function () {
    activateTab('conversion');
  });

  tabSettings.addEventListener('click', function () {
    activateTab('settings');
  });

  [inputStandard, inputCustomized, outputFile].forEach(function (el) {
    el.addEventListener('input', function () {
      updateConvertButton();
      if (statusEl.classList.contains('error')) {
        setStatus('', '');
      }
    });
  });

  convertBtn.addEventListener('click', function () {
    if (!validateBeforeConvert()) {
      return;
    }
    vscode.postMessage({
      command: 'convert',
      data: {
        inputStandard: inputStandard.value.trim(),
        inputCustomized: inputCustomized.value.trim(),
        outputFile: outputFile.value.trim(),
      },
    });
  });

  saveSettingsBtn.addEventListener('click', function () {
    vscode.postMessage({
      command: 'saveSettings',
      data: collectSettings(),
    });
  });

  document.getElementById('viewLogBtn').addEventListener('click', function () {
    vscode.postMessage({ command: 'viewLog' });
  });

  document.getElementById('closeBtn').addEventListener('click', function () {
    vscode.postMessage({ command: 'close' });
  });

  document.querySelectorAll('[data-browse]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      vscode.postMessage({
        command: 'browse',
        data: { field: btn.getAttribute('data-browse') },
      });
    });
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || !message.command) {
      return;
    }

    switch (message.command) {
      case 'init': {
        const data = message.data || {};
        if (data.defaultOutput && !outputFile.value.trim()) {
          outputFile.value = data.defaultOutput;
        }
        if (data.workspaceRoot) {
          setStatus('info', 'Workspace: ' + data.workspaceRoot);
        }
        applySettings(data.settings);
        updateConvertButton();
        break;
      }
      case 'status': {
        const data = message.data || {};
        setStatus(data.level || 'info', data.text || '');
        break;
      }
      case 'converting': {
        setConverting(!!(message.data && message.data.active));
        break;
      }
      case 'settingsSaved': {
        setStatus('success', 'Settings saved.');
        break;
      }
      case 'pathSelected': {
        const data = message.data || {};
        const field = data.field;
        const path = data.path || '';
        if (field === 'inputStandard') inputStandard.value = path;
        else if (field === 'inputCustomized') inputCustomized.value = path;
        else if (field === 'outputFile') outputFile.value = path;
        else {
          const settingEl = document.querySelector('[data-setting="' + field + '"]');
          if (settingEl) {
            settingEl.value = path;
          }
        }
        updateConvertButton();
        break;
      }
      default:
        break;
    }
  });

  updateConvertButton();
  vscode.postMessage({ command: 'ready' });
})();
