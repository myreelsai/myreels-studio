# 安装与升级

## 1. 仓库地址

```text
https://github.com/myreelsai/myreels-studio
```

仓库已公开，可以直接匿名克隆，不需要 GitHub 登录、PAT 或 SSH。

不要提交或拷贝本机凭据文件：`auth.json`、`.secret.json`、`.env`。

## 2. 安装到当前 DSH profile

### 方式一：DSH 网络安装

在「插件管理 → 添加插件」中填写：

```text
https://github.com/myreelsai/myreels-studio
```

或：

```text
plugin_manager
  action = install_bundle
  target = https://github.com/myreelsai/myreels-studio
```

如果提示 `connection to github.com timed out`，说明网络到 GitHub 不稳定，改用本地安装。

### 方式二：克隆后本地安装

```bash
git clone https://github.com/myreelsai/myreels-studio.git
cd myreels-studio
```

建议保持固定目录，例如：

```text
D:\plugins\myreels-studio
```

然后把路径发给 agent，在会话里说：

```text
把 D:\plugins\myreels-studio 这个目录安装成 DSH 插件
```

或者：

```text
plugin_manager
  action = install_bundle
  target = <本地 myreels-studio 目录>
```

如果已经安装过旧版本，先卸载：

```text
plugin_manager
  action = remove_bundle
  target = @local/myreels-studio
```

再安装新版本。

如果出现：

```text
ERR_PNPM_EPERM rename ... node_modules\@local\myreels-studio
```

这是旧插件仍被 DSH 占用，不是 GitHub 权限问题。卸载旧版并重启 DSH 后重新安装。

## 3. 生效

安装后刷新 DSH 页面。  
代码更新后：只改了 `lib/` 或 `client.js`，`git pull` 后重启 DSH；改了 `package.json` 的依赖，才需要重新执行 `remove_bundle` + `install_bundle`。

## 4. 验证

在 DSH 会话中执行：

```text
myreels_env_check dry = true
```

确认：

- 左侧栏出现 MyReels Studio
- 打开面板能看到 run 列表
- 点击登录可以打开 MyReels 登录窗口

## 5. 升级

```bash
cd myreels-studio
git pull
```

然后重启 DSH；依赖有变化时重新安装。

## 6. 环境

插件默认已配置好服务地址，通常无需改动。

如需切换环境，请修改插件配置里的地址，并先确认已有项目数据在新环境中的位置——不同环境的存储不互通，不会自动迁移。
