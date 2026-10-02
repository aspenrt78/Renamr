const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function normalizeForComparison(filePath) {
  const normalized = path.resolve(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function targetExists(targetPath) {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function createLocalLink(source, target, mode) {
  if (!['hardlink', 'symlink'].includes(mode)) throw new Error(`Unsupported link mode: ${mode}`);

  const sourcePath = path.normalize(source);
  const targetPath = path.normalize(target);
  if (normalizeForComparison(sourcePath) === normalizeForComparison(targetPath)) {
    return { source, target: targetPath, success: true, operation: 'noop' };
  }

  const sourceStat = await fs.promises.stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error('Source is not a file');

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o777 });
  if (await targetExists(targetPath)) throw new Error('Target file already exists');

  try {
    if (mode === 'hardlink') await fs.promises.link(sourcePath, targetPath);
    else await fs.promises.symlink(path.resolve(sourcePath), targetPath, 'file');
  } catch (err) {
    if (mode === 'hardlink' && err.code === 'EXDEV') {
      throw new Error('Hard links require the source and destination to be on the same filesystem');
    }
    if (mode === 'symlink' && err.code === 'EPERM' && process.platform === 'win32') {
      throw new Error('Symbolic links require Windows Developer Mode or administrator privileges');
    }
    throw err;
  }

  return { source, target: targetPath, success: true, operation: 'link', linkType: mode };
}

async function undoLocalLink(operation) {
  if (operation.operation === 'noop') return { success: true, restored: operation.source };

  const sourceStat = await fs.promises.stat(operation.source);
  const targetStat = await fs.promises.lstat(operation.target);

  if (operation.linkType === 'symlink') {
    if (!targetStat.isSymbolicLink()) throw new Error('Target is no longer the symbolic link created by Renamr');
    const linkTarget = await fs.promises.readlink(operation.target);
    const resolvedTarget = path.resolve(path.dirname(operation.target), linkTarget);
    if (normalizeForComparison(resolvedTarget) !== normalizeForComparison(operation.source)) {
      throw new Error('Symbolic link target has changed');
    }
  } else if (targetStat.dev !== sourceStat.dev || targetStat.ino !== sourceStat.ino) {
    throw new Error('Target is no longer the hard link created by Renamr');
  }

  await fs.promises.unlink(operation.target);
  return { success: true, removed: operation.target };
}

function mapLocalToRemote(localPath, localRoot, remoteRoot) {
  if (!localPath || !localRoot || !remoteRoot) throw new Error('SSH path mapping is incomplete');
  if (!path.posix.isAbsolute(remoteRoot) || remoteRoot.includes('\0')) {
    throw new Error('Server root must be an absolute POSIX path');
  }

  const pathApi = /^[a-z]:[\\/]/i.test(localRoot) || localRoot.includes('\\') ? path.win32 : path;
  const root = pathApi.resolve(localRoot);
  const candidate = pathApi.resolve(localPath);
  const relative = pathApi.relative(root, candidate);
  if (!relative || relative === '.') return path.posix.normalize(remoteRoot.replace(/\\/g, '/'));
  if (relative.startsWith('..' + pathApi.sep) || relative === '..' || pathApi.isAbsolute(relative)) {
    throw new Error(`Path is outside the configured local root: ${localPath}`);
  }

  return path.posix.join(path.posix.normalize(remoteRoot.replace(/\\/g, '/')), ...relative.split(pathApi.sep));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function validateSshConfig(config) {
  if (!config.host) throw new Error('SSH host is required');
  if (config.host.startsWith('-') || !/^[a-z0-9_.@:-]+$/i.test(config.host)) throw new Error('SSH host contains unsupported characters');
  const port = Number(config.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535');
  return port;
}

async function runSshCommand(config, remoteCommand, runner = execFileAsync) {
  const port = validateSshConfig(config);
  const args = ['-n', '-p', String(port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10'];
  if (config.identityFile) args.push('-i', config.identityFile);
  args.push(config.host, remoteCommand);

  try {
    return await runner('ssh', args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  } catch (err) {
    const detail = String(err.stderr || err.message || '').trim();
    throw new Error(detail || 'SSH command failed');
  }
}

async function testSshConnection(config, runner) {
  if (!config.localRoot || !config.remoteRoot) throw new Error('Both local and TrueNAS path roots are required');
  const command = `test -d ${shellQuote(config.remoteRoot)} && test -w ${shellQuote(config.remoteRoot)} && command -v ln >/dev/null && printf 'Renamr-SSH-OK'`;
  const result = await runSshCommand(config, command, runner);
  return String(result.stdout || '').includes('Renamr-SSH-OK');
}

async function createSshHardLink(source, target, config, runner) {
  const remoteSource = mapLocalToRemote(source, config.localRoot, config.remoteRoot);
  const remoteTarget = mapLocalToRemote(target, config.localRoot, config.remoteRoot);
  if (remoteSource === remoteTarget) {
    return { source, target, success: true, operation: 'noop' };
  }

  const command = `test -f ${shellQuote(remoteSource)} && mkdir -p -- ${shellQuote(path.posix.dirname(remoteTarget))} && ln -T -- ${shellQuote(remoteSource)} ${shellQuote(remoteTarget)}`;
  await runSshCommand(config, command, runner);
  return {
    source,
    target,
    success: true,
    operation: 'ssh-link',
    linkType: 'hardlink',
    remoteSource,
    remoteTarget,
    sshConnection: {
      host: config.host,
      port: Number(config.port || 22),
      identityFile: config.identityFile || ''
    }
  };
}

async function undoSshHardLink(operation, config, runner) {
  if (!operation.remoteSource || !operation.remoteTarget || operation.remoteSource === operation.remoteTarget) {
    throw new Error('Invalid SSH link history: source and target must be distinct');
  }
  const command = `test ${shellQuote(operation.remoteSource)} -ef ${shellQuote(operation.remoteTarget)} && rm -- ${shellQuote(operation.remoteTarget)}`;
  await runSshCommand(config, command, runner);
  return { success: true, removed: operation.target };
}

module.exports = {
  createLocalLink,
  undoLocalLink,
  mapLocalToRemote,
  shellQuote,
  runSshCommand,
  testSshConnection,
  createSshHardLink,
  undoSshHardLink
};
