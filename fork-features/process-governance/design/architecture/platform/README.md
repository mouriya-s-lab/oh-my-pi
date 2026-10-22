# 平台

负责陈述操作系统的事实：起一棵受管进程树、读一棵受管进程树的 CPU/IO/内存用量、终止并释放一棵受管进程树，以及宿主死亡后操作系统能否保证清理；不负责决定哪棵进程树属于哪个归属单位，也不负责告警。

## 为什么

单独成为子模块：三个操作系统各自实现这一个模块就互换，父模块只需要共用的身份、退出保证与读数类型，不需要知道某个平台底层用的是 cgroup、作业对象，还是进程组加环境血统标记。

每棵受管进程树在 ``Platform`Spawn`` 时诞生，以根进程的 ``Governance`Identity`` 为身份，在平台上一直保留到宿主调 ``Platform`Kill`` 释放为止；成员全部自然退出后 `members(tree)` 变成空集但树不蒸发：Linux 的 cgroup 与 Windows 的作业对象在成员退完后仍保留累计用量与峰值，这样正常跑完退出的命令在收尾前仍能经 ``Platform`Measure`` 读到；macOS 没有内核树级账本，成员退完后 ``Platform`Measure`` 返回零读数，收尾调 ``Platform`Kill`` 幂等无害。不要求调用方在 ``Platform`Measure`` 或 ``Platform`Kill`` 前保证树里还有活成员：成员随时可能在连接外退出，那样的前置契约在并发下无法遵守。

`charged` 的定义域是 `members` 的子集，与 `peak` 同构：只有平台具备树级累计账本（Linux cgroup、Windows 作业）时，树才在 `dom charged` 里，此时 ``Platform`Measure`` 给出 `<Complete>`；macOS 的树不在 `dom charged` 里，``Platform`Measure`` 只汇总此刻活着的成员并如实给出 `<LiveOnly>`。`charged` 只累计 CPU 与 IO：已退出成员的内存不是任何时刻的占用。

## 语义

不同受管进程树的活成员集合两两不相交；每个成员进程都以 `pid + birth` 识别，``Platform`Kill`` 只终止出生标记匹配的那批成员，不会误伤复用同一进程号的新进程。

成员进程可以在任何连接之外派生后代或自行退出：树内成员派生后代时，后代进入同一棵树的 `members(tree)`（macOS 上离开进程组但仍带该树环境标记的后代，由平台实现内部并入同一棵树的成员集；读不到环境的系统自带程序若又离开进程组则无法并入，本设计接受这一平台边界）；成员自行退出时，它离开 `alive` 与 `members(tree)`，若该树在 `dom charged` 里则它的累计量计入 `charged(tree)`。这些变化由操作系统引起，不写成连接；宿主经 ``Platform`Measure`` 取回那一刻的读数副本。

``Platform`Describe`` 在整个宿主生命周期内返回同一个值。
