# C1–C13 cross-host acceptance matrix — verbatim from RFC §10.3

Source: [RFC #1](https://github.com/mouriya-s-lab/oh-my-pi/issues/1), §10.3.
The table below is copied verbatim; only this file's bindings section and the
per-row `Status` field are harness additions. `R` = actually created remote
peer, `S` = actual local/another-remote peer, `J` = actual job (output
bindings, not reusable aliases). `hub(...)` is the native tool call shape,
not a shell command.

| # | Dimension | 覆盖结果 / 操作序列 | Command / 原生入口 | Env | Expect | Status |
|---|---|---|---|---|---|---|
| C1 | integration | R1/R2：由 task、eval agent、workpool 分别创建远端执行单元 | D1 的 `target:{kind:"ssh",host:H,cwd:C}` 调用（待实现，H/C 来自真实环境）；随后 `hub({op:"jobs"})` 与 `hub({op:"list"})` | 本机 + 两个远端进程 | 远端进程就是本机 peer；没有要求远端再 task 一次；三种入口的身份/进度可见。 | BLOCKED |
| C2 | integration | R3：父代理发给 R，R 原生 hub 回父代理；S 与 R 互发 | `hub({op:"send",to:R,message:"irc-direct-marker",await:true})`；对端实际调用 `hub send` 回复 | 本机父级 + 本地同级 + 两个远端 | 收到真实回复而非 ACK；原始消息/回复元数据正确，所有方向都执行。 | BLOCKED |
| C3 | integration | R4：列表与广播跨本地/远端；不唤醒所有 parked | `hub({op:"list"})`；`hub({op:"list",status:"parked"})`；`hub({op:"send",to:"all",message:"irc-broadcast-marker"})` | 同时有 running/idle/parked peer | 可见范围与逐目标回执正确，无重复 Main 展示和越界投递。 | BLOCKED |
| C4 | integration | R4：busy-parent、busy-sibling、idle、idle/streaming plan mode、已有 waiter 分别投递 | 上述实际 sender 执行同一 `hub send`；收件端 `hub({op:"wait",from:S,timeoutMs:10000})` | 对应真实状态分别建立，不靠内部赋值伪造 | 父/同级优先级不同；普通 idle 可唤醒；idle plan 不自动唤醒，streaming plan 保留原投递路径；waiter 消费不重复注入。 | BLOCKED |
| C5 | integration | R4：inbox peek/drain、from 过滤、await 超时和取消 | `hub({op:"inbox",peek:true})`；`hub({op:"inbox"})`；`hub({op:"wait",from:S,timeoutMs:10000})`；原生取消入口 | 可控消息来源和真实等待状态 | 只消费应消费的消息；超时/取消不变成成功；没有重复 mailbox 副本。 | BLOCKED |
| C6 | assumption | R4/R5：终态后仍有回复义务、wake relay 与主动回复去重 | 实际 `hub send` + `await:true`；对端原生回复及唤醒流程 | 对端分别进入正常结束、临时回复、唤醒回复 | 不抢先报停止未回复；replyTo/wakeRelay 保留；无双发和 relay 循环。 | BLOCKED |
| C7 | integration | R2/R5：workpool 后续轮次、agent handle send/wait、复用 | 创建返回的原生 handle 与 workpool 操作；后续回复用 `hub send`/历史观察，不重复等待旧 job | keep-alive pool 首次 drain 之前追加工作；agent 首轮已完成且可交互；另测 freshAgents 策略 | 不切回本机，按配置复用或新建；初次 job 与后续回复不混淆，结果消费语义保持。 | BLOCKED |
| C8 | integration | R5/R9：job cancel、等待取消、hard-abort、parked 恢复 | `hub({op:"cancel",ids:[J]})`；对明确可恢复的 R 发原生消息；实际生命周期入口 | 执行中/等待中/parked/aborted 分别建立 | 取消回执与远端真实停止相符；hard-aborted 不伪装可恢复；遵守作业所有权。 | BLOCKED |
| C9 | environment | R5/R8：断线前后未知投递与进程状态 | 对测试连接分别关闭 stdin、终止 transport、阻断心跳；原生 status/wait/查看及远端终态核对 | 隔离验证连接，不能断操作员业务 SSH | 按 D4 区分 EOF、取消、lease 失效与 unknown，不隐式重放；恢复不产生双实例。 | BLOCKED |
| C10 | environment | R6：远端配置独立、文件和会话仍在远端 | 同一原生入口执行能体现远端工具/模型/规则差异的已登记任务；核对两端文件/状态 | D1 记录的真实配置差异和目录 | 采用远端行为，本机工作区无对应副作用；不复制配置和 session 文件。 | BLOCKED |
| C11 | assumption | R7：版本不同但所需能力兼容；缺能力明确拒绝 | 两组已登记版本执行 C1–C8；一组缺能力端尝试接入 | 实际独立安装的版本组合 | 兼容组合通过；不兼容组合可诊断失败，没有自动同步或静默降级。 | BLOCKED |
| C12 | integration | R5/R10：结构化结果、错误、历史/资源、交互、显式参数 | 按 D6 参数表与 D7 资源/UI 契约执行 task/eval/workpool/Agent Hub 调用 | 正常、错误、交互待答及参数边界 | 每项参数契约可观察；资源归属正确；不会挂起或靠忽略参数过关。 | BLOCKED |
| C13 | function | R9：未选择远程的原生本地路径 | 原有 task/eval/workpool/hub 真实使用路径 | 本机原有配置 | 不改变本地行为、权限、消息投递和结果交付。 | BLOCKED |

## Runtime bindings (fill at run time — all currently unbound)

- `R1=<remote-peer-id-1>` — first remote OMP process as local peer.
- `R2=<remote-peer-id-2>` — second remote OMP process as local peer.
- `R3=<remote-peer-id-for-irc>` — remote peer under IRC test (may equal R1).
- `S=<local-or-second-remote-peer-id>` — local sibling or the other remote.
- `J=<job-id>` — actual job under cancel/lifecycle test.
- `H=<ssh-host>, C=<remote-cwd>` — D1 target binding per remote.

## Anti-shortcut rule (verbatim from RFC §10.3)

下列证据均不足以关闭实现：只有 SSH exit=0；只有 ready；只有 prompt ACK；
只收到第一条 agent_end；只检查最终文本；只测父向子单向消息；用本地 mock
bus 代替跨端 IRC；只测 task 而不测 eval/workpool；只测同版本；只运行类型
检查/单元测试；让远端禁用插件或放宽审批才通过。
