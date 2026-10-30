#!/bin/bash
# 官方前端更新流程。用法: scripts/update-upstream.sh check | apply
# 国际服: WUWA_REGION=global scripts/update-upstream.sh check
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
mode="${1:-check}"
export CARGO_HOME="$PWD/.work/cargo-home"
mkdir -p .work

echo "== 当前锁定版本 =="
node -e 'const j=require("./upstream-cn.json");console.log("version", j.version)'

if [ "$mode" = "check" ]; then
  npm run upstream:check
  exit $?
fi

echo "== 1/4 更新 upstream 锁文件 =="
npm run upstream:update || exit 1

echo "== 2/4 下载并校验官方包，重抽前端 =="
npm run assets:sync || exit 1

echo "== 3/4 应用补丁（失败会指出要重锚的补丁）=="
npm run prepare:frontend 2>&1 | tee .work/prepare.log
if [ "${PIPESTATUS[0]}" -ne 0 ]; then
  echo
  echo "!! prepare 失败。需要重锚："
  grep -E "Original .* changed|Expected .* found|found [0-9]+ stock" .work/prepare.log | head -20
  echo "参考 docs/mac-maintenance.md 的补丁清单。"
  exit 1
fi

echo "== 4/4 生成 inventory 并构建 =="
npm run inventory || exit 1
npm run build
