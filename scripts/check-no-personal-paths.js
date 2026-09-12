/**
 * Fail a packaged build that contains the build machine's personal paths.
 *
 * Native build tools record where they ran: a compiled module keeps the full
 * path to its debug symbols, and build logs list every source path. This
 * checks the packaged output on every build rather than relying on review.
 *
 * Runs as electron-builder's `afterPack` hook (see electron-builder.yml), and
 * standalone:  node scripts/check-no-personal-paths.js <directory>
 *
 * What it looks for is taken from the machine running the build — its home
 * folder and account name — so nothing personal has to be written here.
 * Both the 8-bit and UTF-16 spellings are searched: Windows binaries store
 * paths either way.
 *
 * Override (not recommended): SCRIBE_ALLOW_PERSONAL_PATHS=1
 */
const { readdirSync, readFileSync, statSync } = require('fs');
const { join, relative } = require('path');
const os = require('os');

/** Account names too generic to search for without drowning in false hits. */
const GENERIC_ACCOUNTS = new Set(['user', 'admin', 'administrator', 'runner', 'root', 'build', 'dev', 'test', 'app']);

function needles() {
    const home = os.homedir();
    const account = os.userInfo().username;
    const strings = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')]);
    if (account && account.length >= 3 && !GENERIC_ACCOUNTS.has(account.toLowerCase())) {
        strings.add(account);
        strings.add(account.toLowerCase());
        strings.add(account.toUpperCase());
    }
    const out = [];
    for (const s of strings) {
        out.push(Buffer.from(s, 'latin1'));
        out.push(Buffer.from(s, 'utf16le'));
    }
    return out;
}

function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else if (entry.isFile()) yield full;
    }
}

function findPersonalPaths(dir) {
    const search = needles();
    const hits = [];
    for (const file of walk(dir)) {
        if (statSync(file).size === 0) continue;
        const data = readFileSync(file);
        if (search.some((n) => data.indexOf(n) !== -1)) hits.push(relative(dir, file));
    }
    return hits;
}

function report(dir) {
    const hits = findPersonalPaths(dir);
    if (hits.length === 0) {
        console.log(`[privacy] no personal paths in ${dir}`);
        return;
    }
    const message =
        `[privacy] ${hits.length} packaged file(s) contain this machine's home folder or account name:\n` +
        hits.map((h) => `  - ${h}`).join('\n') +
        '\nThese would publish personal paths inside the installer. Exclude build byproducts in ' +
        'electron-builder.yml, or relink native modules with /PDBALTPATH:%_PDB% (Windows).';
    if (process.env.SCRIBE_ALLOW_PERSONAL_PATHS === '1') {
        console.warn(message + '\n[privacy] SCRIBE_ALLOW_PERSONAL_PATHS=1 — continuing anyway.');
        return;
    }
    throw new Error(message);
}

// electron-builder afterPack hook.
module.exports = async function afterPack(context) {
    report(context.appOutDir);
};

// Standalone use.
if (require.main === module) {
    const dir = process.argv[2];
    if (!dir) {
        console.error('usage: node scripts/check-no-personal-paths.js <directory>');
        process.exit(2);
    }
    try {
        report(dir);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
