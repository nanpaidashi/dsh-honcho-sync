#!/usr/bin/env bash
set -euo pipefail

echo "═══ dsh-honcho-sync 容器测试 ═══"

# 从 GitHub 克隆干净副本
TESTDIR=$(mktemp -d)
echo "测试目录: $TESTDIR"
cd "$TESTDIR"

# 1. 安装 DSH
echo ""
echo "▶ 安装 DSH..."
npm init -y > /dev/null 2>&1
npm install @deepseek-ai/dsh@latest 2>&1 | tail -5

# 2. 创建 cordis.patch.yml
cat > cordis.patch.yml << 'EOF'
- insert:
    - id: honcho-sync
      name: '@nanpaidashi/dsh-honcho-sync'
      config:
        honchoUrl: "http://192.168.0.4:8000"
        workspace: "test-honcho-sync"
        userPeer: "tester"
        agentPeer: "agent"
        debounceMs: 3000
        autoRecall: true
        recallBudget: 2000
        autoSync: true
        messageMaxChars: 25000
EOF

# 3. 创建最小 cordis.yml
echo '[]' > cordis.yml

# 4. 创建最小 package.json
cat > package.json << 'EOF'
{
  "name": "test-honcho-sync-profile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF

# 5. 创建 honcho-sync.mjs（本地文件方式，因为 npm 包可能还没发布）
# 先把 dist 产物复制过去
cp /home/gsq/dsh-honcho-sync/dist/index.js .

cat > cordis.patch.yml << 'EOF'
- insert:
    - id: honcho-sync
      name: './index.js'
      config:
        honchoUrl: "http://192.168.0.4:8000"
        workspace: "test-honcho-sync"
        userPeer: "tester"
        agentPeer: "agent"
        debounceMs: 3000
        autoRecall: true
        recallBudget: 2000
        autoSync: true
        messageMaxChars: 25000
EOF

echo ""
echo "▶ 验证模块加载..."
node -e "
const m = require('./index.js');
console.log('name:', m.name);
console.log('inject:', m.inject);
console.log('apply type:', typeof m.apply);
console.log('✅ 模块加载成功');
"

echo ""
echo "▶ 测试 Honcho API 连通..."
curl -s http://192.168.0.4:8000/health | python3 -m json.tool 2>/dev/null || echo "Honcho 不可达"

echo ""
echo "▶ 清理测试目录: $TESTDIR"
cd /
rm -rf "$TESTDIR"

echo ""
echo "═══ 测试完成 ═══"
