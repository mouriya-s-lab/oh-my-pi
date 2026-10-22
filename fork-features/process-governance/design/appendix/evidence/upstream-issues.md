# 上游对这个问题的讨论

证据：2026-10-22 检索 can1357/oh-my-pi 的 issue 与 PR。只作依据的证据，不设立规则。

| 编号 | 状态 | 内容 | 与本设计的关系 |
|---|---|---|---|
| #5684 | open，proposal | 要求给 agent 起的整棵进程树加内存、进程数、CPU、输出量、运行时长上限，超限杀整棵树并报告超的是哪项 | 同一问题。维护机器人确认宿主没有任何 cgroup、`setrlimit` 或作业对象，起进程的地方分散、无统一包装层；建议先做平台无关的观测，强制限制放第二步 |
| #12961 | open，proposal | 宿主自身的 bun 进程 3 分钟内涨到 98.6 GiB 被 jetsam 杀掉 | 维护者同意"每个进程启动时登记 PID + 启动时间 + 角色，外加低频内存采样"，强制限制推回 #5684 |
| #13192 | open，与 main 冲突 | 只做 Linux：`--tool-cgroup` 把工具进程放进委托的 cgroup v2 子组，逐个包装约 60 处起进程的地方，给 brush 加 `SpawnPlacement` 钩子 | review 指出逐个包装会让新增的 `Bun.spawn` 悄悄漏掉，建议统一经 `ptree` |
| #12631 / #12637 | issue open；PR closed 未合并 | Python eval 内核多天会话涨到约 36 GB；PR 想加 `python.maxRssMb`，每个 cell 后用 `ps` 采样，超限重启内核 | 维护者意见：默认阈值下丢弃用户数据的策略需要拍板 |
| #10537 | closed | Windows 上宿主被 `taskkill /F` 后 IPC worker 一直活着（父进程号变成 0） | 上游给 worker 加了父进程看门狗线程；报告者建议的作业对象加 `KILL_ON_JOB_CLOSE` 未采纳。看门狗只管宿主自己的 worker，worker 起的孙进程照样成为孤儿 |
| #14853 / #14875 | issue open；PR open | `cd x && nohup bash -c … &` 下最外层 shell 被杀、后代成为孤儿 | 进程生命周期问题 |
| #4987 | — | macOS 上 MCP stdio 服务器脱离会话后 TCC 不再弹 Apple Events 权限提示 | 宿主因此刻意不给 MCP 服务器分组 |

#5684 里 @lucas45529 的 macOS 案例：`nohup … &` 起的 Node 后代成为孤儿，多个合计把机器拖死，强退宿主后开发服务器仍在跑。

上游没有人提过的两个本地实测结果：每次 `nohup cmd &` 在宿主名下留一个僵尸进程；JS eval cell 超时被强杀时只杀 worker 进程，不清它的进程组。
