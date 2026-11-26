# MyReels Studio

MyReels Studio 是一个用于 DeepSeek Harness 的短剧制作插件。它把剧本分析、角色与场景资产、分镜视频和整集成片串联到一个工作区中，由会话里的 agent 驱动执行。

插件通过 MyReels 账号授权登录，不保存网页密码。

## 环境要求

- DeepSeek Harness Desktop
- 可用的 MyReels 账号
- 本地已安装 `ffmpeg`（视频拼接/转码需要）

## 安装

最新仓库地址：

```text
https://github.com/myreelsai/myreels-studio
```

### 方式一：DSH 网络安装

适用于当前账号能访问该 GitHub 仓库，或仓库已设为 Public 的情况。

在 DSH 的「插件管理 → 添加插件」中填写完整 GitHub 地址：

```text
https://github.com/myreelsai/myreels-studio
```

或在会话里执行：

```text
plugin_manager install_bundle target = https://github.com/myreelsai/myreels-studio
```

注意不要只填：

```text
myreels-studio
```

这是仓库名，不是已发布的 npm 包名；DSH 按包名搜索时会找不到。

如果 DSH 提示：

```text
connection to github.com timed out
```

说明当前网络到 GitHub 不稳定，改用下面的本地安装方式。

### 方式二：克隆后安装

```bash
git clone https://github.com/myreelsai/myreels-studio.git
cd myreels-studio
```

然后在 DSH 会话里执行：

```text
plugin_manager install_bundle target = <本地 myreels-studio 目录>
```

例如：

```text
plugin_manager install_bundle target = D:\plugins\myreels-studio
```

私有仓库需要先配置 GitHub 登录、PAT 或 SSH，确保 `git clone` 能成功。

### 已安装旧版本

先卸载旧版，再安装 GitHub 版本：

```text
plugin_manager remove_bundle target = @local/myreels-studio
```

如果安装时报：

```text
ERR_PNPM_EPERM rename ... node_modules\@local\myreels-studio
```

这是旧插件仍被 DSH 占用，不是 GitHub 权限问题。先卸载旧插件并重启 DSH，再重新安装。

安装后刷新 DSH 页面，左侧栏顶部会出现 **MyReels Studio**（胶片图标）。

### 更新

```bash
cd myreels-studio
git pull
```

- 只改 `lib/` 或 `client.js`：更新后重启 DSH
- 改了 `package.json` 依赖：重新卸载并安装

```text
plugin_manager remove_bundle target = @local/myreels-studio
plugin_manager install_bundle target = <本地 myreels-studio 目录>
```

详细步骤见 [INSTALL.md](INSTALL.md)。

## 推荐搭配的 DSH 插件

下面两个不是必需依赖，但配合使用会省不少事：

- **上下文洞察**（`dsh-context`）：看清会话的上下文由什么构成、怎么增长。剧本长、集数多时能及早发现上下文吃紧，避免关键设定在中途被压缩掉。
- **记忆系统**（`dsh-mnemon`）：给智能体加一层可复用的记忆，把项目约定和你的偏好留下来，换会话不用重新交代画风、比例这些设定。

安装同样一句话交给 agent 即可：

> 安装 dsh-context 和 dsh-mnemon 这两个 DSH 插件

## 快速上手

1. **认识入口**：刷新后左侧栏顶部出现 **MyReels Studio**，点开是「MyReels Studio 任务」面板，按剧分组列出本机已接入、且后端项目仍可访问的 run（任务）。
2. **先登录**：未登录时面板右上角有「重新登录」，点它会弹出「登录 MyReels」窗口，在窗口里完成登录。成功后窗口自动关闭，面板显示账号和点数。
3. **把剧本交给 agent**：在会话里说「用 MyReels Studio 把这份剧本做成短剧，共 3 集」，并把剧本贴进来或给出文件路径。agent 会创建项目，面板里随即出现对应的分组和 run。
4. **统一做项目设置**：在剧名那一行右侧点「项目设置」，选画风、画幅、预算等并保存。这一步不要靠对话逐项确认，保存后 agent 才能提交分析。
5. **往下推进**：剧本分析 → 资产图 → 分镜视频 → 整集成片，每一步都在会话里让 agent 继续；面板同步显示当前阶段与进度。

面板是只读视图（只有删除本机文件、退出登录、自主优化开关会写数据），所有生成操作都在会话里交给 agent 执行。

## 任务列表包含哪些项目

任务列表读取的是**本地 run 注册表**，不是 WebUI 的全部故事项目。

- **会出现在任务列表**：插件 `run_start` 创建并同步到 WebUI 的项目；通过 `project_open` 接入并管理的 WebUI 项目。
- **不会出现在任务列表**：只在 WebUI 中存在、但从未被插件创建或接入的项目；这类项目只在 `project_open list` 中出现。
- **WebUI 删除项目后**：本地 run 文件和产物仍然保留，但默认任务列表隐藏该项目；`project_open` 也不会再显示。
- **权限变化同理**：项目被删除、当前账号失去权限或后端返回 404 时，默认隐藏；网络错误或后端 5xx 不会隐藏。
- **查看本地历史**：`myreels_runs(includeDeleted=true)`，或 Web 面板访问 `/runs?includeDeleted=1`。

## 预览与成片

- **资产预览**：剧名那一行右侧的「资产预览」，查看角色、场景参考图。
- **任务详情**：点任意一条 run，展开「任务详情」，能看到集数、资产有图数、分镜视频数、下一步建议和成片路径。
- **预览成片**：该集有视频后，详情卡里出现「预览成片」，直接在面板内播放；也可以在会话中用 `myreels_preview` 生成本地 HTML 画廊。
- **成片文件**：`<工作区>/myreels-runs/<剧名>/epNN/epNN.mp4`。有分镜缺失时只输出 `epNN.partial.mp4`，不会覆盖正式成片。
- **项目报告**：用 `myreels_report` 输出 Markdown 报告，详情卡里也有「查看报告」入口。

## 登录说明

- 走 MyReels 账号登录，插件里不需要填写账号密码或开发者令牌
- 扫码登录如果停在成功页，改用「在浏览器中打开」完成
- 「退出登录」只清除插件登录态，不删除项目文件

## 主要能力

### 剧本与项目

- 剧本格式识别与校验
- 按集拆分、批量提交分析
- 项目设置、画风、比例和预算确认
- 剧本优化前后的剧情保真检查

### 资产

- 角色、场景、物品、生物资产
- 资产变体与参考图
- 资产提示词审查、修复和一致性检查

### 分镜与视频

- 分镜清单、时长和台词检查
- 逐镜生成与失败重试
- 视频模型、时长和预算约束
- 分镜参考图、变体连续性和镜头合同检查

### 成片

- 分镜视频下载与拼接
- 缺镜保护：只输出 partial 成片，不覆盖正式成片
- Markdown 项目报告

## 本地数据

- 登录凭据只保存在本机
- 图片、分镜视频和成片默认放在工作区的 `myreels-runs/`
- 不要把登录凭据或环境变量文件提交到仓库

## 开发

```bash
npm test
```

测试覆盖剧本、提示词、状态、HTTP、媒体、参考图和资产审查等模块。

## 许可

项目代码版权归项目所有者所有。使用、复制或再分发前请遵循仓库中的许可说明。
