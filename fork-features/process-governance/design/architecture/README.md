# 平台

负责用同一套连接表达三个操作系统圈住一棵进程树、识别进程、读资源用量与终止进程的能力，并如实报告每种能力能保证到什么程度；不负责决定哪些进程属于谁、谁该在什么时候结束，也不负责告警。

## 依据

宿主只在自己起进程的那一刻能拿到子进程的身份；eval 里用户代码起的子进程、shell 里两层 fork 留下的孤儿，宿主拿不到起进程事件（来源：证据 `evidence/spawn-sites.md`）。所以归属不能只靠登记，``Platform`Capability`` 要说明围栏能否自动收纳后代，``Registry`Membership`` 区分宿主亲手起的、围栏收纳的与推断出来的。

进程号会复用，上游曾因此把宿主自己当作子进程的后代杀掉（来源：证据 `evidence/identity-and-usage.md`）。所以 ``Platform`Identity`` 由进程号加出生标记组成，每个连接都按这个身份操作。

Linux 的 cgroup 与 Windows 的作业对象让后代自动加入且不能自行离开，Windows 还由内核保证宿主死亡后终止全部成员；macOS 没有这类容器，进程组可以被离开，宿主崩溃后没有机制清理，也无法强制上限（来源：证据 `evidence/platform-containment.md`）。所以围栏的能力写成 ``Platform`Capability``，由使用方按能力分支；``Platform`Guarantee`` 把"宿主死后成员的命运"分成内核保证、宿主配合与无保证三支。

宿主所在的进程组可能与其他程序共用（来源：证据 `evidence/spawn-sites.md`）。所以围栏必须是宿主自己开出来的，``Platform`Open`` 开不出来时返回不可用，使用方只能退回推断。

共用的守护进程服务多个宿主，`nohup` 起的进程必须活过宿主的收尾，而 macOS 上的 MCP 服务器因权限提示必须留在宿主的组里（来源：证据 `evidence/spawn-sites.md`、`evidence/upstream-issues.md`）。所以起进程的一方要给出 ``Registry`Policy``，承诺不随归属单位结束的进程不得进入会被整体终止的围栏。

macOS 只能对活着的进程读用量，进程退出后用量并入父进程或丢失；Windows 作业与 Linux cgroup 的累计含已退出成员（来源：证据 `evidence/identity-and-usage.md`）。所以 ``Platform`Capability.aggregate`` 说明围栏的读数是否完整，读数的使用方必须区分完整与只含活着的。

上游 #5684 要求对整棵进程树限制资源，#12961 的维护者把观测与强制分开，先做登记与低频采样（来源：证据 `evidence/upstream-issues.md`）。所以本设计只定义归属、生命周期与计量的连接，强制上限留给 ``Platform`Capability.enforce`` 为真的平台之后扩展。

## 为什么

身份、围栏、用量与终止放在同一个根模块，因为它们是操作系统给出的同一组事实，三个平台各自实现这一个模块就互换。不把三个平台写成三个模块：使用方要按能力分支，不按平台名分支，新平台或同一平台的新机制只改能力值。

围栏不区分"进程组、cgroup、作业对象"，只报告 ``Platform`Capability`` 的五项能力：成员是否只可能是自己的（`exclusive`）、成员能否离开（`inescapable`）、宿主死后的保证、读数是否完整、能否强制。macOS 上宿主自己 `setsid` 开出的进程组是 `exclusive` 而非 `inescapable`：外人不能加入同一会话的进程组，所以成员一定是自己的，但成员可以再 `setsid` 离开。

不把"杀整棵树"交给使用方自己遍历：``Platform`Kill`` 以围栏为单位终止成员，宿主死后的命运由 ``Platform`Guarantee`` 说明，使用方不自己猜。

## 语义

``Platform`` 的状态是操作系统的事实：哪些进程活着、每个围栏里有谁、已退出成员留下的累计用量。进程可以在任何连接之外出生或退出；`inescapable` 的围栏里，成员的后代出生即成为成员。

``Platform`Guarantee`` 只说宿主死亡后的事：`<Kernel>` 时宿主无论怎样死亡，内核都终止围栏全部成员；`<Cooperative>` 时宿主正常退出前必须自己对每个围栏调用 ``Platform`Kill``，崩溃后成员无人清理；`<None>` 时没有清理。

``Platform`Open`` 在宿主已经处于外层容器（终端、IDE 或桌面应用开的作业或 cgroup）时可能不可用；不可用不是失败，使用方按无围栏继续。

``Platform`Measure`` 与 ``Platform`ProbeAll`` 的读数是取回那一刻的副本；两次取回之间出生又退出的进程在只含活着成员的读数里不出现。
