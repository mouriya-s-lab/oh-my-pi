# 宿主生命周期

负责把归属单位的开始、起进程并登记、逃逸后代补找、用量读数汇总、按单位收尾与宿主退出串成完整路径，并判定一份读数是否越过内存阈值；不负责围栏在各操作系统上的底层机制，也不负责告警的界面展示与通知文案。

## 依据

宿主在起进程时拿到子进程身份与可能随它诞生的围栏；有围栏的进程树按围栏计量与终止，没有围栏的按进程身份计量与终止（来源：架构 ``Platform`` 与 ``Registry`` 连接，证据见附录 `evidence/spawn-sites.md`）。所以起进程成功后，有围栏的调 ``Registry`Attach`` 记围栏，没有围栏的调 ``Registry`Track`` 记进程身份。

`contained` 为假的平台上，围栏成员可以自行 `setsid` 离开围栏，但仍带着环境里的单位身份；围栏内的成员同样带着单位身份（来源：证据 `evidence/platform-containment.md`、`evidence/spawn-sites.md`）。所以补找逃逸后代只在 `contained` 为假时查询 ``Platform`Marked``，并用 ``Host`Escaped`` 减去围栏内此刻的成员，既不漏掉逃逸后代，也不与围栏成员重复计算。

归属单位按嵌套树组织，外层结束前内层必须全部结束，单位结束前名下的围栏与无围栏进程必须全部清掉（来源：架构 ``Registry`End`` 准入契约，证据见附录 `evidence/upstream-issues.md`）。所以单位收尾对名下围栏调 ``Platform`Kill`` 并 ``Registry`Release``，对无围栏进程与逃逸后代调 ``Platform`Terminate`` 并 ``Registry`Drop``，最后调 ``Registry`End``。

`<Kernel>` 保证的围栏在宿主怎样死亡时都由内核终止全部成员，`<Cooperative>` 的围栏在宿主正常退出前必须由宿主自己终止（来源：证据 `evidence/platform-containment.md`）。所以宿主退出前按 ``Platform`Describe`` 的 `guarantee` 分支：`<Cooperative>` 时终止并释放围栏，`<Kernel>` 时交由内核处理。

归属单位的内存占用越过配置阈值时宿主需要收到告警（来源：上游 #5684 与 #12961，证据见附录 `evidence/upstream-issues.md`）。所以 ``Host`Exceeded`` 按阈值判定一份读数是否超限。

## 需求

在归属单位名下起进程时，进程起来后按有无围栏登记到该单位名下，起进程失败时不留登记（来源：上游 #5684、#12961），由 ``Host`Launch`` 走通。

采集归属单位的用量时，合并该单位围栏的读数与围栏外进程（含 `contained` 为假时逃出围栏的后代）的读数，并在内存越过阈值时给出超限判定（来源：上游 #5684、#12961），由 ``Host`Outside``、``Host`Sample`` 与 ``Host`Exceeded`` 走通。

归属单位收尾时，终止并释放名下围栏、终止并撤销名下无围栏进程与逃出围栏的后代，再结束该单位（来源：上游 #5684），由 ``Host`RetireFence``、``Host`RetireProcess`` 与 ``Host`RunUnit`` 走通。

宿主退出前，对 `<Cooperative>` 平台的围栏执行终止清理，对 `<Kernel>` 平台的围栏交由内核清理（来源：证据 `evidence/platform-containment.md`），由 ``Host`ExitFence`` 走通。
