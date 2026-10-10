const DEFAULTS = { minDelay: 4, maxDelay: 9, batchSize: 25, batchPause: 120, dailyCap: 150 };
const FIELDS = Object.keys(DEFAULTS);
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

function show(msg) { statusEl.textContent = msg; }

function renderLogs(logs) {
  logEl.innerHTML = '';
  (logs || []).forEach((line) => {
    const div = document.createElement('div');
    const level = (line.split(' ')[1] || '').toUpperCase();
    div.className = level;
    div.textContent = line;
    logEl.appendChild(div);
  });
  logEl.scrollTop = logEl.scrollHeight;
}

async function popupLog(level, msg) {
  console[level === 'ERROR' ? 'error' : 'log']('[TikTok Unfollower popup]', msg);
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.push(`${new Date().toLocaleTimeString()} ${level} (popup) ${msg}`);
  await chrome.storage.local.set({ logs: logs.slice(-100) });
}

async function loadAll() {
  const { settings, status, logs } = await chrome.storage.local.get(['settings', 'status', 'logs']);
  const s = { ...DEFAULTS, ...(settings || {}) };
  FIELDS.forEach((k) => (document.getElementById(k).value = s[k]));
  if (status && status.text) show(status.text);
  renderLogs(logs);
}

function readSettings() {
  const s = {};
  FIELDS.forEach((k) => (s[k] = Math.max(1, Number(document.getElementById(k).value) || DEFAULTS[k])));
  if (s.minDelay < 2) s.minDelay = 2;
  if (s.maxDelay < s.minDelay) s.maxDelay = s.minDelay + 2;
  return s;
}

async function getTikTokTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(tab.url)) {
    show('Open tiktok.com in this tab first.');
    await popupLog('ERROR', 'Active tab is not TikTok: ' + (tab && tab.url));
    return null;
  }
  return tab;
}

// Makes sure the content script is running in the tab (injects it if the tab was open before install)
async function ensureInjected(tab) {
  try {
    await chrome.tabs.sendMessage(tab.id, { cmd: 'ping' });
    return true;
  } catch (e) {
    await popupLog('WARN', 'Content script not answering, injecting it now...');
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise((r) => setTimeout(r, 400));
      await chrome.tabs.sendMessage(tab.id, { cmd: 'ping' });
      await popupLog('INFO', 'Content script injected');
      return true;
    } catch (err) {
      show('Could not connect to the page. Refresh the TikTok tab and try again.');
      await popupLog('ERROR', 'Injection failed: ' + err.message);
      return false;
    }
  }
}

async function send(cmd) {
  const tab = await getTikTokTab();
  if (!tab || !(await ensureInjected(tab))) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { cmd });
  } catch (e) {
    await popupLog('ERROR', `Sending "${cmd}" failed: ${e.message}`);
    show('Could not reach the page. Refresh the TikTok tab.');
    return null;
  }
}

document.getElementById('start').addEventListener('click', async () => {
  await chrome.storage.local.set({ settings: readSettings() });
  show('Starting...');
  await popupLog('INFO', 'Start pressed');
  await send('start');
});

document.getElementById('stop').addEventListener('click', async () => {
  show('Stopping...');
  await send('stop');
});

document.getElementById('diagnose').addEventListener('click', async () => {
  const d = await send('diagnose');
  if (d) show('Diagnose done, see log.');
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ logs: [] });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.status && changes.status.newValue) show(changes.status.newValue.text);
  if (changes.logs) renderLogs(changes.logs.newValue);
});

loadAll();
