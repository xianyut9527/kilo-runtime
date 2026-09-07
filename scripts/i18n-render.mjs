#!/usr/bin/env node
// i18n-render.mjs -- CLI: query stage-i18n maps and print Chinese labels
// See --help. Zero deps. Unknown key -> stderr + exit 2.

import {
  STAGE_ZH, TIER_ZH, STATUS_ZH, INTENT_ZH, VERDICT_ZH, STRENGTH_ZH,
  labelOf, descOf, formatStage, formatTier, formatStatus, formatIntent, formatVerdict, formatTriple, formatStrength,
} from './lib/stage-i18n.mjs';

const MAPS = { STAGE: STAGE_ZH, TIER: TIER_ZH, STATUS: STATUS_ZH, INTENT: INTENT_ZH, VERDICT: VERDICT_ZH };

const USAGE = `Usage: i18n-render <KEY>
       i18n-render --map <MAP> <KEY>
       i18n-render --triple <TIER> <STAGE> [STATUS] [STRENGTH]
       i18n-render --stage <STAGE>
       i18n-render --tier <TIER>
       i18n-render --status <STATUS>
       i18n-render --intent <INTENT>
       i18n-render --verdict <VERDICT>
       i18n-render --all
       i18n-render --help

MAP is in {STAGE,TIER,STATUS,INTENT,VERDICT} (case insensitive)`;

function die(msg, code = 2) { process.stderr.write('[I18N_RENDER] ' + msg + '\n'); process.exit(code); }

function printPair(map, key) {
  if (map[key] == null) die('unknown key "' + key + '" in map');
  process.stdout.write(labelOf(map, key) + ' (' + key + ')\n' + descOf(map, key) + '\n');
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(USAGE + '\n'); process.exit(0);
}

if (args[0] === '--all') {
  for (const [name, map] of Object.entries(MAPS)) {
    process.stdout.write('=== ' + name + ' ===\n');
    for (const k of Object.keys(map)) process.stdout.write(labelOf(map, k) + ' (' + k + ')\n' + descOf(map, k) + '\n');
  }
  process.exit(0);
}

if (args[0] === '--triple') {
  const [t, s, st, str] = args.slice(1);
  if (!t || !s) die('--triple requires <TIER> <STAGE> [STATUS] [STRENGTH]');
  // 3 参简化形 `--triple T1 EXECUTING low` 时 low 为强度；4 参形 `--triple T1 EXECUTING PASS low` 时 low 为强度
  let status = st, strength = str;
  if (strength === undefined && st !== undefined && Object.prototype.hasOwnProperty.call(STRENGTH_ZH, st)) {
    strength = st; status = undefined;
  }
  process.stdout.write(formatTriple({ tier: t, stage: s, status, strength }) + '\n');
  process.exit(0);
}

if (args[0] === '--status') {
  const k = args[1]; if (!k) die('--status requires <STATUS>');
  if (STATUS_ZH[k] == null) die('unknown status "' + k + '"');
  process.stdout.write(labelOf(STATUS_ZH, k) + ' (' + k + ')\n' + descOf(STATUS_ZH, k) + '\n'); process.exit(0);
}

if (args[0] === '--stage') {
  const k = args[1]; if (!k) die('--stage requires <STAGE>');
  if (STAGE_ZH[k] == null) die('unknown stage "' + k + '"');
  process.stdout.write(labelOf(STAGE_ZH, k) + ' (' + k + ')\n' + descOf(STAGE_ZH, k) + '\n'); process.exit(0);
}

if (args[0] === '--tier') {
  const k = args[1]; if (!k) die('--tier requires <TIER>');
  if (TIER_ZH[k] == null) die('unknown tier "' + k + '"');
  process.stdout.write(labelOf(TIER_ZH, k) + ' (' + k + ')\n' + descOf(TIER_ZH, k) + '\n'); process.exit(0);
}

if (args[0] === '--intent') {
  const k = args[1]; if (!k) die('--intent requires <INTENT>');
  if (INTENT_ZH[k] == null) die('unknown intent "' + k + '"');
  process.stdout.write(labelOf(INTENT_ZH, k) + ' (' + k + ')\n' + descOf(INTENT_ZH, k) + '\n'); process.exit(0);
}

if (args[0] === '--verdict') {
  const k = args[1]; if (!k) die('--verdict requires <VERDICT>');
  if (VERDICT_ZH[k] == null) die('unknown verdict "' + k + '"');
  process.stdout.write(labelOf(VERDICT_ZH, k) + ' (' + k + ')\n' + descOf(VERDICT_ZH, k) + '\n'); process.exit(0);
}

if (args[0] === '--map') {
  const m = String(args[1] || '').toUpperCase();
  const key = args[2];
  const map = MAPS[m];
  if (!map) die('unknown map "' + args[1] + '" (must be STAGE|TIER|STATUS|INTENT|VERDICT)');
  if (!key) die('--map requires <KEY>');
  printPair(map, key);
  process.exit(0);
}

if (MAPS.STAGE[args[0]] != null) { printPair(STAGE_ZH, args[0]); }
else {
  for (const m of Object.values(MAPS)) {
    if (m[args[0]] != null) { printPair(m, args[0]); process.exit(0); }
  }
  die('unknown key "' + args[0] + '" (try --all)');
}