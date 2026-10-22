# 三个平台把一棵进程树圈起来的能力

证据来源：Linux 内核 cgroup v2 文档；微软文档 Job Objects、Nested Jobs、`JOBOBJECT_ASSOCIATE_COMPLETION_PORT`、`JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION`；上游 issue #5684 里 @comicchang 在 macOS 上的实测；2026-10-22 在 macOS 上的本地实测。只作依据的证据，不设立规则。

| 能力 | Linux cgroup v2 | Windows 作业对象 | macOS |
|---|---|---|---|
| 子进程自动继承、不能自行离开 | 是；`setsid`、两层 fork 都逃不出 cgroup | 是；`DETACHED_PROCESS`、`CREATE_NEW_PROCESS_GROUP` 都逃不出作业，只有作业允许脱离（`JOB_OBJECT_LIMIT_BREAKAWAY_OK`）且创建时指定脱离才能离开 | 否；进程组可被 `setsid`/`setpgid` 离开，父子关系在父进程退出后断裂 |
| 宿主死亡（含崩溃、被强杀）后成员的命运 | 成员留在 cgroup 里，要有人写 `cgroup.kill`；宿主之外没有持有者就无人清理 | 设了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的作业，最后一个句柄关闭时内核终止全部成员，嵌套子作业一起终止；宿主怎么死都会关闭句柄 | 没有机制；无 `PR_SET_PDEATHSIG`，无 subreaper；要在宿主之外另起监管进程 |
| 新成员加入时的通知 | 无推送；读 `cgroup.procs` | 关联 IO 完成端口后收到 `JOB_OBJECT_MSG_NEW_PROCESS`，带 pid；文档说明这类消息不保证送达 | 无；只能轮询进程表 |
| 列出成员 | 读 `cgroup.procs` | `QueryInformationJobObject(JobObjectBasicProcessIdList)` | `proc_listpids(PROC_PGRP_ONLY, pgid)` 只能按进程组；`proc_listchildpids` 查自己的子进程在 darwin 25.4 上损坏，宿主已改为扫 `proc_listallpids` 再按 ppid 分组 |
| 整组资源累计（含已退出成员） | `cpu.stat`、`memory.current`、`io.stat`，含已退出成员 | `JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION`：CPU 时间与 IO 计数累计，峰值提交内存 | 没有组级累计；只能对活着的进程逐个读 |
| 只通知不杀的阈值 | `memory.events`（high/max 计数）配合 `memory.high` | `JobObjectNotificationLimitInformation`：超阈值发 `JOB_OBJECT_MSG_NOTIFICATION_LIMIT`，进程继续运行；文档说明这类通知保证送达 | 没有 |
| 强制上限 | `memory.max`、`cpu.max`、`io.max` | 作业级与单进程的提交内存上限、CPU 速率、IO 速率 | 不可行：launchd 单任务内存限制能解析但不生效（设 512 MB，实际分配到 1.6 GB 无事）；起进程前设地址空间或数据段 rlimit 使目标 `exec` 失败（EINVAL） |
| 嵌套 | 子 cgroup 需要父 cgroup 把控制器委托下来 | Windows 8 起支持嵌套作业，但外层作业禁止嵌套或脱离时创建失败；宿主常跑在终端或 IDE 已创建的作业里 | 不适用 |
| 宿主自身所在的组 | 宿主可以把自己放进专属 cgroup，之后所有子进程自动继承 | 宿主可以把自己放进专属作业，之后所有子进程自动继承 | 宿主所在的进程组可能与其他程序共用（见 `spawn-sites.md`），不能按整组归属 |

macOS 的补充实测：用环境变量标记（`OMP_OWNER=<pid>:<启动时间>`）让后代继承，再经 `KERN_PROCARGS2` 读回时，Homebrew 安装的 Python 能读到标记与 `PATH`；Apple 系统自带的 `/bin/sleep` 只返回程序名与参数，没有环境变量段。环境变量标记因此只能补充找回逃逸的后代，不能作为唯一的归属依据。

macOS 的内存读数：#5684 里实测一个进程常驻内存 29 MB 而 `phys_footprint` 1.1 GB；Windows 上资源耗尽事件（Event 2004）报的是虚拟内存或提交内存耗尽（单进程 101–115 GB 虚拟内存）。
