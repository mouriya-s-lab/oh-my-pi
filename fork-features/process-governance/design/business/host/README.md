# 宿主生命周期

负责在归属单位名下起受管进程树并登记、按阈值采样并按单位去重告警、由内向外收尾单位，以及宿主正常退出前处置剩下的树。不负责各操作系统圈住进程树的机制，也不负责告警的界面展示与文案。

## 依据

上游 #5684 与 #12961 要求记录子进程树的 CPU、内存、IO 用量并在越过阈值时告警（来源：证据 `evidence/upstream-issues.md`）。所以本单元持有 ``Host`Limit`` 与 ``Host`Exceeded``，并按单位读写 ``Registry`Alerted``。

`<Cooperative>` 平台上宿主死亡后无人终止成员（来源：证据 `evidence/platform-containment.md`）。所以宿主正常退出前经 ``Host`ExitTree`` 按 ``Platform`Describe`` 分支处置每棵剩下的树。

## 需求

在归属单位名下起树时，单位不在册则不起进程，起进程失败则不留登记，成功则树登记在该单位名下（来源：上游 #5684、#13192），由 ``Host`Launch`` 走通。

采集单位名下树的 CPU、IO、内存读数：一棵树保留平台给出的完整性与峰值，两棵树合成读数；同一单位存续期内首次超限时触发告警，之后仍超限时抑制（来源：上游 #5684、#12961），由 ``Host`SampleTree`` 与 ``Host`SamplePair`` 走通，调用方从 ``Host`SampleOutcome.alert`` 看出结局。

单位收尾时，每棵树先做最后一次采样再终止释放，内层单位结束后外层才结束（来源：上游 #5684），由 ``Host`RetireTree``、``Host`FinishUnit`` 与 ``Host`CloseNested`` 走通。

宿主正常退出前，`<Cooperative>` 平台上剩下的树被终止并释放，`<Kernel>` 平台上交给内核（来源：上游 #5684、#10537），由 ``Host`ExitTree`` 走通。

## 为什么

一棵树采样直接用 ``Platform`Measure`` 的读数，不经过 ``Host`Merge``：合成会丢掉峰值与单棵树的完整性。

不在本单元自动终止超限的树：强制处置要先决定丢弃用户数据的策略（上游 #12631 的维护者意见），本单元只给出告警结局。

## 语义

宿主运行期间收尾单位只走 ``Host`RetireTree``；``Host`ExitTree`` 只用于宿主即将退出的终态，`<Kernel>` 分支不终止也不撤销，因为宿主退出时内核终止成员，台账随宿主一并销毁。
