// Bounded M0 experiment, never imported by the application or an active profile.
const { DatabaseSync } = require('node:sqlite');
const { execFileSync, spawn } = require('node:child_process');
const { writeFileSync, readFileSync, readdirSync, readlinkSync } = require('node:fs');
const path = require('node:path');
const [root, mode] = process.argv.slice(2);
const socket = path.join(root, 'tmux.sock');
const db = new DatabaseSync(path.join(root, 'spike.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS evidence (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT;');
if (mode === 'read') {
  process.stdout.write(JSON.stringify({ rows: db.prepare('SELECT * FROM evidence').all(), integrity: db.prepare('PRAGMA integrity_check').get() }));
  db.close();
} else {
  const lock = readlinkSync(`/proc/self/fd/${process.env.MINIMAL_LOCK_FD}`);
  // A real descendant must not retain the writer lock after this owner dies.
  const childCode = `const fs=require('node:fs'); const links=fs.readdirSync('/proc/self/fd').flatMap(n=>{try{return [fs.readlinkSync('/proc/self/fd/'+n)]}catch{return []}}); process.stdout.write(JSON.stringify(links));`;
  const inherited = JSON.parse(execFileSync(process.execPath, ['-e', childCode], { encoding: 'utf8' }));
  if (inherited.includes(lock)) throw new Error('Writer lock leaked to child');
  try { execFileSync('tmux', ['-S', socket, 'has-session', '-t', 'spike'], { stdio: 'ignore' }); }
  catch { execFileSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'spike', 'sleep 600']); }
  const pid = Number(execFileSync('tmux', ['-S', socket, 'display-message', '-p', '-t', 'spike', '#{pane_pid}'], { encoding: 'utf8' }).trim());
  db.exec("BEGIN IMMEDIATE; INSERT INTO evidence(note) VALUES ('acknowledged α🌍'); COMMIT;");
  // The next transaction must be rolled back after SIGKILL.
  db.exec("BEGIN IMMEDIATE; INSERT INTO evidence(note) VALUES ('unacknowledged');");
  writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ pid: process.pid, panePid: pid, versions: process.versions, cgroup: readFileSync('/proc/self/cgroup', 'utf8') }));
  process.on('SIGTERM', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
  setInterval(() => {}, 1000);
}
