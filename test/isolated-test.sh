#!/usr/bin/env bash
set -euo pipefail

echo "═══════════════════════════════════════════════════"
echo "  完全隔离容器测试（从零安装）"
echo "═══════════════════════════════════════════════════"

PORT=3100
HONCHO_URL="${HONCHO_URL:-http://192.168.0.4:8000}"

# 创建干净的工作目录（模拟全新电脑的 ~~~~/.dsh）
TESTDIR="/tmp/dsh-isolated-$$"
mkdir -p "$TESTDIR/.dsh/profiles/honcho-test"

# 复制 dist 产物
cp /home/gsq/dsh-honcho-sync/dist/index.js "$TESTDIR/.dsh/profiles/honcho-test/honcho-sync.mjs"

# 创建 cordis.patch.yml
cat > "$TESTDIR/.dsh/profiles/honcho-test/cordis.patch.yml" << 'EOF'
# dsh-honcho-sync isolated test
- insert:
    - id: honcho-sync
      name: './honcho-sync.mjs'
      config:
        honchoUrl: "http://192.168.0.4:8000"
        workspace: "isolated-test"
        userPeer: "testuser"
        agentPeer: "agent"
        debounceMs: 3000
        autoRecall: true
        recallBudget: 2000
        autoSync: true
        messageMaxChars: 25000
EOF

# 创建 cordis.yml
echo '[]' > "$TESTDIR/.dsh/profiles/honcho-test/cordis.yml"

# 创建 package.json
cat > "$TESTDIR/.dsh/profiles/honcho-test/package.json" << 'EOF'
{
  "name": "dsh-isolated-test",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF

echo ""
echo "▶ 启动隔离容器..."
echo "  工作目录: $TESTDIR/.dsh/profiles/honcho-test"
echo "  端口: $PORT"
echo "  Honcho: $HONCHO_URL"
echo ""

# 在容器内运行 DSH
podman run --rm --network host \
  -v "$TESTDIR/.dsh:/root/.dsh:rw" \
  -w /root/.dsh/profiles/honcho-test \
  docker.io/library/node:20-slim \
  bash -c '
set -euo pipefail

echo "═══════════════════════════════════════════════════"
echo "  容器内：从零安装和启动 DSH"
echo "═══════════════════════════════════════════════════"
echo ""

# 安装 DSH（在容器内，完全隔离）
echo "▶ 安装 DSH..."
npm init -y > /dev/null 2>&1
npm install @deepseek-ai/dsh@latest \
  @deepseek-ai/dsh-base \
  @deepseek-ai/dsh-web-app \
  @deepseek-ai/dsh-settings \
  @deepseek-ai/dsh-host-webserver \
  @deepseek-ai/schemastery \
  react react-dom 2>&1 | tail -3
echo "✅ DSH 安装完成"
echo ""

# 用 npx 启动 DSH（容器内独立环境，没有历史会话）
echo "▶ 启动 DSH web (端口 3100)..."
npx @deepseek-ai/dsh web --port 3100 &
DSH_PID=$!
echo "  DSH PID: $DSH_PID"

# 等待启动
sleep 8

# 验证启动
echo ""
echo "▶ 验证 DSH 启动..."
if curl -s --connect-timeout 3 http://127.0.0.1:3100/ > /dev/null 2>&1; then
  echo "  ✅ DSH web 在 :3100 启动成功"
else
  echo "  ❌ DSH 启动失败"
  kill $DSH_PID 2>/dev/null || true
  exit 1
fi

# 验证页面加载（检查是否有 __DSH_BOOT__）
BOOT=$(curl -s http://127.0.0.1:3100/ 2>/dev/null | grep -o "__DSH_BOOT__" | head -1)
if [ -n "$BOOT" ]; then
  echo "  ✅ DSH 页面正常加载（有 __DSH_BOOT__）"
else
  echo "  ⚠️ 页面可能不完整"
fi

# 验证 Honcho 连通性
echo ""
echo "▶ 验证 Honcho 连通性..."
HEALTH=$(curl -s --connect-timeout 3 http://192.168.0.4:8000/health)
if echo "$HEALTH" | grep -q ok; then
  echo "  ✅ Honcho 可达: $HEALTH"
else
  echo "  ❌ Honcho 不可达"
fi

# 验证 honcho-sync 模块加载
echo ""
echo "▶ 验证 honcho-sync 模块..."
node -e "
const m = require('./honcho-sync.mjs');
console.log('  name:', m.name);
console.log('  apply type:', typeof m.apply);
if (m.name === 'honcho-sync' && typeof m.apply === 'function') {
  console.log('  ✅ 模块加载成功');
} else {
  console.log('  ❌ 模块异常');
  process.exit(1);
}
"

# 验证 cordis.patch.yml
echo ""
echo "▶ 验证 cordis.patch.yml..."
node -e "
const yaml = require(fs).readFileSync(cordis.patch.yml, utf8);
if (yaml.includes(honcho-sync) && yaml.includes(honchoUrl)) {
  console.log('  ✅ cordis.patch.yml 配置正确');
} else {
  console.log('  ❌ cordis.patch.yml 异常');
  process.exit(1);
}
"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  隔离容器测试完成！✅"
echo "  DSH 运行在 http://127.0.0.1:3100"
echo "═══════════════════════════════════════════════════"
echo ""
echo "（按 Ctrl+C 停止容器）"

# 保持容器运行，让用户可以访问
wait $DSH_PID
'

# 清理
rm -rf "$TESTDIR"
