# 三个平台怎样兑现 Platform 连接

实现参考：换一种机制兑现同一个连接时，``Platform`` 的连接与不变量都不变，所以这些做法属于实现，不写进设计。能力值的依据见 `evidence/platform-containment.md`。

| 连接 | Linux | Windows | macOS |
|---|---|---|---|
| ``Platform`Describe`` | `<Cooperative>`（宿主之外没有持有者时无人写 `cgroup.kill`） | `<Kernel>`（作业对象设 `KILL_ON_JOB_CLOSE`） | `<Cooperative>` |
| ``Platform`Spawn`` | 起根进程并记下 `Identity = (pid, starttime)`；在委托给宿主的 cgroup 下建以该身份命名的子 cgroup 并 `CLONE_INTO_CGROUP`，同时在环境里写入 `OMP_TREE=<pid>:<starttime>` 作为无 cgroup 委托环境下的退化血统标记 | 起根进程（挂起）并持有句柄与创建时间构成 `Identity`；新建设了 `KILL_ON_JOB_CLOSE` 的作业对象并放入该进程后恢复；外层作业禁止嵌套时退化为在环境里写入 `OMP_TREE=<pid>:<creation_time>` | 起根进程并记下 `Identity = (pid, pbi_start_tvsec/usec)`；默认 `setsid` 使该进程成为进程组长（`pgid = pid`），并在环境里写入 `OMP_TREE=<pid>:<start>`；因 TCC 不能新建进程组的程序（如 MCP stdio 服务器）不调 `setsid`，只靠根身份加 `OMP_TREE` 环境标记识别整棵树 |
| 平台内部怎样确定 `members(tree)` | 有子 cgroup 时读 `cgroup.procs`；退化时扫 `/proc/*/environ` 匹配 `OMP_TREE` | 有作业对象时调 `QueryInformationJobObject(JobObjectBasicProcessIdList)`；退化时匹配环境块里的 `OMP_TREE` | `proc_listpids(PROC_PGRP_ONLY, tree.pid)` 列出进程组成员（核对启动时间），再并上 `KERN_PROCARGS2` 里带 `OMP_TREE` 标记的进程，使 `setsid` 脱离进程组或未建进程组的后代仍归入同一棵 `tree` |
| ``Platform`Measure`` | 有子 cgroup 时树在 `dom charged` 里：`cpu.stat`、`io.stat` 为 `<Complete>` 累计，`memory.current` 为此刻内存，`memory.peak` 为峰值；退化时对活成员读 `/proc/<pid>/{stat,io,status}` 求和，标 `<LiveOnly>` | 有作业对象时树在 `dom charged` 里：`JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION` 为 `<Complete>` 累计，各活成员提交内存之和为此刻内存，作业峰值提交内存为峰值；退化时对活成员求和，标 `<LiveOnly>` | 树不在 `dom charged` 里：对 `members(tree)` 逐个调 `proc_pid_rusage`（`ri_user_time + ri_system_time`、`ri_diskio_bytesread/written`、`ri_phys_footprint`）求和，标 `<LiveOnly>`，峰值为空 |
| ``Platform`Kill`` | 有子 cgroup 时写 `cgroup.kill` 并 rmdir；退化时对 `members(tree)` 核对 starttime 逐个 `kill` | 有作业对象时 `TerminateJobObject` 并关闭句柄；退化时对持有的成员句柄逐个 `TerminateProcess` | 对进程组 `kill(-tree.pid, SIGTERM)` 等待后 `SIGKILL`，并对 `members(tree)` 中已离开进程组的成员核对 `pbi_start_tvsec/usec` 逐个终止，最后从宿主树表移除 |

## 活过宿主的进程

本设计不让宿主代为起任何活过宿主的进程。当前 omp 里有三类这样的起法，迁移时都要改：

| 当前做法 | 应改为 |
|---|---|
| brush 对 `nohup cmd &` 走 `setsid` 加两层 fork，并刻意不上报 | 仍在它所属的受管进程树里，随归属单位结束而终止；要活过宿主的服务由用户向 launchd（plist）、systemd（unit）或 Windows 服务管理器声明 |
| launch broker、LSP mux、blob broker、共享浏览器以 detached 且 unref 起，按剩余客户端自行退出 | 作为服务管理器管理的用户级服务安装，宿主只连接，不起 |
| Python eval 内核与 JS eval 子进程以 detached 起 | 经 ``Platform`Spawn`` 作为受管进程树起，随会话单位结束而终止 |
