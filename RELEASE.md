# 发布指南（维护者自己看）

本目录 `publish/dsh-Session-Turncate/` 是可以直接推到 GitHub 的完整仓库内容：代码、测试、README、LICENSE 齐全，不含本机路径、临时文件与调试脚本。

## 0. 三条硬约束先记住

| 事项 | 说明 |
| --- | --- |
| 包名必须小写 | npm 不接受新包的大写名，因此 `package.json` 的 `name` 是 `dsh-session-turncate`；`displayName`、README 标题、GitHub 仓库名用 `dsh-Session-Turncate`。三处引用（`package.json` name、`cordis.patch.yml` 的 `name:`、`client.js` 的 `__ModuleLoader__.load({ id })`）必须写成同一个字符串。 |
| 仓库必须有 `dsh.bundle` 清单 | 只写 `dsh.client` 的仓库无法安装，这是榜单最常见的拒稿原因。本仓库已同时声明 `dsh.bundle.patch` 与 `dsh.client`。 |
| 仓库创建满 1 天才能收录 | CI 自动校验，刚建几分钟就提 PR 会被拒；作完功能再提即可，重提不影响。 |

## 1. 推到 GitHub

在 GitHub 新建仓库 **`L7X6899/dsh-Session-Turncate`**（Public，不要勾选自动生成 README），然后在 `publish/dsh-Session-Turncate/` 里：

```sh
git init -b main
git add -A
git commit -m "feat: per-session idle-time context truncation 0.1.1"
git remote add origin https://github.com/L7X6899/dsh-Session-Turncate.git
git push -u origin main
```

推完给仓库加 **`dsh-plugin`** topic（仓库首页 ⚙️ → Topics）。这一项是收录的硬要求。

## 2. 先在本地验证别人装得上

```sh
dsh plugin --profile desktop add github:L7X6899/dsh-Session-Turncate
```

装完重启 DSH，会话上方应出现「上下文截断」选项卡。确认无误再发版。

## 3. 发布到 npm（可选，但强烈建议）

走了 npm，插件市场的安装速度从「下载整个仓库」变成「装一个 tarball」，几秒钟就好；市场也会优先选 npm 源。

```sh
cd publish/dsh-Session-Turncate
npm publish --access public
```

发版前先确认：

- `npm whoami` 是你自己的账号；
- `package.json` 的 `version` 已递增（`0.1.1` → 下一次改完升到 `0.1.2`）；
- `files` 已经限定为 `lib`、`client.js`、`cordis.patch.yml`、`README.md`，`test/` 不会进包（这也是 `npm pack --dry-run` 会看到的清单）。

之后每次发版：

```sh
npm version patch            # 或 minor/major，会同时打 git tag
git push && git push --tags
npm publish
```

## 4. 上架插件市场（dshmarket）

**市场本身不收条目。** 列表来自精选榜单 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，一份数据一个文件，README 由脚本生成、不要手改。

给那个仓库提一个 PR，**只加一个文件**：

```
data/plugins/L7X6899__dsh-Session-Turncate.yml
```

内容是（本目录旁边的 `submission/L7X6899__dsh-Session-Turncate.yml` 已经写好，直接复制）：

```yaml
url: https://github.com/L7X6899/dsh-Session-Turncate
name: L7X6899/dsh-Session-Turncate
category: session
description:
  en: One-line description ending with a period.
  zh: 一句话描述，以句号结尾。
```

几条会被评审看的点：

- `category` 选贴合实际功能的分类。本插件是会话上下文管理，用 `session`；可选值还包括 `ui` `tools` `workflow` `dev` `memory` `remote` 等。
- 描述**只说功能、不吹**，且必须与代码一致（评审会对着代码核对你写的命令、接口、数字）。
- 只有 `description.en` 必填；中文写不了可以留空，维护者会补。
- 描述里出现 `: `（半角冒号加空格）必须加引号，否则 YAML 解析失败。
- PR 合并后榜单 README 由 CI 在 `main` 上重新生成，通常一天内市场上就能搜到。

## 5. 市场里怎么装

上架后，在 DSH 的 **插件 → 插件市场** 搜 `Turncate`（或插件市场 → 安装），也可以直接：

```sh
dsh plugin --profile desktop add dsh-session-turncate
```

若宿主较旧没有市场页，可在 **插件 → 发现 → 索引源** 添加：

```
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

## 6. 以后改代码时的同步关系

本地开发副本与发布副本分开存放时，改动后同步这五个文件（其余不动；命令里的两个路径按你本机实际情况替换）：

```sh
cp dsh-session-truncate/package.json dsh-session-truncate/cordis.patch.yml \
   dsh-session-truncate/client.js dsh-session-truncate/README.md \
   publish/dsh-Session-Turncate/
cp dsh-session-truncate/lib/index.js publish/dsh-Session-Turncate/lib/
```

开发副本里的测试脚本改名放在发布副本的 `test/{truncate,receipt,fixes,api}.mjs`，`import` 路径指向 `../lib/index.js`。同步脚本时记得保留这个差异，否则发布副本跑不起来。