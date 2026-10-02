const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { unmatchedCsv } = require('../unmatched-csv');

function frontend(globals = {}) {
  const observers = new Set();
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(id === 'modal-overlay' ? ['hidden'] : []);
      const notify = () => queueMicrotask(() => [...observers].forEach(observer => observer.callback()));
      elements.set(id, {
        innerHTML: '', textContent: '', style: {}, focus() {}, addEventListener() {},
        classList: {
          contains: value => classes.has(value),
          add(value) { classes.add(value); notify(); },
          remove(value) { classes.delete(value); notify(); }
        }
      });
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    document: { getElementById: element }, navigator: { platform: 'Win32' },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    setTimeout() {}, clearTimeout() {}, escapeHtml: value => String(value),
    sourceBadge: () => '', ...globals
  });
  const load = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/scripts', name), 'utf8'), context);
  load('utils.js');
  return { context, element, load, run: code => vm.runInContext(code, context) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('CSV quotes Unicode, commas, double quotes and multiline filenames', () => {
  const csv = unmatchedCsv([{
    media_type: 'Movie', original_filename: 'Amélie, "test"\nPart 2.mkv',
    original_path: 'ssh:/movies/Amélie.mkv', search_title: 'Amélie', status: 'No match found'
  }]);
  assert.ok(csv.startsWith('\uFEFF"media_type"'));
  assert.ok(csv.includes('"Amélie, ""test""\nPart 2.mkv"'));
  assert.ok(csv.endsWith('\r\n'));
});

test('CSV neutralizes spreadsheet formulas in every exported field', () => {
  const csv = unmatchedCsv([{
    media_type: '=1+1', original_filename: '+cmd.mkv', original_path: '@path',
    search_title: '  -formula', status: '\tformula'
  }]);
  for (const value of ['=1+1', '+cmd.mkv', '@path', '  -formula', '\tformula']) {
    assert.ok(csv.includes('"\'' + value + '"'));
  }
});

test('export includes no-match items and audiobook fallbacks but excludes operation failures and pending items', () => {
  const file = (name, status, match) => ({ name, path: 'ssh:/movies/' + name, status, match, parsed: { title: name } });
  const app = frontend({
    Movies: { files: [file('missing.mkv', 'error'), file('operation-error.mkv', 'error', { id: 1 }), file('waiting.mkv', 'pending')] },
    TV: { files: [] }, Roms: { files: [] },
    Audiobooks: { books: [{ matched: true, noMetadataMatch: true, title: 'Book', files: [file('book.m4b', 'matched')] }] }
  });
  app.load('organize.js');
  const rows = app.run('Organize.unmatchedRows()');
  assert.deepEqual(Array.from(rows, row => row.original_filename), ['missing.mkv', 'book.m4b']);
  assert.match(rows[1].status, /fallback/);
});

test('movie selection prompts keep their results until dismissal, then open the next prompt', async () => {
  const app = frontend({ Organize: { _cancelMatch: false } });
  app.load('movies.js');
  app.run("Movies.files = [{name:'first.mkv'}, {name:'second.mkv'}]");
  const first = app.run("Movies._showSelectionDialog(0, [{title:'First'}], 'first')");
  const second = app.run("Movies._showSelectionDialog(1, [{title:'Second'}], 'second')");
  await settle();
  assert.equal(app.run('Movies._searchResults[0].title'), 'First');
  assert.match(app.element('modal-title').textContent, /first/);
  app.run('hideModal()');
  await first;
  await settle();
  assert.equal(app.run('Movies._searchResults[0].title'), 'Second');
  assert.match(app.element('modal-title').textContent, /second/);
  app.run('hideModal()');
  await second;
});

test('queued prompts are canceled when matching is stopped', async () => {
  const app = frontend({ Organize: { _cancelMatch: false } });
  const first = app.run("queueMatchPrompt(() => showModal('first',''))");
  const second = app.run("queueMatchPrompt(() => showModal('second',''))");
  await settle();
  app.run('Organize._cancelMatch = true; hideModal()');
  await Promise.all([first, second]);
  assert.equal(app.element('modal-title').textContent, 'first');
  assert.ok(app.element('modal-overlay').classList.contains('hidden'));
});

test('server paths retain POSIX separators on Windows and stop at server root', () => {
  const app = frontend();
  assert.equal(app.run("joinPath('ssh:/mnt/media', 'Film/Film.mkv')"), 'ssh:/mnt/media/Film/Film.mkv');
  assert.equal(app.run("pathUp('ssh:/mnt/media', 9)"), 'ssh:/');
});

test('remote browser ignores stale navigation responses', async () => {
  const pending = [];
  const app = frontend({ api: { browseSsh: directory => new Promise(resolve => pending.push({ directory, resolve })) } });
  app.load('remote-browser.js');
  app.run('RemoteBrowser.resolve = () => {}');
  const first = app.run("RemoteBrowser.navigate('ssh:/first')");
  const second = app.run("RemoteBrowser.navigate('ssh:/second')");
  pending[1].resolve({ entries: [] });
  await second;
  pending[0].resolve({ entries: [] });
  await first;
  assert.equal(app.run('RemoteBrowser.directory'), 'ssh:/second');
});
