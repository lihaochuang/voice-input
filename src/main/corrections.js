'use strict';
// 固定纠错表：ASR 老听错的词，写死「错 => 对」。
// 与热词表一样，**每次请求重读文件，不做缓存**。

const fs = require('fs');
const paths = require('./paths');

/**
 * 解析纠错表。
 * 格式：`错 => 对`，一行一条，# 开头或行内 # 之后是注释。
 * 非法行（有内容但不含 =>，或两侧有一侧为空）跳过并回报行号（1 起）。
 * @returns {{rules: {from:string,to:string}[], badLines: number[]}}
 */
function parse(text) {
  const rules = [];
  const badLines = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.split('#', 1)[0].trim();
      if (!line) return;
      const at = line.indexOf('=>');
      if (at < 0) {
        badLines.push(i + 1);
        return;
      }
      const from = line.slice(0, at).trim();
      const to = line.slice(at + 2).trim();
      if (!from || !to) {
        badLines.push(i + 1);
        return;
      }
      rules.push({ from, to });
    });
  // 长的先替换，避免短词抢先把长词拆了
  rules.sort((a, b) => b.from.length - a.from.length);
  return { rules, badLines };
}

/** 读纠错表；文件缺失时从 纠错表.示例.txt 落地一份（示例里全是注释，等于空表）。 */
function load() {
  const file = paths.correctionsPath();
  try {
    return parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') return { rules: [], badLines: [] };
    try {
      const sample = fs.readFileSync(paths.sampleCorrectionsPath(), 'utf8');
      fs.mkdirSync(paths.dataDir(), { recursive: true });
      fs.writeFileSync(file, sample, 'utf8');
      return parse(sample);
    } catch {
      return { rules: [], badLines: [] };
    }
  }
}

/**
 * 套用纠错表。规则按 from 长度降序逐条全局替换。
 * @returns {{text:string, hits:{from:string,to:string,count:number}[]}}
 */
function apply(text, rules = load().rules) {
  let out = String(text ?? '');
  const hits = [];
  for (const { from, to } of [...rules].sort((a, b) => b.from.length - a.from.length)) {
    if (!from) continue;
    const parts = out.split(from);
    if (parts.length === 1) continue;
    hits.push({ from, to, count: parts.length - 1 });
    out = parts.join(to);
  }
  return { text: out, hits };
}

module.exports = { parse, load, apply };
