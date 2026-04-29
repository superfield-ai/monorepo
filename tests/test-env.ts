import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "superfield-tests-"));
const HOME_DIR = join(TEST_ROOT, "home");
const CONTROL_LOG_DIR = join(TEST_ROOT, "control-logs");
const SUPERFIELD_LOG_DIR = join(TEST_ROOT, "superfield-logs");
const CLAUDE_LOG_PATH = join(TEST_ROOT, "claude.log");

for (const dir of [HOME_DIR, CONTROL_LOG_DIR, SUPERFIELD_LOG_DIR]) {
  mkdirSync(dir, { recursive: true });
}

process.env.SUPERFIELD_TEST_ROOT = TEST_ROOT;
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = HOME_DIR;
process.env.XDG_CONFIG_HOME = join(TEST_ROOT, "xdg-config");
process.env.CONTROL_LOG_DIR = CONTROL_LOG_DIR;
process.env.SUPERFIELD_LOG_DIR = SUPERFIELD_LOG_DIR;
process.env.CLAUDE_E2E_LOG_PATH = CLAUDE_LOG_PATH;
