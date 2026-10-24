# 宿主生命周期

负责把归属单位的嵌套开闭、起受管进程树并登记、采集单棵或多棵进程树的 CPU/IO/内存读数、按单位去重判定超限告警、按单位收尾与宿主退出串成完整路径；不负责各操作系统圈住进程树的内部机制，也不负责告警的界面展示与文案。

## 依据

宿主在归属单位名下起进程时，必须先确认该归属单位仍在册，再调用平台起受管进程树并登记到该单位名下；起进程失败时不在台账里留空记录（来源：架构 ``Platform`Spawn`` 与 ``Registry`Attach`` 契约，证据见附录 `evidence/spawn-sites.md`）。所以 ``Host`Launch`` 先调 ``Registry`Live`` 核对单位在册，通过后才调 ``Platform`Spawn`` 与 ``Registry`Attach``。

一个归属单位名下只有一棵受管进程树时，直接取 ``Platform`Measure`` 的读数即可保留平台给出的 `<Complete>` 覆盖度与 `memoryPeak`；有多棵受管进程树时，用 ``Host`Merge`` 合并各棵树的读数（来源：架构 ``Platform`Measure`` 契约，证据见附录 `evidence/identity-and-usage.md`）。所以单棵树采样由 ``Host`SampleTree`` 直接返回 ``Platform`Measure`` 的读数，多棵树合并由 ``Host`SamplePair`` 调 ``Host`Merge``。

同一归属单位在存续期内可能连续派生多个子进程，或被周期性采样多次；原有监控按单个子进程告警会无限告警，越过阈值后若每次采样都告警会造成重复刷屏（来源：用户需求，omp 会话 `01a16321`）。所以 ``Host`JudgeAlert`` 先用 ``Host`Exceeded`` 判定读数是否越过 CPU、IO 或内存阈值，超限时查 ``Registry`Alerted``：未告警过则调 ``Registry`MarkAlerted`` 并返回 `<Triggered>`，已告警过则返回 `<Suppressed>`。

归属单位按嵌套树组织，外层单位结束前它的直接内层子单位（``Registry`Children``）必须全部结束，名下的受管进程树（``Registry`Trees``）必须全部终止并释放（来源：架构 ``Registry`End`` 准入契约，证据见附录 `evidence/upstream-issues.md` #5684）。所以单位收尾先对名下每棵进程树调 ``Host`RetireTree``（``Platform`Kill`` 加 ``Registry`Release``），待内层子单位与进程树全部清空后由 ``Host`FinishUnit`` 调 ``Registry`End``。

`<Kernel>` 保证的平台在宿主怎样退出时都由内核随句柄关闭终止全部受管进程树，`<Cooperative>` 的平台在宿主正常退出前必须由宿主自己终止（来源：证据 `evidence/platform-containment.md`）。所以宿主退出前 ``Host`ExitTree`` 按 ``Platform`Describe`` 分支：`<Cooperative>` 时终止并释放进程树，`<Kernel>` 时交由内核随宿主退出清理。

## 需求

在归属单位名下起受管进程树时，单位不在册则拒绝起进程，起进程成功则登记到该单位名下，起进程失败则不留登记（来源：用户需求"在 omp 宿主里增加统一的进程 fork 记录"，omp 会话 `01a16321`），由 ``Host`Launch`` 走通。

采集归属单位名下受管进程树的 CPU、IO、内存读数时，单棵树保留完整度与峰值，多棵树合并读数；首次越过阈值时返回触发告警，同一单位后续采样仍超限时抑制重复告警（来源：用户需求"做完整的 CPU、内存、IO 记录，并在这个基础上做告警"及"无限告警"问题，omp 会话 `01a16321`），由 ``Host`JudgeAlert``、``Host`SampleTree`` 与 ``Host`SamplePair`` 走通。

归属单位按由内到外的嵌套次序收尾：内层子单位先完成采样、终止并释放名下受管进程树、结束内层单位，外层单位再终止并释放自己的受管进程树并结束外层单位（来源：用户需求"随 omp 进程的退出杀掉"与"逃逸不由 harness 代劳"，omp 会话 `01a16321`），由 ``Host`RetireTree``、``Host`FinishUnit`` 与 ``Host`RunNested`` 走通。

宿主退出前，对 `<Cooperative>` 平台的受管进程树执行终止与释放，对 `<Kernel>` 平台的受管进程树交由内核清理（来源：证据 `evidence/platform-containment.md`），由 ``Host`ExitTree`` 走通。

## 语义

最终用量采集（``Host`SampleTree`` / ``Host`SamplePair``）必须在 ``Host`RetireTree`` 之前完成：``Platform`Kill`` 会释放平台上的进程树账本与成员记录，释放后再采样只能得到空读数。

单位收尾按嵌套深度自内向外推进：对每个最内层单位，先对 ``Registry`Trees`` 里的全部进程树执行 ``Host`RetireTree``，确认无子单位且无进程树后调 ``Host`FinishUnit``；全部内层单位结束后，外层单位才能满足 ``Host`FinishUnit`` 的条件。

``Host`ExitTree`` 只用于宿主进程即将退出的终态：`<Kernel>` 分支不调 ``Platform`Kill`` 与 ``Registry`Release``，因为宿主进程退出时操作系统关闭句柄即由内核终止全部成员，内存台账也随宿主进程一并销毁。
