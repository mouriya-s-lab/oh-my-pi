# 进程治理

负责定义宿主起的每棵受管进程树怎样识别、属于哪个归属单位、CPU/IO/内存用量怎样读、何时超限，并让三个操作系统在同一套连接下互换；不负责告警的界面展示，也不负责任何活过宿主的进程。

本模块只持有子模块与业务单元共用的材料：进程与进程树的身份、归属单位身份、宿主退出保证、用量读数与告警阈值。操作系统的事实由 `platform/` 陈述，宿主内部的归属组织与告警状态由 `registry/` 陈述；两者并列，互不引用，只共用本模块的类型，由 `business/host/` 把两者接起来。

## 依据

活过宿主的进程由操作系统的服务管理器（launchd、systemd、Windows 服务）拥有：它们的父进程是服务管理器，不是宿主（来源：launchd 与 systemd 的职责定义；omp 当前用两层 fork 与 detached 起守护进程，正是上游 #5684 里"强退宿主后开发服务器仍在跑"的来源，证据见 `evidence/spawn-sites.md`、`evidence/upstream-issues.md`）。所以宿主起的进程一律随它的归属单位结束而终止，没有"放走"或"多宿主共用"这一承诺；要活过宿主，由起进程的一方向服务管理器提交声明，那是宿主之外的对象，本设计不建模。

进程号会复用，上游曾因此把宿主自己当作子进程的后代杀掉（来源：证据 `evidence/identity-and-usage.md`）。所以 ``Governance`Identity`` 由进程号加出生标记组成；一次 ``Platform`Spawn`` 起一棵受管进程树，起源进程的 ``Governance`Identity`` 就是这棵受管进程树的唯一身份，进程树身份与进程身份一样免疫进程号复用。

三个操作系统把一棵进程树圈起来的内部机制不同：Linux 用 cgroup v2，Windows 用作业对象，macOS 用 `setsid` 进程组配合继承到子进程环境里的血统标记（外层容器禁止嵌套或 macOS 的 MCP 服务器因 TCC 权限提示不能新建进程组时，平台内部退化为根进程加环境标记）（来源：证据 `evidence/platform-containment.md`、`evidence/spawn-sites.md`，上游 #4987）。这些手段在连接不变时可以互换，所以都留在 `Platform` 各平台的实现里（见 `reference/platform-implementations.md`），不向台账与业务暴露"有围栏还是无围栏"或"环境标记怎样扫描"。

Windows 的作业对象设了 `KILL_ON_JOB_CLOSE` 后，宿主怎样死亡都由内核终止全部成员；Linux 的 cgroup 与 macOS 的进程组在宿主死亡后不会自动终止成员，宿主正常退出前必须自己清理（来源：证据 `evidence/platform-containment.md`）。所以 ``Governance`Guarantee`` 把宿主退出时的清理保证分成 `<Kernel>` 与 `<Cooperative>` 两支，宿主退出前按它分支。

Windows 作业与 Linux cgroup 在成员退出后继续保留整棵树的 CPU/IO 累计用量与峰值内存，直到宿主释放容器；macOS 只能对此刻活着的成员读用量，成员退出后用量并入父进程或丢失；CPU 与 IO 是累计量，内存是瞬时量，已退出进程的内存不是任何时刻的占用（来源：证据 `evidence/identity-and-usage.md`、`evidence/platform-containment.md`）。所以 ``Governance`Reading`` 把累计量与当前内存分开，只给累计量标 ``Governance`Coverage``（`<Complete>` 含已退出成员，`<LiveOnly>` 只含此刻活着的成员），`memoryPeak` 在平台给不出时为空。

上游 #5684 与 #12961 要求记录子进程树的 CPU、内存、IO 用量并在越过阈值时告警；同一归属单位在存续期内反复派生子进程时，按单个子进程告警会造成重复刷屏（来源：证据 `evidence/upstream-issues.md`、`evidence/identity-and-usage.md`）。所以 ``Governance`Limit`` 与 ``Governance`Exceeded`` 按 CPU、IO、内存阈值判定读数是否超限，``Registry`` 按归属单位记录是否已告警，每个归属单位在存续期内至多触发一次告警。

## 为什么

身份、归属单位、退出保证、读数与阈值放在根模块：``Platform``、``Registry`` 与 ``Host`` 都用到它们，而 ``Platform`` 与 ``Registry`` 互不引用。不把 ``Registry`` 放进 ``Platform`` 之下：宿主的组织台账不是操作系统的内部细节，它只需要进程树身份与归属单位身份，不需要起进程、读用量、杀进程的连接。

用起源进程的 ``Governance`Identity`` 直接作为受管进程树的身份，不另造一个无结构的围栏令牌：一次 ``Platform`Spawn`` 对应一棵受管进程树，起源进程的 `pid + birth` 天然唯一且防复用（macOS 的进程组号本来就是组长的 `pid`），省掉一层多余句柄映射。

把 macOS 的环境标记补找与 TCC 无进程组退化封在 `Platform` 实现内部，不在导出接口上区分"围栏内进程"与"无围栏进程"：对宿主而言，每次 ``Platform`Spawn`` 都是起一棵受管进程树，收尾都是 ``Platform`Kill`` 这棵树、采样都是 ``Platform`Measure`` 这棵树。把某个操作系统的弥补手段捅到台账与业务层，会让上层同时维护两套账本并手工做集合差去重。

宿主崩溃后 `<Cooperative>` 平台上的进程树无人清理，本设计不另起监管进程：监管进程是另一个有自己生命周期的可部署物，本设计的契约只保证 `<Kernel>` 不漏、`<Cooperative>` 崩溃会漏。

## 语义

``Platform`` 的状态是操作系统的事实，``Registry`` 的状态是宿主内存里的台账；两者运行在同一个宿主进程内，宿主崩溃时台账随之消失，只有 `<Kernel>` 保证的平台仍由内核清理成员。

``Governance`Reading`` 的 `<LiveOnly>` 累计量在成员进程退出后会回落；两次取回之间出生又退出的后代进程在这种读数里不出现。
