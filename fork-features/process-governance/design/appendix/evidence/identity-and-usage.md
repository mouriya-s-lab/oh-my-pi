# 进程身份的复用与资源读数的来源

证据来源：上游 `crates/pi-shell/src/process.rs` 的注释与引用的 issue；macOS `proc_pid_rusage` 与 `rusage_info_v0` 头文件（2026-10-22 本地用 SDK 头文件编译核对偏移）；微软作业对象文档。只作依据的证据，不设立规则。

## 身份

- PID 会复用，Windows 上复用得很快。上游曾发生宿主被误认成子进程的后代、取消时把宿主自己杀掉、会话无记录消失（issue #4605、#7452）。
- 上游原生层的 `Process` 在登记时就持有句柄并记下创建时间（Windows）或 `pbi_start_tvsec/usec`（macOS），之后每次操作都先核对启动时间。
- `kill(-pgid, 0)` 只能说明进程组里还有进程，不能说明它们仍属于本次任务。

## 资源读数

| 来源 | 覆盖范围 | 累计还是瞬时 |
|---|---|---|
| macOS `proc_pid_rusage`：`ri_user_time`、`ri_system_time`、`ri_diskio_bytesread`、`ri_diskio_byteswritten`、`ri_phys_footprint`、`ri_lifetime_max_phys_footprint` | 只对活着的进程有效；两次采样之间出生又退出的进程读不到 | CPU 与 IO 累计，内存瞬时加历史峰值 |
| 进程被父进程回收后 | 用量并入父进程的 `ri_child_*` 汇总字段，单个进程明细消失；孤儿被 launchd 回收，用量丢失 | — |
| 宿主自己回收的直接子进程 | `wait4` 能拿到最终用量 | 最终累计 |
| Windows 作业累计 | 作业整组，含已退出成员 | 累计 |
| Linux cgroup `cpu.stat`、`io.stat`、`memory.current` | cgroup 整组，含已退出成员 | CPU 与 IO 累计，内存瞬时 |

本地实测：macOS 上一次全表扫描（729 个 PID，读两遍取一致）耗时 1.29 ms。按 250 ms 轮询，每个宿主常驻约 0.5% 单核；本机同时跑约 17 个宿主时合计约 9% 单核。
