/**
 * sanitize-self-test.mjs — lifecycle-doctor check
 *
 * 调 scripts/sanitize-agent-description.mjs --test 自检,
 * 解析 stderr 输出的 [SUMMARY] 行, 任一 fail 即标 fail.
 *
 * 防 U3 改坏 sanitize:
 *   - GBK 边界误码黑名单
 *   - path traversal 防护
 *   - 大文件预检 (>1MB 拒绝)
 *   - 8 个自检用例全过
 *
 * 跨平台: 解析 UTF-8 字符串, cf.* detail 仅含 ASCII/可打印字符
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const SANITIZE = path.join(ROOT, "scripts", "sanitize-agent-description.mjs");
const SPAWN_TIMEOUT_MS = 30000;
const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * 解析 sanitize --test 的 stderr 输出
 * 期望行格式:
 *   [PASS] <name>
 *   [FAIL] <name>
 *   [SUMMARY] <pass>/<total> pass, <fail> fail
 * @param {string} stderr
 * @returns {{ passNames: string[], failNames: string[], summary: { pass: number, total: number, fail: number } | null }}
 */
function parseSelfTestOutput(stderr) {
  const passNames = [];
  const failNames = [];
  let summary = null;
  if (!stderr) return { passNames, failNames, summary };
  const lines = stderr.split(/\r?\n/);
  for (const line of lines) {
    const passM = line.match(/^\[PASS\]\s+(\S+)\s*$/);
    if (passM) { passNames.push(passM[1]); continue; }
    const failM = line.match(/^\[FAIL\]\s+(\S+)\s*$/);
    if (failM) { failNames.push(failM[1]); continue; }
    const sumM = line.match(/^\[SUMMARY\]\s+(\d+)\/(\d+)\s+pass,\s+(\d+)\s+fail\s*$/);
    if (sumM) {
      summary = {
        pass: parseInt(sumM[1], 10),
        total: parseInt(sumM[2], 10),
        fail: parseInt(sumM[3], 10),
      };
    }
  }
  return { passNames, failNames, summary };
}

export function run(ctx) {
  const cf = ctx && ctx.cf;
  const root = (ctx && ctx.ROOT) || ROOT;
  const checkName = "sanitize";

  const result = spawnSync("node", [SANITIZE, "--test"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (result.error) {
    const msg = "spawn failed: " + result.error.message;
    if (cf) cf.fail(checkName + ".self-test.spawn", msg);
    return { name: checkName + ".self-test", status: "FAIL", detail: msg };
  }
  if (result.signal) {
    const msg = "killed by signal: " + result.signal;
    if (cf) cf.fail(checkName + ".self-test.spawn", msg);
    return { name: checkName + ".self-test", status: "FAIL", detail: msg };
  }

  const stderr = result.stderr || "";
  const { failNames, summary } = parseSelfTestOutput(stderr);

  if (!summary) {
    const head = stderr.trim().split(/\r?\n/).slice(0, 5).join(" | ");
    const msg = "no [SUMMARY] line in sanitize --test output: " + (head || "(empty)");
    if (cf) cf.fail(checkName + ".self-test.parse", msg);
    return { name: checkName + ".self-test", status: "FAIL", detail: msg, spawnStatus: result.status };
  }

  if (summary.fail > 0 || failNames.length > 0) {
    const detail = summary.pass + "/" + summary.total + " pass, " + summary.fail + " fail";
    const names = failNames.length > 0 ? failNames : [];
    if (names.length > 0) {
      for (const n of names) {
        if (cf) cf.fail(checkName + ".self-test." + n, "sanitize self-test case failed");
      }
    } else {
      if (cf) cf.fail(checkName + ".self-test.aggregate", detail);
    }
    return {
      name: checkName + ".self-test",
      status: "FAIL",
      detail,
      spawnStatus: result.status,
    };
  }

  // 全 pass
  const detail = summary.pass + "/" + summary.total + " pass";
  if (cf) cf.pass(checkName + ".self-test", detail);
  return {
    name: checkName + ".self-test",
    status: "PASS",
    detail,
    spawnStatus: result.status,
  };
}
