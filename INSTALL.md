# 安装与升级

## 1. 获取代码

```bash
git clone <repository-url> myreels-studio
```

建议保持固定目录，例如：

```text
~/plugins/myreels-studio
```

不要提交或拷贝本机凭据文件：`auth.json`、`.secret.json`、`.env`。

## 2. 安装到当前 DSH profile

最省事的做法是把路径发给 agent，在会话里直接说：

```text
把 D:\plugins\myreels-studio 这个目录安装成 DSH 插件
```

（换成你自己 clone 的位置，用本机绝对路径。）或者自己在会话中调用：

```text
plugin_manager
  action = install_bundle
  target = <本地 myreels-studio 目录>
```

如果已经安装过旧版本：

```text
plugin_manager
  action = remove_bundle
  target = @local/myreels-studio
```

再执行一次安装。

## 3. 生效

安装后刷新 DSH 页面。  
代码更新后：只改了 `lib/` 或 `client.js`，`git pull` 后重启 DSH 即可；改了 `package.json` 的依赖，才需要重新执行 `remove_bundle` + `install_bundle`。

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

然后重新安装或重启 DSH。

## 6. 环境

插件默认已配置好服务地址，通常无需改动。

如需切换环境，请修改插件配置里的地址，并先确认已有项目数据在新环境中的位置——不同环境的存储不互通，不会自动迁移。
