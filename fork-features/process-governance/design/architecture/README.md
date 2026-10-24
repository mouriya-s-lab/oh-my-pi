# 进程治理

负责宿主起的每棵受管进程树怎样识别、在操作系统上怎样起出、读取与终止，以及它归哪个归属单位、单位怎样嵌套开闭；三个操作系统在同一套连接下互换。不负责超限阈值与告警判定（归 `business/host/`），不负责告警的界面展示，也不负责任何活过宿主的进程。

本模块只持有 ``Platform`` 与 ``Registry`` 共用的 ``Governance`Identity``；操作系统的事实由 `platform/` 陈述，宿主内部的归属台账由 `registry/` 陈述，两者互不引用，由 `business/host/` 接起来。

## 依据

进程号会被操作系统复用，上游曾因此把宿主自己当作子进程的后代杀掉（来源：上游 issue #4605、#7452，证据见附录 `evidence/identity-and-usage.md`）。所以 ``Governance`Identity`` 由进程号加出生标记组成，一次 ``Platform`Spawn`` 起出的受管进程树直接以起源进程的身份为身份。

活过宿主的进程由操作系统的服务管理器（launchd、systemd、Windows 服务）拥有，父进程是服务管理器而不是宿主；omp 当前用两层 fork 与 detached 起守护进程，正是上游 #5684 里"强退宿主后开发服务器仍在跑"的来源（证据见附录 `evidence/spawn-sites.md`、`evidence/upstream-issues.md`）。所以宿主起的每棵树都登记在一个归属单位名下，并在单位结束前释放；要活过宿主的进程由起它的一方向服务管理器声明，不在本设计里。

## 为什么

``Governance`Identity`` 放在根模块：``Platform`` 与 ``Registry`` 都用它，而两者互不引用。其余类型各归持有者：平台保证与读数是 ``Platform`` 产出的操作系统事实，``Registry`UnitId`` 由台账造出、平台不知道，阈值与读数合成只有 `business/host/` 使用。不把 ``Registry`` 放在 ``Platform`` 之下：宿主的归属台账不是操作系统的细化，它只需要树的身份，不需要起进程、读用量、终止的连接。

直接用起源进程的身份作受管进程树的身份，不另造树句柄：一次 ``Platform`Spawn`` 恰好对应一棵树，进程号加出生标记天然唯一且防复用（macOS 的进程组号本来就是组长的进程号）。

## 语义

``Platform`` 的状态是操作系统的事实，``Registry`` 的状态是宿主内存里的台账；两者运行在同一个宿主进程内，宿主崩溃时台账随之消失，只有 ``Platform`Describe`` 为 `<Kernel>` 的平台仍由内核终止成员。
