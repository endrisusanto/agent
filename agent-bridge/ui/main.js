const { invoke } = window.__TAURI__ ? window.__TAURI__.core : { invoke: async () => ({}) };

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const deviceCount = document.getElementById('deviceCount');
const zipCount = document.getElementById('zipCount');
const pcIdInput = document.getElementById('pcId');
const hubUrlInput = document.getElementById('hubUrl');
const autoRootInput = document.getElementById('autoRoot');
const cucianDirInput = document.getElementById('cucianDir');
const logConsole = document.getElementById('logConsole');
const configForm = document.getElementById('configForm');
const btnBrowse = document.getElementById('btnBrowse');
const btnBrowseCucian = document.getElementById('btnBrowseCucian');
const btnClearLogs = document.getElementById('btnClearLogs');
const btnOpenHub = document.getElementById('btnOpenHub');

let isInitialLoad = true;

async function updateStatus() {
  try {
    const status = await invoke('get_bridge_status');
    if (status) {
      if (status.is_connected) {
        statusDot.className = 'status-indicator connected';
        statusText.innerText = 'Connected to Hub';
        statusText.style.color = '#3fb950';
      } else {
        statusDot.className = 'status-indicator';
        statusText.innerText = 'Disconnected (Reconnecting...)';
        statusText.style.color = '#f85149';
      }

      deviceCount.innerText = status.device_count || 0;
      zipCount.innerText = status.zip_count || 0;

      if (isInitialLoad) {
        pcIdInput.value = status.pc_id || '';
        hubUrlInput.value = status.hub_url || '';
        autoRootInput.value = status.auto_root || '';
        cucianDirInput.value = status.cucian_dir || '';
        isInitialLoad = false;
      }

      if (status.recent_logs && status.recent_logs.length > 0) {
        logConsole.innerText = status.recent_logs.join('\n');
        logConsole.scrollTop = logConsole.scrollHeight;
      }
    }
  } catch (err) {
    console.error('Failed to get status:', err);
  }
}

configForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await invoke('save_bridge_config', {
      pcId: pcIdInput.value.trim(),
      hubUrl: hubUrlInput.value.trim(),
      autoRoot: autoRootInput.value.trim(),
      cucianDir: cucianDirInput.value.trim(),
    });
    alert('Config saved. Reconnecting...');
  } catch (err) {
    alert('Failed to save config: ' + err);
  }
});

btnBrowse.addEventListener('click', async () => {
  try {
    const folder = await invoke('select_auto_folder');
    if (folder) {
      autoRootInput.value = folder;
    }
  } catch (err) {
    console.error('Browse error:', err);
  }
});

if (btnBrowseCucian) {
  btnBrowseCucian.addEventListener('click', async () => {
    try {
      const folder = await invoke('select_cucian_folder');
      if (folder) {
        cucianDirInput.value = folder;
      }
    } catch (err) {
      console.error('Browse Cucian error:', err);
    }
  });
}

btnClearLogs.addEventListener('click', async () => {
  try {
    await invoke('clear_bridge_logs');
    logConsole.innerText = '';
  } catch (err) {
    console.error(err);
  }
});

btnOpenHub.addEventListener('click', () => {
  if (hubUrlInput.value) {
    const url = hubUrlInput.value.replace('ws://', 'http://').replace('wss://', 'https://').replace('/ws/bridge', '');
    window.open(url, '_blank');
  }
});

setInterval(updateStatus, 1500);
updateStatus();
