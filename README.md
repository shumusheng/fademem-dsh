# fademem-dsh

给 [DeepSeek Harness](https://www.deepseek.com/harness)（DSH）加一层**会遗忘的记忆**和**像人的说话方式**。

装完之后，对话里的人会记住你说过的事，也会慢慢忘掉；语气从"助手"变回"人"。不用开代理、不用改 Base URL、不用第二个客户端。

> 这是 [fademem](https://github.com/shumusheng/fademem) 的 DSH 插件版。原版是给任意 OpenAI 兼容客户端用的中间层，需要配 Base URL；这一版直接挂进 DSH，装完就生效。

## 装上它

在 DSH 里打开 **插件（Plugins）**，来源选 **Git**，填：

```
https://github.com/shumusheng/fademem-dsh
```

确认框会显示仓库和 commit，装上即生效。（暂时没发 npm，填包名会找不到。）

如果 DSH 只给了命令行，等价命令是：

```bash
dsh plugin --profile desktop add "https://github.com/shumusheng/fademem-dsh"
```

然后把 `fademem-dsh` 加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组，重启 DSH。这一步没法自动，因为 profile 文件是用户自己的。

本地开发想直接挂工作区里的副本，用 `"file:D:/fademem-dsh"` 代替上面的网址。

## 配一下角色

插件配置是一段 JSON，全部可选。最小的写法：

```json
{
  "persona": {
    "name": "沈知夏",
    "relationship": "认识三个月的邻居，见过几次面，还没到交心的地步。"
  }
}
```

`relationship` 是最影响观感的字段：写"认识三个月的邻居"和写"交往两年的恋人"，同一句台词完全是两个味道。

完整字段见 [docs/DETAIL.zh.md](docs/DETAIL.zh.md)。

## 怎么确认它在工作

1. 随便说一句带事实的话：「我叫小满，我养了一只三花猫」
2. 打开 `~/.fademem/dsh-memory.json`，应该多出一条 `叫小满` 和一条 `养着三花猫`
3. 发下一句时，这些内容已经拼进系统提示了

想过几天看它忘没忘，把文件里那条记录的 `updated_at` 改早几天，再看它说话时还记不记得细节。

## 原理

记忆不是"存进去就一直在"。每条有自己的稳定性，按 Ebbinghaus 曲线衰减：

```
R = exp(-Δt / S)          S = 稳定性（天），R = 此刻还能想起来多少
S' = S × (1 + 1.5(1-R)^1.5)   被想起时强化，越模糊时想起涨得越多
```

默认 `baseStabilityDays = 6`：中等重要的新记忆半衰期约 3 天，一周后 R≈0.2（模糊），两周后基本忘了。第 7、21、60 天各被提到一次，半衰期能拉到一个月以上。

低 R 的记忆**文字本身会被磨花**：`2019年`变成`有一年`、括号里的补充消失、长句断成`……`。只打"置信度低"标签没用——模型看到标签照样把细节编得头头是道，内容残缺才编不出来。

## 这个插件依赖 DSH 的哪些接口

| 接口 | 用途 | 缺失时 |
|---|---|---|
| `ctx.systemPrompt.section()` | 每轮注入人设 + 记忆 + 说话规则 | 打一条警告，不接管，不报错 |
| `ctx.on('session/event')` | 从 `user/message` 抽事实 | 记忆不增长，人设照常注入 |

两个接口都拿不到时插件安静地什么都不做，**不会中断对话**。

## 开发

```bash
node --test tests/     # 12 个测试，纯 Node，无依赖
```

零运行时依赖，不需要构建步骤，`src/*.js` 就是发布内容。

## 局限

- 抽取靠正则，绕弯的表达会漏（"我一闻到香菜就想吐"）。宁可漏记，不乱记。
- 只从用户消息里抽事实，不从助手回复里抽。
- 说话规则是提示词约束，管不住所有模型。
- 目前不能改写模型输出（流式去腔没做），只在输入侧下手。

## License

MIT
