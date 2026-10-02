// Select files and folders directly on the configured SSH server.
const RemoteBrowser = {
  directory: 'ssh:/', entries: [], selected: new Set(), resolve: null, observer: null,
  async choose(kind = 'directory') {
    if (this.resolve) this.finish(null);
    this.kind = kind;
    this.selected.clear();
    const result = new Promise(resolve => { this.resolve = resolve; });
    showModal(kind === 'files' ? 'Choose Server Files' : 'Choose Server Folder', 'Loading server folders...');
    this.observer = new MutationObserver(() => {
      if (document.getElementById('modal-overlay').classList.contains('hidden')) this.finish(null);
    });
    this.observer.observe(document.getElementById('modal-overlay'), { attributes: true, attributeFilter: ['class'] });
    await this.navigate(this.directory);
    return result;
  },
  async navigate(directory) {
    const generation = this.resolve;
    const request = this.request = (this.request || 0) + 1;
    const result = await api.browseSsh(directory);
    if (!generation || generation !== this.resolve || request !== this.request) return;
    if (result.error) { this.entries = []; this.selected.clear(); this.render(result.error); return; }
    this.directory = directory;
    this.entries = result.entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
    this.selected.clear();
    this.render();
  },
  render(error = '') {
    const esc = escapeHtml;
    document.getElementById('modal-body').innerHTML = `
      <p class="setting-desc">Choose a folder on the SSH server.</p>
      <div class="input-row"><button class="btn btn-secondary" onclick="RemoteBrowser.up()">Up</button><input class="input" id="remote-browser-path" value="${esc(this.directory.slice(4))}" /><button class="btn btn-secondary" onclick="RemoteBrowser.go()">Go</button></div>
      ${error ? `<p style="color:var(--error);margin-top:12px;">${esc(error)}</p>` : ''}
      <div style="max-height:320px;overflow:auto;margin:12px 0;">
      ${this.entries.map((entry, index) => entry.isDirectory
        ? `<div style="padding:5px 0;"><button class="btn btn-secondary" onclick="RemoteBrowser.open(${index})">Folder: ${esc(entry.name)}</button></div>`
        : this.kind === 'files' ? `<label style="display:block;padding:5px 0;"><input type="checkbox" onchange="RemoteBrowser.toggle(${index},this.checked)" /> ${esc(entry.name)}</label>` : '').join('')}
      ${!this.entries.length && !error ? '<p class="setting-desc">This folder is empty.</p>' : ''}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn btn-secondary" onclick="RemoteBrowser.finish(null)">Cancel</button><button class="btn btn-primary" ${error ? 'disabled' : ''} onclick="RemoteBrowser.select()">${this.kind === 'files' ? 'Add Selected Files' : 'Use This Folder'}</button></div>`;
  },
  open(index) { return this.navigate(this.entries[index].path); },
  up() { return this.navigate(pathDirname(this.directory) || 'ssh:/'); },
  go() {
    const value = document.getElementById('remote-browser-path').value.trim();
    if (!value.startsWith('/')) { showToast('Enter an absolute server folder path', 'error'); return; }
    return this.navigate('ssh:' + value);
  },
  toggle(index, checked) { if (checked) this.selected.add(index); else this.selected.delete(index); },
  select() { this.finish(this.kind === 'files' ? [...this.selected].map(index => this.entries[index].path) : this.directory); },
  finish(value) {
    const resolve = this.resolve;
    this.resolve = null;
    this.observer?.disconnect();
    this.observer = null;
    hideModal();
    resolve?.(value);
  }
};
