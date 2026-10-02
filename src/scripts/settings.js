// ═══════════════════════════════════════════════════════════════════
// Settings Module — TMDB + OMDb keys
// ═══════════════════════════════════════════════════════════════════

const Settings = {
  operationMode: 'move',

  _operationMeta: {
    move: { button: 'Rename & Move', done: 'Moved', status: 'done', help: 'Renames or moves files using the existing behavior.' },
    hardlink: { button: 'Create Hard Links', done: 'Linked', status: 'linked', help: 'Uses no duplicate file data, but source and output must be on the same filesystem.' },
    symlink: { button: 'Create Symbolic Links', done: 'Linked', status: 'linked', help: 'Can cross filesystems. Windows may require Developer Mode or administrator privileges.' },
    'ssh-hardlink': { button: 'Create SSH Links', done: 'Linked', status: 'linked', help: 'Creates hard links directly on TrueNAS over SSH without transferring movie data.' }
  },

  completedVerb() { return (this._operationMeta[this.operationMode] || this._operationMeta.move).done; },
  doneLabel() { return (this._operationMeta[this.operationMode] || this._operationMeta.move).status; },

  async init() {
    const tmdbKey = await api.getStore('tmdbApiKey') || '';
    const omdbKey = await api.getStore('omdbApiKey') || '';
    const outputDir = await api.getStore('outputDirectory') || '';
    this.operationMode = await api.getStore('fileOperationMode') || 'move';
    const operationEl = document.getElementById('settings-operation-mode');
    if (operationEl) operationEl.value = this.operationMode;
    this.applyOperationModeUI();

    const sshFields = {
      'settings-ssh-host': ['sshHost', ''],
      'settings-ssh-port': ['sshPort', 22],
      'settings-ssh-identity': ['sshIdentityFile', ''],
      'settings-ssh-local-root': ['sshLocalRoot', ''],
      'settings-ssh-remote-root': ['sshRemoteRoot', '']
    };
    for (const [id, [key, fallback]] of Object.entries(sshFields)) {
      const el = document.getElementById(id);
      if (el) el.value = await api.getStore(key) || fallback;
    }

    if (tmdbKey) {
      document.getElementById('settings-tmdb-key').value = tmdbKey;
      document.getElementById('tmdb-key-status').textContent = '✓ API key saved';
      document.getElementById('tmdb-key-status').className = 'key-status valid';
    }

    if (omdbKey) {
      document.getElementById('settings-omdb-key').value = omdbKey;
      document.getElementById('omdb-key-status').textContent = '✓ API key saved';
      document.getElementById('omdb-key-status').className = 'key-status valid';
    }

    const igdbClientId = await api.getStore('igdbClientId') || '';
    const igdbSecret   = await api.getStore('igdbClientSecret') || '';
    if (igdbClientId) {
      document.getElementById('settings-igdb-client-id').value = igdbClientId;
    }
    if (igdbSecret) {
      document.getElementById('settings-igdb-client-secret').value = igdbSecret;
      document.getElementById('igdb-key-status').textContent = '✓ Credentials saved';
      document.getElementById('igdb-key-status').className = 'key-status valid';
    }

    if (outputDir) {
      document.getElementById('settings-output-dir').value = outputDir;
    }

    const typeDirs = { movie: 'movieOutputDirectory', tv: 'tvOutputDirectory', audiobook: 'audiobookOutputDirectory', rom: 'romOutputDirectory' };
    for (const [type, key] of Object.entries(typeDirs)) {
      const dir = await api.getStore(key) || '';
      const el = document.getElementById(`settings-${type}-output-dir`);
      if (el && dir) el.value = dir;
    }

    const articleTypes = ['movie', 'tv', 'audiobook', 'rom'];
    for (const t of articleTypes) {
      const folderVal = await api.getStore(`${t}ArticleFolder`) || false;
      const fileVal = await api.getStore(`${t}ArticleFile`) || false;
      const folderEl = document.getElementById(`settings-article-${t}-folder`);
      const fileEl = document.getElementById(`settings-article-${t}-file`);
      if (folderEl) folderEl.checked = folderVal;
      if (fileEl) fileEl.checked = fileVal;
    }

    const esDeEl = document.getElementById('settings-rom-esde');
    if (esDeEl) esDeEl.checked = await api.getStore('romEsDeNames') || false;
  },

  applyOperationModeUI() {
    const meta = this._operationMeta[this.operationMode] || this._operationMeta.move;
    const label = document.getElementById('organize-operation-label');
    const help = document.getElementById('settings-operation-help');
    const sshCard = document.getElementById('settings-ssh-card');
    if (label) label.textContent = meta.button;
    if (help) help.textContent = meta.help;
    if (sshCard) sshCard.style.display = this.operationMode === 'ssh-hardlink' ? '' : 'none';
  },

  async saveFileOperationMode() {
    this.operationMode = document.getElementById('settings-operation-mode')?.value || 'move';
    await api.setStore('fileOperationMode', this.operationMode);
    this.applyOperationModeUI();
    showToast(`File operation set to ${(this._operationMeta[this.operationMode] || this._operationMeta.move).button}`, 'success');
  },

  async selectSshIdentity() {
    const files = await api.openFiles([{ name: 'SSH private key', extensions: ['pem', 'key', 'ppk', '*'] }]);
    if (files?.[0]) document.getElementById('settings-ssh-identity').value = files[0];
  },

  clearSshIdentity() {
    document.getElementById('settings-ssh-identity').value = '';
  },

  async selectSshLocalRoot() {
    const directory = await api.openDirectory();
    if (directory) document.getElementById('settings-ssh-local-root').value = directory;
  },

  async saveSshSettings(showConfirmation = true) {
    const values = {
      sshHost: document.getElementById('settings-ssh-host').value.trim(),
      sshPort: Number(document.getElementById('settings-ssh-port').value) || 22,
      sshIdentityFile: document.getElementById('settings-ssh-identity').value.trim(),
      sshLocalRoot: document.getElementById('settings-ssh-local-root').value.trim(),
      sshRemoteRoot: document.getElementById('settings-ssh-remote-root').value.trim()
    };
    for (const [key, value] of Object.entries(values)) await api.setStore(key, value);
    if (showConfirmation) showToast('SSH settings saved', 'success');
  },

  async testSshConnection() {
    const status = document.getElementById('ssh-connection-status');
    await this.saveSshSettings(false);
    status.textContent = 'Testing read-only SSH connection...';
    status.className = 'key-status';
    const result = await api.testSsh();
    status.textContent = result.success ? '✓ SSH connection succeeded' : `✗ ${result.error || 'SSH connection failed'}`;
    status.className = `key-status ${result.success ? 'valid' : 'invalid'}`;
  },

  async saveApiKey(provider) {
    if (provider === 'tmdb') {
      const key = document.getElementById('settings-tmdb-key').value.trim();
      if (!key) { showToast('Please enter an API key', 'error'); return; }

      const statusEl = document.getElementById('tmdb-key-status');
      statusEl.textContent = 'Testing...';
      statusEl.className = 'key-status';

      try {
        const results = await api.tmdbSearch('inception', 'movie', key);
        if (results.error) {
          statusEl.textContent = '✗ Invalid API key';
          statusEl.className = 'key-status invalid';
          return;
        }
        await api.setStore('tmdbApiKey', key);
        statusEl.textContent = '✓ Verified and saved';
        statusEl.className = 'key-status valid';
        showToast('TMDB API key saved', 'success');
      } catch (err) {
        statusEl.textContent = '✗ Could not verify';
        statusEl.className = 'key-status invalid';
      }
    } else if (provider === 'omdb') {
      const key = document.getElementById('settings-omdb-key').value.trim();
      if (!key) { showToast('Please enter an API key', 'error'); return; }

      const statusEl = document.getElementById('omdb-key-status');
      statusEl.textContent = 'Testing...';
      statusEl.className = 'key-status';

      try {
        const results = await api.omdbSearch('inception', 'movie', key);
        if (!results || results.length === 0) {
          statusEl.textContent = '✗ Invalid API key or no results';
          statusEl.className = 'key-status invalid';
          return;
        }
        await api.setStore('omdbApiKey', key);
        statusEl.textContent = '✓ Verified and saved';
        statusEl.className = 'key-status valid';
        showToast('OMDb API key saved', 'success');
      } catch (err) {
        statusEl.textContent = '✗ Could not verify';
        statusEl.className = 'key-status invalid';
      }
    } else if (provider === 'igdb') {
      const clientId = document.getElementById('settings-igdb-client-id').value.trim();
      const secret   = document.getElementById('settings-igdb-client-secret').value.trim();
      if (!clientId || !secret) { showToast('Enter both Client ID and Client Secret', 'error'); return; }

      const statusEl = document.getElementById('igdb-key-status');
      statusEl.textContent = 'Testing...';
      statusEl.className = 'key-status';

      try {
        const result = await api.igdbTestCredentials(clientId, secret);
        if (!result.success) {
          statusEl.textContent = `✗ ${result.error || 'Invalid credentials'}`;
          statusEl.className = 'key-status invalid';
          return;
        }
        statusEl.textContent = '✓ Verified and saved';
        statusEl.className = 'key-status valid';
        showToast('IGDB credentials saved', 'success');
      } catch (err) {
        statusEl.textContent = '✗ Could not verify';
        statusEl.className = 'key-status invalid';
      }
    }
  },

  toggleKeyVisibility(provider) {
    const idMap = {
      'tmdb': 'settings-tmdb-key',
      'omdb': 'settings-omdb-key',
      'igdb-id': 'settings-igdb-client-id',
      'igdb-secret': 'settings-igdb-client-secret'
    };
    const id = idMap[provider] || 'settings-tmdb-key';
    const input = document.getElementById(id);
    const btn = input.nextElementSibling;
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      btn.textContent = 'Show';
    }
  },

  _outputDirMeta: {
    movie:     { key: 'movieOutputDirectory',     elId: 'settings-movie-output-dir',     label: 'Movies' },
    tv:        { key: 'tvOutputDirectory',         elId: 'settings-tv-output-dir',         label: 'TV Shows' },
    audiobook: { key: 'audiobookOutputDirectory',  elId: 'settings-audiobook-output-dir',  label: 'Audiobooks' },
    rom:       { key: 'romOutputDirectory',        elId: 'settings-rom-output-dir',        label: 'ROMs' },
    global:    { key: 'outputDirectory',           elId: 'settings-output-dir',            label: 'Global fallback' },
  },

  async selectOutputDir(type = 'global') {
    const { key, elId, label } = this._outputDirMeta[type] || this._outputDirMeta.global;
    const dir = await api.openDirectory();
    if (dir) {
      document.getElementById(elId).value = dir;
      await api.setStore(key, dir);
      showToast(`${label} output directory set`, 'success');
    }
  },

  async clearOutputDir(type = 'global') {
    const { key, elId, label } = this._outputDirMeta[type] || this._outputDirMeta.global;
    document.getElementById(elId).value = '';
    await api.setStore(key, '');
    showToast(`${label} output directory cleared`, 'info');
  },

  async saveRomEsDeNames() {
    const checked = document.getElementById('settings-rom-esde')?.checked || false;
    await api.setStore('romEsDeNames', checked);
    if (typeof Roms !== 'undefined') Roms.reapplyFormat();
    showToast(checked ? 'ES-DE system names enabled' : 'Standard system names restored', 'info');
  },

  async saveArticleSuffix(type) {
    const folder = document.getElementById(`settings-article-${type}-folder`)?.checked || false;
    const file = document.getElementById(`settings-article-${type}-file`)?.checked || false;
    await api.setStore(`${type}ArticleFolder`, folder);
    await api.setStore(`${type}ArticleFile`, file);
    // Reapply formats to all matched files
    if (type === 'movie' && typeof Movies !== 'undefined') Movies.reapplyFormat();
    if (type === 'tv' && typeof TV !== 'undefined') TV.reapplyFormat();
    if (type === 'audiobook' && typeof Audiobooks !== 'undefined') Audiobooks.reapplyFormat();
    if (type === 'rom' && typeof Roms !== 'undefined') Roms.reapplyFormat();
  }
};
