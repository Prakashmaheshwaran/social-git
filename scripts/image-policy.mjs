#!/usr/bin/env node

import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const forbiddenExecutables = new Set([
  "chrome", "chrome-sandbox", "chromedriver", "chromium", "chromium-browser",
  "firefox", "firefox-esr", "geckodriver", "google-chrome", "google-chrome-stable",
  "headless_shell", "msedgedriver", "phantomjs", "playwright", "selenium", "xvfb", "xvfb-run",
]);
const forbiddenPackages = new Set([
  "asyncpraw", "chrome-remote-interface", "chromium", "chromium-common", "chromedriver",
  "firefox-esr", "geckodriver", "praw", "prawcore", "playwright", "puppeteer",
  "puppeteer-core", "pyppeteer", "reddit-api-client", "redditwarp", "selenium", "snoowrap", "xvfb",
  "twikit", "twifork", "twscrape", "twitter-api-client", "tweeterpy", "twikit-ng",
]);
const forbiddenTools = /^(?:apt(?:[-.].+)?|dpkg(?:[-.].+)?|debconf(?:[-.].+)?|deb-systemd-(?:helper|invoke)|invoke-rc\.d|policy-rc\.d|service|start-stop-daemon|ucf(?:q|r)?|update-alternatives|pip(?:3(?:\.\d+)?)?|npm|npx|corepack|yarn|pnpm|node-gyp|cc|c\+\+|g\+\+|gcc(?:-\d+)?|clang(?:-\d+)?|make)$/iu;
const forbiddenMarkers = [
  "reddit_client_id", "reddit_client_secret", "reddit_api_key", "praw_client_id", "praw_client_secret",
  "oauth.reddit.com", "reddit.com/api/v1/access_token", "chrome-remote-interface", "--remote-debugging-port", "devtools://",
];
const skipped = new Set(["/dev", "/proc", "/sys", "/policy"]);

const executableHits = [];
const runtimeToolingHits = [];
walk("/", (path) => {
  const name = basename(path);
  const executable = isExecutable(path);
  if (forbiddenExecutables.has(name.toLowerCase()) && executable) executableHits.push(path);
  if (forbiddenTools.test(name) && executable) runtimeToolingHits.push(path);
  if (/^libapt-(?:pkg|private)\.so(?:\..*)?$/iu.test(name)) runtimeToolingHits.push(path);
  if (["/usr/lib/apt/", "/usr/lib/dpkg/", "/usr/libexec/dpkg/", "/usr/share/debconf/", "/usr/share/dpkg/", "/usr/share/perl5/Debconf/", "/usr/share/perl5/Dpkg/", "/usr/local/include/", "/usr/local/lib/node_modules/"].some((prefix) => path.startsWith(prefix))) runtimeToolingHits.push(path);
  if (path.startsWith("/var/lib/dpkg/info/") && /\.(?:config|postinst|postrm|preinst|prerm|triggers)$/u.test(path) && executable) runtimeToolingHits.push(path);
});

const applicationConfigHits = [];
walk("/opt/social-git", (path, stat) => {
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;
  const content = readFileSync(path).toString("utf8").toLowerCase();
  for (const marker of forbiddenMarkers) if (content.includes(marker)) applicationConfigHits.push(`${path}:${marker}`);
});
for (const name of Object.keys(process.env).map((value) => value.toLowerCase())) {
  if (forbiddenMarkers.slice(0, 5).includes(name)) applicationConfigHits.push(`environment:${name}`);
}

const operatingSystemPackages = existsSync("/var/lib/dpkg/status")
  ? [...readFileSync("/var/lib/dpkg/status", "utf8").matchAll(/^Package:\s*(.+)$/gmu)].map((match) => match[1].trim().toLowerCase())
  : [];
const metadataMissing = ["/opt/social-git/share/source-manifest.sha256", "/opt/social-git/share/sbom.spdx.json"].filter((path) => !existsSync(path));
const checks = {
  forbiddenApplicationConfig: [...new Set(applicationConfigHits)].sort(),
  forbiddenExecutables: [...new Set(executableHits)].sort(),
  forbiddenOperatingSystemPackages: operatingSystemPackages.filter((name) => forbiddenPackages.has(name)).sort(),
  metadataMissing,
  unexpectedRuntimeTooling: [...new Set(runtimeToolingHits)].sort(),
  unexpectedUid: process.getuid?.() === 10001 ? [] : [String(process.getuid?.())],
};
const passed = Object.values(checks).every((values) => values.length === 0);
process.stdout.write(`${JSON.stringify({ architecture: process.arch, checks, status: passed ? "ok" : "failed" })}\n`);
process.exitCode = passed ? 0 : 1;

function walk(root, visit) {
  if (!existsSync(root)) return;
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.pop();
    let names;
    try { names = readdirSync(directory); } catch { continue; }
    for (const name of names) {
      const path = join(directory, name);
      if (skipped.has(path)) continue;
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isDirectory()) queue.push(path);
      else visit(path, stat);
    }
  }
}

function isExecutable(path) {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}
