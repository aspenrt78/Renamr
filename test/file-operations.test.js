const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createLocalLink,
  undoLocalLink,
  mapLocalToRemote,
  shellQuote,
  createSshHardLink,
  undoSshHardLink,
  testSshConnection,
  parseRemoteEntries,
  listRemoteDirectory
} = require('../file-operations');

async function withTempDir(callback) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'renamr-test-'));
  try {
    await callback(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

test('creates and safely removes a hard link without changing the source', async () => {
  await withTempDir(async directory => {
    const source = path.join(directory, 'torrent', 'original.mkv');
    const target = path.join(directory, 'library', 'Movie (2026).mkv');
    await fs.promises.mkdir(path.dirname(source), { recursive: true });
    await fs.promises.writeFile(source, 'movie-data');

    const operation = await createLocalLink(source, target, 'hardlink');
    const [sourceStat, targetStat] = await Promise.all([fs.promises.stat(source), fs.promises.stat(target)]);
    assert.equal(operation.linkType, 'hardlink');
    assert.equal(sourceStat.ino, targetStat.ino);
    assert.equal(await fs.promises.readFile(target, 'utf8'), 'movie-data');

    await undoLocalLink(operation);
    assert.equal(await fs.promises.readFile(source, 'utf8'), 'movie-data');
    await assert.rejects(fs.promises.lstat(target), { code: 'ENOENT' });
  });
});

test('creates and safely removes a symbolic link', async t => {
  await withTempDir(async directory => {
    const source = path.join(directory, 'original.mkv');
    const target = path.join(directory, 'library', 'Movie.mkv');
    await fs.promises.writeFile(source, 'movie-data');

    let operation;
    try {
      operation = await createLocalLink(source, target, 'symlink');
    } catch (err) {
      if (process.platform === 'win32' && /Developer Mode/.test(err.message)) {
        t.skip('Windows symbolic-link privilege is not enabled');
        return;
      }
      throw err;
    }
    assert.equal((await fs.promises.lstat(target)).isSymbolicLink(), true);
    await undoLocalLink(operation);
    assert.equal(await fs.promises.readFile(source, 'utf8'), 'movie-data');
  });
});

test('does not overwrite an existing target', async () => {
  await withTempDir(async directory => {
    const source = path.join(directory, 'source.mkv');
    const target = path.join(directory, 'target.mkv');
    await fs.promises.writeFile(source, 'source');
    await fs.promises.writeFile(target, 'keep-me');
    await assert.rejects(createLocalLink(source, target, 'hardlink'), /already exists/);
    assert.equal(await fs.promises.readFile(target, 'utf8'), 'keep-me');
  });
});

test('maps a Windows virtual-drive path to a TrueNAS path', () => {
  assert.equal(
    mapLocalToRemote('R:\\Movies\\Alien (1979)\\Alien.mkv', 'R:\\Movies', '/mnt/tank/media/Movies'),
    '/mnt/tank/media/Movies/Alien (1979)/Alien.mkv'
  );
  assert.throws(
    () => mapLocalToRemote('R:\\Downloads\\Alien.mkv', 'R:\\Movies', '/mnt/tank/media/Movies'),
    /outside the configured local root/
  );
});

test('undo refuses a destination replaced with an unrelated file', async () => {
  await withTempDir(async directory => {
    const source = path.join(directory, 'source.txt');
    const target = path.join(directory, 'target.txt');
    await fs.promises.writeFile(source, 'original');
    const operation = await createLocalLink(source, target, 'hardlink');
    await fs.promises.unlink(target);
    await fs.promises.writeFile(target, 'replacement');
    await assert.rejects(undoLocalLink(operation), /no longer the hard link/);
    assert.equal(await fs.promises.readFile(source, 'utf8'), 'original');
    assert.equal(await fs.promises.readFile(target, 'utf8'), 'replacement');
  });
});

test('SSH rejects option-like hosts and relative server roots before connecting', async () => {
  let invoked = false;
  const runner = async () => { invoked = true; return { stdout: '' }; };
  await assert.rejects(testSshConnection({ host: '-V', localRoot: 'R:\\Movies', remoteRoot: '/mnt/media' }, runner), /unsupported characters/);
  assert.throws(() => mapLocalToRemote('R:\\Movies\\a.mkv', 'R:\\Movies', 'relative'), /absolute POSIX/);
  assert.equal(invoked, false);
});

test('SSH undo refuses history that would remove the source itself', async () => {
  await assert.rejects(undoSshHardLink({ remoteSource: '/mnt/media/a', remoteTarget: '/mnt/media/a' }, {}), /must be distinct/);
});

test('quotes apostrophes for the remote shell', () => {
  assert.equal(shellQuote("Bob's Movie.mkv"), `'Bob'"'"'s Movie.mkv'`);
});

test('builds SSH hard-link and undo commands without executing a real connection', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    return { stdout: '', stderr: '' };
  };
  const config = { host: 'media@truenas', port: 22, localRoot: 'R:\\Movies', remoteRoot: '/mnt/tank/Movies' };
  const operation = await createSshHardLink(
    'R:\\Movies\\Torrent\\Movie.mkv',
    'R:\\Movies\\Library\\Movie (2026).mkv',
    config,
    runner
  );
  await undoSshHardLink(operation, config, runner);

  assert.equal(operation.operation, 'ssh-link');
  assert.match(calls[0].args.at(-1), /mkdir -p/);
  assert.match(calls[0].args.at(-1), /ln -T --/);
  assert.match(calls[1].args.at(-1), /test .* -ef .* && rm --/);
});

test('SSH connection test verifies the configured remote root and ln command', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    return { stdout: 'Renamr-SSH-OK', stderr: '' };
  };
  const config = { host: 'media@truenas', port: 22, localRoot: 'R:\\Movies', remoteRoot: '/mnt/tank/Movies' };
  assert.equal(await testSshConnection(config, runner), true);
  assert.match(calls[0].args.at(-1), /test -d/);
  assert.match(calls[0].args.at(-1), /command -v find/);
  assert.match(calls[0].args.at(-1), /command -v ln/);
});

test('direct SSH sources and destinations do not require mounted-drive mappings', async () => {
  const calls = [];
  const config = { host: 'user@server' };
  const runner = async (command, args) => { calls.push(args.at(-1)); return { stdout: 'Renamr-SSH-OK' }; };
  assert.equal(await testSshConnection(config, runner), true);
  const result = await createSshHardLink('ssh:/downloads/Movie.mkv', 'ssh:/library/Movie (2026).mkv', config, runner);
  assert.equal(result.remoteSource, '/downloads/Movie.mkv');
  assert.equal(result.remoteTarget, '/library/Movie (2026).mkv');
  assert.match(calls[1], /ln -T/);
});

test('server listings preserve filenames with whitespace, quotes and newlines', async () => {
  const name = "/downloads/Bob's Movie\nPart 1.mkv";
  const listing = ['f', name, '123', '1700000000', 'd', '/downloads/Season 1', '4096', '1700000000', ''].join('\0');
  const entries = parseRemoteEntries(listing);
  assert.equal(entries[0].name, "Bob's Movie\nPart 1.mkv");
  assert.equal(entries[0].path, 'ssh:' + name);
  assert.equal(entries[1].isDirectory, true);
  await assert.rejects(listRemoteDirectory('C:\\local', { host: 'server' }), /Choose a folder/);
  assert.throws(() => parseRemoteEntries('f\0unfinished'), /Incomplete/);
});
