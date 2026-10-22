# 三个平台怎样兑现 Platform 连接

实现参考：换一种机制兑现同一个连接时，``Platform`` 的连接与不变量都不变，所以这些做法属于实现，不写进设计。能力值的依据见 `evidence/platform-containment.md`。

| 连接 | Linux | Windows | macOS |
|---|---|---|---|
| ``Platform`Describe`` | guarantee `<Cooperative>`（宿主之外没有持有者时无人写 `cgroup.kill`），contained 真 | guarantee `<Kernel>`，contained 真 | guarantee `<Cooperative>`，contained 假 |
| ``Platform`Spawn`` 要围栏 | 在委托给宿主的 cgroup 下 mkdir 一个子 cgroup，`CLONE_INTO_CGROUP` 起进程；委托不存在时退回不要围栏 | `CreateJobObject` 并设 `KILL_ON_JOB_CLOSE`，挂起方式起进程，`AssignProcessToJobObject` 后恢复；宿主所在作业禁止嵌套时退回不要围栏 | 起进程时 `setsid`，围栏即它的进程组号（brush 对每个外部命令已经这样做） |
| ``Platform`Spawn`` 不要围栏 | 起在宿主自己的 cgroup 里 | 不建作业；宿主自己在作业里时子进程继承那个作业，不是围栏 | 起在宿主的进程组里（macOS 的 MCP 服务器） |
| ``Platform`Spawn`` 盖单位身份 | 环境变量 `OMP_UNIT=<unit>` | 同左 | 同左 |
| ``Governance`Identity.birth`` | `/proc/<pid>/stat` 的 starttime | 进程创建时间，起进程时持有句柄 | `proc_pidinfo(PROC_PIDTBSDINFO)` 的 `pbi_start_tvsec/usec` |
| ``Platform`Members`` | 读 `cgroup.procs` | `QueryInformationJobObject(JobObjectBasicProcessIdList)` | `proc_listpids(PROC_PGRP_ONLY, pgid)`，每个 pid 再读启动时间构成身份 |
| ``Platform`Marked`` | 扫 `/proc/*/environ` | 读各进程环境块 | `proc_listallpids` 后对每个 pid `KERN_PROCARGS2`；Apple 系统自带程序读不到环境段 |
| ``Platform`ProbeAll`` | `/proc/<pid>/stat`、`/proc/<pid>/io`、`/proc/<pid>/status` | `GetProcessTimes`、`GetProcessIoCounters`、`GetProcessMemoryInfo` | `proc_pid_rusage`：`ri_user_time + ri_system_time`、`ri_diskio_bytesread/written`、`ri_phys_footprint` |
| ``Platform`Measure`` | 围栏在 `dom charged` 里：`cpu.stat`、`io.stat` 为 `<Complete>` 累计，`memory.current` 为此刻，`memory.peak` 为峰值 | 围栏在 `dom charged` 里：`JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION` 为 `<Complete>` 累计，各成员提交内存之和为此刻，作业峰值提交内存为峰值 | 围栏不在 `dom charged` 里：对此刻活着的成员逐个 `proc_pid_rusage` 求和，标 `<LiveOnly>`，峰值为空 |
| ``Platform`Terminate`` | 先核对 starttime 再 `kill` | 用起进程时持有的句柄 `TerminateProcess` | 先核对 `pbi_start_tvsec/usec` 再 `kill` |
| ``Platform`Kill`` | 写 `cgroup.kill`，然后 rmdir 释放围栏 | `TerminateJobObject`，然后关闭作业句柄释放围栏 | `kill(-pgid, SIGTERM)`，等待后 `SIGKILL`，然后从宿主围栏表移除 |

## 活过宿主的进程

本设计不让宿主代为起任何活过宿主的进程。当前 omp 里有三类这样的起法，迁移时都要改：

| 当前做法 | 应改为 |
|---|---|
| brush 对 `nohup cmd &` 走 `setsid` 加两层 fork，并刻意不上报 | `nohup` 起的进程仍在它所在的围栏里，随单位结束终止；要活过宿主的服务由用户向 launchd（plist）、systemd（unit）或 Windows 服务管理器声明 |
| launch broker、LSP mux、blob broker、共享浏览器以 detached 且 unref 起，按剩余客户端自行退出 | 作为服务管理器管理的用户级服务安装，宿主只连接，不起 |
| Python eval 内核与 JS eval 子进程以 detached 起 | 以 ``Platform`Spawn`` 要围栏起，随会话单位结束而终止；用户代码里 `start_new_session=True` 在 Linux/Windows 上不再能离开围栏，macOS 上离开后仍带单位身份 |

## 未决的实现问题

Windows 上宿主自己常处于终端或 IDE 的作业里，能否嵌套取决于外层；不能时所有进程都无围栏，只能按身份逐个终止，宿主崩溃后无保证。Linux 上 cgroup 委托在容器与 CI 里常常不存在，同样退回无围栏。
