# 平台

负责陈述操作系统的事实：起一棵受管进程树、读一棵树的 CPU、IO 与内存用量、终止并释放一棵树，以及宿主死亡后操作系统能否保证清理成员。不负责决定哪棵树属于哪个归属单位，也不负责超限判定与告警。

## 依据

Linux 用 cgroup v2、Windows 用作业对象、macOS 用 `setsid` 进程组加继承到后代环境里的血统标记，把一棵进程树圈起来（来源：证据 `evidence/platform-containment.md`、`evidence/spawn-sites.md`，上游 #4987）。所以三个平台各自实现本模块的四个连接即可互换；怎样圈住成员、外层禁止嵌套或 macOS 的 MCP 服务器因 TCC 不能新建进程组时怎样退化，都留在实现里（见 `reference/platform-implementations.md`），不向台账与业务暴露。

Windows 作业对象设了 `KILL_ON_JOB_CLOSE` 后，宿主怎样死亡都由内核终止全部成员；Linux cgroup 与 macOS 进程组在宿主死亡后不会自动终止成员（来源：证据 `evidence/platform-containment.md`）。所以 ``Platform`Guarantee`` 分成 `<Kernel>` 与 `<Cooperative>` 两支，由 ``Platform`Describe`` 如实陈述。

Windows 作业与 Linux cgroup 在成员退出后仍保留整棵树的 CPU 与 IO 累计和峰值内存，直到宿主释放容器；macOS 只能对此刻活着的成员读用量；CPU 与 IO 是累计量，内存是瞬时量（来源：证据 `evidence/identity-and-usage.md`、`evidence/platform-containment.md`）。所以 ``Platform`Reading`` 把累计量与当前内存分开，只给累计量标 ``Platform`Coverage``，峰值在平台给不出时为空。

## 为什么

单独成为子模块：每个操作系统换一份实现，台账与业务都不随之改变。

成员全部自然退出后树不蒸发，直到 ``Platform`Kill`` 释放：正常跑完退出的命令在收尾前仍能经 ``Platform`Measure`` 读到有账本平台保留的累计与峰值。``Platform`Measure`` 与 ``Platform`Kill`` 不要求树里还有活成员：成员随时可能在连接之外退出，这样的前置契约在并发下无法遵守。

不在导出接口上区分"圈住的进程"与"靠环境标记找回的进程"：对宿主而言每次 ``Platform`Spawn`` 都起一棵树，读与终止都对这棵树；把某个平台的弥补手段暴露给上层，会让台账与业务维护两套账本。

## 语义

成员进程可以在任何连接之外派生后代或自行退出，这些变化由操作系统引起，不经过任何连接；宿主经 ``Platform`Measure`` 取回的是那一刻的副本。macOS 上离开进程组但仍带该树环境标记的后代由实现并入同一棵树；读不到环境的系统自带程序若又离开进程组则无法并入，本设计接受这一平台边界。
