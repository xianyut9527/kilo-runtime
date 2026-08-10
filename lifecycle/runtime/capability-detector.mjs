// capability-detector.mjs — Kilo runtime intent capability detector
// Inspects user intent (raw text + attached file list) to determine which
// capabilities the downstream model must possess: vision / code / reasoning
// / long_context. Pure function; no I/O, no third-party deps.
// Used by conductor to intersect user-need capabilities with model registry
// before dispatching EXECUTING units.

const VISION_KEYWORDS = ['图片', '截图', '照片', 'screenshot', 'image', 'photo', '看图'];
const VISION_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic'];
const CODE_KEYWORDS = [
  'code', '代码', '函数', '接口', 'bug', '重构', '实现', '编写', '修复', '类', '方法',
];
const CODE_EXT_PATTERN = /\.(js|ts|py|java|go|rs|c|cpp|rb|php)\b/i;
const DATA_IMAGE_PATTERN = /data:image\//i;
const URL_IMAGE_PATTERN = /https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|webp|gif|bmp|heic)/i;
const LONG_CONTEXT_LENGTH = 5000;
const LONG_CONTEXT_FILE_COUNT = 3;

function hasVisionAttachment(attachedFiles) {
  if (!Array.isArray(attachedFiles)) return false;
  for (const file of attachedFiles) {
    if (typeof file !== 'string' || file.length === 0) continue;
    const lower = file.toLowerCase();
    if (VISION_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  }
  return false;
}

function detectVision(intentRaw, attachedFiles) {
  if (hasVisionAttachment(attachedFiles)) return true;
  if (typeof intentRaw !== 'string' || intentRaw.length === 0) return false;
  const lower = intentRaw.toLowerCase();
  for (const keyword of VISION_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) return true;
  }
  if (DATA_IMAGE_PATTERN.test(intentRaw)) return true;
  if (URL_IMAGE_PATTERN.test(intentRaw)) return true;
  return false;
}

function detectCode(intentRaw) {
  if (typeof intentRaw !== 'string' || intentRaw.length === 0) return false;
  const lower = intentRaw.toLowerCase();
  for (const keyword of CODE_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) return true;
  }
  if (CODE_EXT_PATTERN.test(intentRaw)) return true;
  return false;
}

function detectLongContext(intentRaw, attachedFiles) {
  if (typeof intentRaw === 'string' && intentRaw.length > LONG_CONTEXT_LENGTH) return true;
  if (Array.isArray(attachedFiles) && attachedFiles.length > LONG_CONTEXT_FILE_COUNT) return true;
  return false;
}

export function detectCapabilities(intentRaw, attachedFiles = []) {
  return {
    vision: detectVision(intentRaw, attachedFiles),
    code: detectCode(intentRaw),
    reasoning: true,
    long_context: detectLongContext(intentRaw, attachedFiles),
  };
}
