const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3737;

// ───────────────────────────────────────────────────────────
// 工具函数
// ───────────────────────────────────────────────────────────

/** 判断文件名（不含扩展名）是否符合规范：仅小写字母/数字/连字符，且 ≤50 字节 */
function isValidName(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  return Buffer.byteLength(name, 'utf8') <= 50;
}

/** 将任意文件名转换为兼容格式（小写字母/数字/连字符，≤50字节） */
function toValidName(name) {
  let valid = name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')        // 空格/下划线 → 连字符
    .replace(/[^a-z0-9-]/g, '-')   // 其他非法字符 → 连字符
    .replace(/-{2,}/g, '-')         // 合并连续连字符
    .replace(/^-|-$/g, '');         // 去掉首尾连字符

  // 截断至50字节以内
  if (Buffer.byteLength(valid, 'utf8') > 50) {
    while (Buffer.byteLength(valid, 'utf8') > 50) {
      valid = valid.slice(0, -1);
    }
    valid = valid.replace(/-$/, ''); // 去掉末尾连字符
  }
  return valid;
}

/** 备份文件（源文件路径 → 源文件路径 + .bak） */
function backupFile(filePath) {
  const bakPath = filePath + '.bak';
  fs.copyFileSync(filePath, bakPath);
  return bakPath;
}

// ───────────────────────────────────────────────────────────
// API：递归扫描目录（按子文件夹分组）
// ───────────────────────────────────────────────────────────

/** 解析跳过列表字符串为数组 */
function parseSkipList(str) {
  if (!str || !str.trim()) return [];
  return str.split(/[,，]/).map(s => s.trim()).filter(Boolean);
}

/** 检查是否匹配通配符模式 */
function matchWildcard(filename, pattern) {
  if (!pattern.includes('*')) return filename === pattern;
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return regex.test(filename);
}

/** 递归收集所有 .md 文件，跳过 .bak 同名文件 */
function collectMdFiles(dir, rootDir, skipFolders, skipFiles, charLimit, result = []) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return result; }

  const mdFiles = [];
  const subDirs = [];

  for (const entry of entries) {
    // 跳过隐藏目录
    if (entry.startsWith('.')) continue;
    // 跳过指定文件夹
    if (skipFolders.includes(entry)) continue;

    const fullPath = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(fullPath); } catch (e) { continue; }

    if (stat.isDirectory()) {
      subDirs.push(fullPath);
    } else if (entry.endsWith('.md') && !entry.endsWith('.bak.md')) {
      // 跳过指定文件名（支持通配符）
      if (skipFiles.some(pattern => matchWildcard(entry, pattern))) continue;

      let content = '';
      let readError = null;
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch (e) {
        readError = e.message;
      }
      const charCount = content.length;
      const baseName = path.basename(entry, '.md');
      const nameValid = isValidName(baseName);

      mdFiles.push({
        fileName: entry,
        baseName,
        fullPath,
        relPath: path.relative(rootDir, fullPath),
        charCount,
        nameValid,
        suggestedName: nameValid ? baseName : toValidName(baseName),
        charOk: charCount <= charLimit,
        readError
      });
    }
  }

  // 当前目录有 .md 文件时，作为一个分组加入
  if (mdFiles.length > 0) {
    mdFiles.sort((a, b) => a.fileName.localeCompare(b.fileName));
    result.push({
      folder: dir,
      folderRel: path.relative(rootDir, dir) || '.',
      files: mdFiles
    });
  }

  // 递归子目录
  subDirs.sort();
  for (const sub of subDirs) {
    collectMdFiles(sub, rootDir, skipFolders, skipFiles, charLimit, result);
  }

  return result;
}

app.post('/api/scan', (req, res) => {
  const { dir, skipFolders, skipFiles, charLimit } = req.body;
  if (!dir) return res.status(400).json({ error: '请提供目录路径' });

  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) return res.status(404).json({ error: '目录不存在: ' + absDir });
  if (!fs.statSync(absDir).isDirectory()) return res.status(400).json({ error: '请提供一个目录（文件夹）路径' });

  // 解析跳过列表和字符数限制
  const folderSkipList = parseSkipList(skipFolders);
  const fileSkipList = parseSkipList(skipFiles);
  const limit = parseInt(charLimit, 10) || 20480;

  try {
    const groups = collectMdFiles(absDir, absDir, folderSkipList, fileSkipList, limit);
    const totalFiles = groups.reduce((n, g) => n + g.files.length, 0);
    res.json({ dir: absDir, groups, totalFiles, charLimit: limit });
  } catch (err) {
    console.error('[scan error]', err);
    res.status(500).json({ error: err.message, detail: err.stack });
  }
});

// ───────────────────────────────────────────────────────────
// API：重命名文件
// ───────────────────────────────────────────────────────────
app.post('/api/rename', (req, res) => {
  const { filePath, newBaseName } = req.body;
  if (!filePath || !newBaseName) return res.status(400).json({ error: '缺少参数' });
  if (!isValidName(newBaseName)) return res.status(400).json({ error: '新文件名不符合规范（仅允许小写字母、数字、连字符）' });

  try {
    const dir = path.dirname(filePath);
    const newPath = path.join(dir, newBaseName + '.md');

    if (fs.existsSync(newPath) && newPath !== filePath) {
      return res.status(409).json({ error: '目标文件名已存在: ' + newBaseName + '.md' });
    }

    // 备份
    const bakPath = backupFile(filePath);
    // 重命名
    fs.renameSync(filePath, newPath);

    res.json({ success: true, newPath, bakPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// API：AI 精简文件内容（调用 OpenAI 兼容接口）
// ───────────────────────────────────────────────────────────
app.post('/api/shrink', async (req, res) => {
  const { filePath, apiKey, apiBase, model, proxyUrl, charLimit } = req.body;
  if (!filePath) return res.status(400).json({ error: '缺少 filePath' });
  if (!apiKey)   return res.status(400).json({ error: '请先填写 API Key' });

  const limit = parseInt(charLimit, 10) || 20480;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.length <= limit) {
      return res.json({ success: true, message: '文件已经符合要求，无需精简', charCount: content.length });
    }

    const base = (apiBase || 'https://api.deepseek.com').replace(/\/$/, '');
    const modelName = model || 'deepseek-chat';

    // 备份
    const bakPath = backupFile(filePath);

    // 调用 AI
    const prompt = `你是一位专业的技术文档编辑。请将以下 Markdown 文档精简至 ${limit} 字符以内，要求：
1. 保留所有核心技术内容、代码示例、关键步骤
2. 删除冗余描述、重复内容、过多的背景介绍
3. 保持原有 Markdown 格式结构
4. 不得改变文档的技术准确性
5. 直接输出精简后的 Markdown 内容，不要加任何说明

原始内容（共 ${content.length} 字符）：

${content}`;

    // 构建请求配置
    const requestConfig = {
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    };

    // 如果提供了代理地址，使用代理
    if (proxyUrl && proxyUrl.trim()) {
      const HttpsProxyAgent = require('https-proxy-agent');
      requestConfig.httpsAgent = new HttpsProxyAgent(proxyUrl.trim());
    }

    const response = await axios.post(
      base + '/v1/chat/completions',
      {
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 8000
      },
      requestConfig
    );

    const newContent = response.data.choices[0].message.content;
    fs.writeFileSync(filePath, newContent, 'utf8');

    res.json({
      success: true,
      bakPath,
      originalChars: content.length,
      newChars: newContent.length,
      charOk: newContent.length <= limit,
      charLimit: limit
    });
  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ error: 'AI 调用失败: ' + msg });
  }
});

// ───────────────────────────────────────────────────────────
// API：获取文件内容预览
// ───────────────────────────────────────────────────────────
app.post('/api/preview', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: '缺少 filePath' });
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content, charCount: content.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ MD 文件整理工具已启动`);
  console.log(`   打开浏览器访问: http://localhost:${PORT}\n`);
});
