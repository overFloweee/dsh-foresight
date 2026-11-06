# 从 dsh-suggest-ghost 迁移

dsh-foresight 取代 dsh-suggest-ghost。两者同时启用会重复注册幽灵层，所以先停用旧的，再启用新的。

## 1. 停用旧插件

在 profile 的 `cordis.patch.yml` 里停用旧条目（条目 id 以你 profile 里实际写的为准，常见为 `dsh-suggest-ghost`，本地分叉版是 `dsh-suggest-ghost-local`）：

```yaml
- id: dsh-suggest-ghost
  disabled: true
```

## 2. 安装

```bash
pnpm pack                                              # 在 dsh-foresight 仓库里
dsh plugin --profile <profile> add ./dsh-foresight-0.1.0.tgz
```

`dsh plugin add` 会把 `dsh-foresight` 写进 profile `package.json` 的 `dsh.profile.bundles`。如果 profile 是被管理的（CLI 拒绝直接修改），手工把包加到 `dependencies`，并把 `"dsh-foresight"` 追加进 `dsh.profile.bundles`。

## 3. 设置要重新填一次

条目 id 变成了 `dsh-foresight`，settings 命名空间跟着条目 id 走，旧值不会迁移。预测默认继承主会话路由，大多数人不需要改任何设置。

## 4. 数据会保留的部分

热度表和回合回顾存放在 storage 域 `suggest_ghost_hotness`、`suggest_ghost_recap`，域名没有改，新插件启用后直接继续使用。

## 回滚

把 `dsh-foresight` 条目设为 `disabled: true`，再把旧条目改回 `disabled: false`，重启即可。

## 如果你还装着 dsh-session-companion

dsh-foresight 只带了它的 ↑/↓ 召回，没有带侧栏排版、收起会话预览浮层和侧边对话。只用召回的话可以换成 dsh-foresight 并停用 `dsh-session-companion`；还在用其它三项的话，两者不能同时启用（都会处理 ↑/↓），需要二选一。
