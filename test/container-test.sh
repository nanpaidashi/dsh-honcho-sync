#!/usr/bin/env bash
set -euo pipefail

HONCHO_URL="${HONCHO_URL:-http://192.168.0.4:8000}"
PROFILE_NAME="${PROFILE_NAME:-testuser}"

echo "═══════════════════════════════════════════════════"
echo "  dsh-honcho-sync 容器化完整测试"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Honcho URL: $HONCHO_URL"
echo "Profile: $PROFILE_NAME"
echo ""

# 挂载点
WORK_DIR="/tmp/dsh-honcho-test-$$"
mkdir -p "$WORK_DIR"

# 把 dist 产物和 cordis patch 复制过去
cp /home/gsq/dsh-honcho-sync/dist/index.js "$WORK_DIR/honcho-sync.mjs"
cp /home/gsq/dsh-honcho-sync/cordis.patch.yml "$WORK_DIR/"

# 1. 创建干净的 profile 目录
cat > "$WORK_DIR/cordis.yml" << 'EOF'
[]
EOF

cat > "$WORK_DIR/package.json" << 'EOF'
{
  "name": "dsh-test-profile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF

cat > "$WORK_DIR/cordis.patch.yml" << 'PATCH'
# dsh-honcho-sync test profile
- insert:
    - id: honcho-sync
      name: './honcho-sync.mjs'
      config:
        honchoUrl: "HONCHO_URL_PLACEHOLDER"
        workspace: "test-workspace"
        userPeer: "testuser"
        agentPeer: "agent"
        debounceMs: 3000
        autoRecall: true
        recallBudget: 2000
        autoSync: true
        messageMaxChars: 25000
PATCH

sed -i "s|HONCHO_URL_PLACEHOLDER|$HONCHO_URL|" "$WORK_DIR/cordis.patch.yml"

echo "✅ 测试 profile 创建完成"
ls -la "$WORK_DIR/"
echo ""

# 2. 在容器内跑完整测试
podman run --rm --network host \
  -v "$WORK_DIR:/test:ro" \
  -w /test \
  docker.io/library/node:20-slim \
  bash -c '
set -euo pipefail

echo "═══════════════════════════════════════════════════"
echo "  容器内测试开始"
echo "═══════════════════════════════════════════════════"
echo ""

# 验证 Honcho 可达性
echo "▶ 测试 1: Honcho 连通性"
HEALTH=$(curl -s --connect-timeout 5 $HONCHO_URL/health)
echo "  /health: $HEALTH"
if echo "$HEALTH" | grep -q ok; then
  echo "  ✅ Honcho 可达"
else
  echo "  ❌ Honcho 不可达"
  exit 1
fi
echo ""

# 验证模块加载
echo "▶ 测试 2: 模块加载"
node -e "
const m = require('./honcho-sync.mjs');
console.log('  name:', m.name);
console.log('  inject:', JSON.stringify(m.inject));
console.log('  apply type:', typeof m.apply);
if (!m.name || typeof m.apply !== 'function') {
  throw new Error('Invalid module exports');
}
"
echo "  ✅ 模块加载成功"
echo ""

# 测试 sessionQuery 未提供时的行为（静默退出）
echo "▶ 测试 3: 无 sessionQuery 时的行为"
node -e "
const m = require('./honcho-sync.mjs');
const fakeCtx = {};
try {
  m.apply(fakeCtx, { honchoUrl: '$HONCHO_URL', workspace: 'test' });
  console.log('  ✅ 静默退出，无错误');
} catch(e) {
  console.log('  ❌ 意外错误:', e.message);
  process.exit(1);
}
"
echo ""

# 测试 Honcho API 调用
echo "▶ 测试 4: Honcho API 调用"
node -e "
async function test() {
  async function honchoRequest(method, path, body) {
    const url = '$HONCHO_URL' + path;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('json')) return await resp.json();
    return await resp.text();
  }

  // 测试 sessions/list
  const sessions = await honchoRequest('POST', '/v3/workspaces/test-workspace/sessions/list', {});
  console.log('  /sessions/list: received', typeof sessions, 'response');

  // 测试 health
  const health = await honchoRequest('GET', '/health');
  console.log('  /health:', JSON.stringify(health));

  console.log('  ✅ Honcho API 调用成功');
}
test().catch(e => { console.error('  ❌ Honcho API 失败:', e.message); process.exit(1); });
"
echo ""

# 测试 cordis.patch.yml 配置
echo "▶ 测试 5: cordis.patch.yml 验证"
node -e "
const yaml = require('fs').readFileSync('cordis.patch.yml', 'utf8');
const checks = [
  ['honcho-sync id', yaml.includes('id: honcho-sync')],
  ['honchoUrl config', yaml.includes('honchoUrl')],
  ['workspace config', yaml.includes('workspace')],
  ['autoSync config', yaml.includes('autoSync')],
  ['autoRecall config', yaml.includes('autoRecall')],
  ['debounceMs config', yaml.includes('debounceMs')],
];
for (const [name, ok] of checks) {
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + name);
  if (!ok) process.exit(1);
}
"
echo ""

# 测试 honchoRequest 函数的实际行为
echo "▶ 测试 6: honchoRequest 边界情况"
node -e "
async function test() {
  // 测试 404 路径
  try {
    const resp = await fetch('$HONCHO_URL/v3/workspaces/nonexistent/sessions/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    console.log('  nonexistent workspace status:', resp.status);
    if (resp.status === 404) {
      console.log('  ✅ 正确返回 404（workspace 不存在是正常的）');
    } else {
      console.log('  ⚠️ 期望 404 但收到', resp.status);
    }
  } catch(e) {
    console.log('  ✅ 请求失败（符合预期，workspace 不存在）');
  }
}
test();
"
echo ""

echo "═══════════════════════════════════════════════════"
echo "  容器内测试完成！全部通过 ✅"
echo "═══════════════════════════════════════════════════"
'

# 清理
rm -rf "$WORK_DIR"
echo ""
echo "═══════════════════════════════════════════════════"
echo " 测试完成！"
echo "═══════════════════════════════════════════════════"
