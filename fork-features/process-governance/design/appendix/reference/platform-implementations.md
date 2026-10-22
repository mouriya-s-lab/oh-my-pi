# 三个平台怎样兑现 Platform 连接

实现参考：换一种机制兑现同一个连接时，``Platform`` 的连接与不变量都不变，所以这些做法属于实现，不写进设计。能力值的依据见 `evidence/platform-containment.md`。

| 连接 | Linux | Windows | macOS |
|---|---|---|---|
| ``Platform`Open`` | 在委托给宿主的 cgroup v2 下建子 cgroup；宿主自己先进入专属 cgroup，之后子进程自动继承 | 建作业对象并设 `KILL_ON_JOB_CLOSE`，宿主自己先进入专属作业；外层作业禁止嵌套时返回 `<Unavailable>` | 起一个 `setsid` 的进程组组长，围栏即它的进程组号；宿主自己所在的组不能当围栏 |
| ``Platform`Capability`` | exclusive、inescapable、aggregate、enforce 为真；guarantee 为 `<Cooperative>`（宿主之外没有持有者时无人写 `cgroup.kill`） | 五项为真，guarantee 为 `<Kernel>` | exclusive 为真，inescapable、aggregate、enforce 为假，guarantee 为 `<Cooperative>` |
| ``Platform`Spawn`` 在围栏外 | `CLONE_INTO_CGROUP` 指向宿主之外的 cgroup，或起后写回父 cgroup | 作业开 `BREAKAWAY_OK`，起进程时带 `CREATE_BREAKAWAY_FROM_JOB` | 起进程时 `setsid`，不加入围栏的进程组 |
| ``Platform`Members`` | 读 `cgroup.procs` | `QueryInformationJobObject(JobObjectBasicProcessIdList)` | `proc_listpids(PROC_PGRP_ONLY, pgid)`，每个 pid 再读启动时间构成身份 |
| ``Platform`Identity.birth`` | `/proc/<pid>/stat` 的 starttime | 进程创建时间，登记时持有句柄 | `proc_pidinfo(PROC_PIDTBSDINFO)` 的 `pbi_start_tvsec/usec` |
| ``Platform`ProbeAll`` | `/proc/<pid>/stat`、`/proc/<pid>/io`、`/proc/<pid>/status` | `GetProcessTimes`、`GetProcessIoCounters`、`GetProcessMemoryInfo` | `proc_pid_rusage`：`ri_user_time + ri_system_time`、`ri_diskio_bytesread/written`、`ri_phys_footprint` |
| ``Platform`Measure`` | `cpu.stat`、`io.stat`、`memory.current` | `JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION` 加各成员提交内存 | 对成员逐个 `proc_pid_rusage` 求和 |
| ``Platform`Terminate`` | 先核对 starttime 再 `kill` | 用登记时持有的句柄 `TerminateProcess` | 先核对 `pbi_start_tvsec/usec` 再 `kill` |
| ``Platform`Kill`` | 写 `cgroup.kill` | `TerminateJobObject` | `kill(-pgid, SIGTERM)`，等待后 `SIGKILL` |
| ``Platform`Close`` | 删除空的 cgroup 目录 | 关闭作业句柄 | 进程组随最后一个成员退出而消失，无需动作 |

可选的 macOS 补充：宿主把 `OMP_OWNER=<pid>:<出生标记>` 放进环境，经 `KERN_PROCARGS2` 读回，用来向 ``Registry`Observe`` 报告离开了进程组的后代；Apple 系统自带的程序读不到环境变量段，所以这只是补充。

未决的实现问题：Windows 与 Linux 上让宿主自己进入专属容器要在宿主启动最早期完成；共用的守护进程必须经围栏外的 ``Platform`Spawn`` 起，否则随第一个宿主一起终止；bash 工具里 `nohup` 的两层 fork 当前不上报，需要补上报并以 `<Released>` 登记。
