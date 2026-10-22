# 进程治理

负责定义宿主起的进程怎样识别、怎样圈住、属于谁、承诺活多久、用量怎样读，并让三个操作系统在同一套连接下互换；不负责阈值、告警与保留历史，也不负责决定某个具体业务里一个进程该用哪种承诺。

本模块只持有两个子模块共用的材料：进程身份、围栏与它的能力、用量读数。操作系统的事实由 `platform/` 陈述，谁属于谁由 `registry/` 陈述；两者并列，互不引用，只共用本模块的类型。

## 依据

宿主只在自己起进程的那一刻能拿到子进程的身份；eval 里用户代码起的子进程、shell 里两层 fork 留下的孤儿，宿主拿不到起进程事件（来源：证据 `evidence/spawn-sites.md`）。所以归属不能只靠登记：``Platform`Members`` 与 ``Platform`Related`` 让宿主事后发现进程，``Registry`Membership`` 把宿主亲手起的、围栏收纳的与推断出来的分开。

进程号会复用，上游曾因此把宿主自己当作子进程的后代杀掉（来源：证据 `evidence/identity-and-usage.md`）。所以 ``Governance`Identity`` 由进程号加出生标记组成，每个连接都按这个身份操作。

Linux 的 cgroup 与 Windows 的作业对象让后代自动加入且不能自行离开，Windows 还由内核保证宿主死亡后终止全部成员；macOS 的进程组可以被离开，宿主崩溃后没有机制清理（来源：证据 `evidence/platform-containment.md`）。所以 ``Governance`Capability.guarantee`` 把宿主死后成员的命运分成内核保证与宿主配合两支，宿主退出前按它分支；后代能否离开不写进能力，它只决定业务层要不要去推断逃逸的后代。

Windows 作业与 Linux cgroup 的累计用量含已退出成员，macOS 只能对活着的进程读用量，进程退出后用量并入父进程或丢失（来源：证据 `evidence/identity-and-usage.md`）。所以 ``Governance`Capability.aggregate`` 说明围栏的读数是否完整，``Governance`Reading`` 带 ``Governance`Coverage``，读数的使用方必须区分完整与只含活着的。

宿主所在的进程组可能与其他程序共用；macOS 的进程组不能嵌套，宿主已处于终端或 IDE 开的作业或 cgroup 里时未必能再开（来源：证据 `evidence/spawn-sites.md`、`evidence/platform-containment.md`）。所以围栏只能由宿主自己开出，成员一定是宿主自己起的进程及其后代；``Platform`Open`` 开不出来时返回不可用，使用方按无围栏继续；围栏之间没有包含关系。

共用的守护进程服务多个宿主，`nohup` 起的进程必须活过宿主的收尾（来源：证据 `evidence/spawn-sites.md`、`evidence/upstream-issues.md`）。所以起进程的一方要给出 ``Registry`Policy``；承诺不随归属单位结束的进程不得进入会被整体终止的围栏。

macOS 上的 MCP 服务器随会话结束该终止，却因权限提示必须留在宿主的进程组里，不能进围栏（来源：证据 `evidence/spawn-sites.md`、上游 #4987）。所以进程放在围栏里还是围栏外，与它的寿命承诺是两个独立的决定：``Registry`Entry.fence`` 由起进程的一方单独给出，承诺随单位结束的进程可以在围栏外，收尾时按身份逐个终止。

上游 #5684 要求对整棵进程树限制资源，#12961 的维护者把观测与强制分开，先做登记（PID、启动时间、角色）与低频采样（来源：证据 `evidence/upstream-issues.md`）。所以本设计只定义归属、生命周期与计量的连接，不定义强制上限；归属单位的层级（宿主、会话、工具调用）是业务对"角色"的细化，架构只定义可嵌套的归属单位树。

## 为什么

身份、围栏能力与读数放在根模块：它们被操作系统的事实与归属台账共用，而两者互不引用。不把 ``Registry`` 放进 ``Platform`` 之下：台账不是操作系统的内部细节，它只需要身份与围栏的类型，不需要起进程、终止进程的连接。

三个平台实现同一个 ``Platform`` 模块，不写成三个模块：使用方按 ``Governance`Capability`` 的两项能力分支，不按平台名分支。能力只保留设计里有人读的两项：`guarantee` 由 ``Platform`Abandon`` 读，`aggregate` 由 ``Platform`Measure`` 读。不写"成员能否离开"与"能否强制上限"：前者只影响业务层要不要推断逃逸的后代，后者本设计不做。

围栏不嵌套：macOS 的进程组不能嵌套，而嵌套的围栏要求 ``Platform`Measure`` 与 ``Platform`Kill`` 递归到内层，三个平台里只有两个能做到。一个归属单位至多开一个自己的围栏；没有自己围栏的单位，它的进程可以放在某个外层单位的围栏里，由起进程的一方在 ``Registry`Entry.fence`` 里写明。

计量不持有状态：读数是取回那一刻的副本，``Governance`Merge`` 把围栏读数与围栏外进程的读数合成一份，历史与峰值由消费方保留。取回读数要同时用到台账与平台两个连接，所以取回的场景属于业务，不在架构里。

不把"杀整棵树"交给使用方自己遍历：``Platform`Kill`` 以围栏为单位终止成员。围栏外的进程只能按身份逐个 ``Platform`Terminate``；``Registry`End`` 不规定两者的次序，只要求结束时名下没有可终止的登记。

## 语义

``Platform`` 的状态是操作系统的事实，``Registry`` 的状态是宿主自己的台账；两者运行在同一个宿主进程内，宿主崩溃时台账随之消失，只有 `<Kernel>` 保证的围栏成员仍会被清理。进程可以在任何连接之外出生或退出，这些变化由操作系统引起，不写成连接；宿主经 ``Platform`Members``、``Platform`Related`` 与 ``Platform`ProbeAll`` 事后得知。

``Governance`Reading`` 的 `<LiveOnly>` 读数在进程退出后会回落；两次取回之间出生又退出的进程在这种读数里不出现。
