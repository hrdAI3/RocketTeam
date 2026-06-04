#!/usr/bin/env bun
// Add or update a team dashboard user. Stores scrypt-hashed password in
// private/users.json. SESSION_SECRET env required for cookie signing
// (set in .env or process env). Passwords typed at prompt are never echoed.
//
// Usage:
//   bun tools/add_user.ts <username>           # prompts for password
//   bun tools/add_user.ts <username> <pwd>     # password as arg (less safe)

import { addOrUpdateUser, loadUsers } from '../src/lib/auth';

function readPasswordSilent(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (d: string) => {
      for (const ch of d) {
        const code = ch.charCodeAt(0);
        // Enter
        if (code === 13 || code === 10) {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        // Ctrl-C
        if (code === 3) {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          reject(new Error('aborted'));
          return;
        }
        // Backspace / DEL
        if (code === 127 || code === 8) {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        // Printable
        if (code >= 32) {
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const username = argv[0]?.trim();
  if (!username) {
    console.error('usage: bun tools/add_user.ts <username> [<password>]');
    process.exit(2);
  }
  let pwd = argv[1];
  if (!pwd) {
    pwd = await readPasswordSilent('Password: ');
    const confirm = await readPasswordSilent('Confirm:  ');
    if (pwd !== confirm) {
      console.error('passwords do not match');
      process.exit(2);
    }
  }
  if (pwd.length < 6) {
    console.error('password must be at least 6 characters');
    process.exit(2);
  }
  await addOrUpdateUser(username, pwd);
  const file = await loadUsers();
  console.log(`✓ saved user "${username}"`);
  console.log(`  total users: ${file.users.length}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
