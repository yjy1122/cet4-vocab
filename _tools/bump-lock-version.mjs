/* 只改 package-lock.json 的根版本（两处），绝不碰依赖的版本号。
 * 上一版改名时用全局替换把三个依赖的 1.0.0 也一起改了，锁文件当场损坏 —— 所以这件事必须结构化做。
 * 校验方式：解析前后两份 JSON，逐条比对 node_modules/* 与其余顶层字段，
 * 只允许 root 的 version 与 packages[""].version 两处不同。 */
import fs from "node:fs";
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || "")) { console.error("用法: node _tools/bump-lock-version.mjs <x.y.z>"); process.exit(2); }
const file = "package-lock.json";
const before = JSON.parse(fs.readFileSync(file, "utf8"));
const after = JSON.parse(JSON.stringify(before));
after.version = v;
after.packages = { ...after.packages, "": { ...after.packages[""], version: v } };
fs.writeFileSync(file, JSON.stringify(after, null, 2) + "\n", "utf8");

const diffs = [];
const cmp = (a, b, path) => {
  if (a === b) return;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) cmp(a[k], b[k], path + "." + k);
    return;
  }
  diffs.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
};
cmp(before, JSON.parse(fs.readFileSync(file, "utf8")), "$");

const ALLOWED = new Set(["$.version", "$.packages..version"]);
const outside = diffs.filter((d) => !ALLOWED.has(d.split(":")[0]));
console.log(`解析比对：共 ${diffs.length} 处差异`);
diffs.forEach((d) => console.log("  " + d));
if (diffs.length !== 2 || outside.length) {
  console.error("❌ 改动超出根版本两处，锁文件不能这么碰");
  process.exit(1);
}
const deps = Object.keys(after.packages).filter((k) => k.startsWith("node_modules/")).length;
console.log(`✅ 仅根版本 ${before.version} → ${v}；${deps} 个依赖条目逐字段核对未变`);
