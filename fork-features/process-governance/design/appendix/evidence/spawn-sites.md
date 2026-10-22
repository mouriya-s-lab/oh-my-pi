# 宿主起进程的各条路径与它们的进程组归属

证据：2026-10-22 在 macOS 上的 omp 18.12.6（宿主 pid 2829，自成进程组 2829）里，用 bash 工具、Python eval 与 JS eval 分别起测试进程，再用 `ps -axo pid,ppid,pgid,sess` 与 libproc `proc_listpids(PROC_PGRP_ONLY)` 观察；源码部分读自上游仓库同版本。只作依据的证据，不设立规则。

| 路径 | 源码行为 | 观察到的结果 | 宿主在起进程时能否拿到身份 |
|---|---|---|---|
| bash 工具的前台/后台外部命令 | 内嵌的 brush shell 在宿主进程内执行；stdin 不是终端时每个外部命令单独 `setsid`，并经 `SpawnObserver.on_spawn(pid, pgid)` 上报给 `pi-shell` 的 `SpawnRegistry` | `/bin/sleep &` → 父进程是宿主，自成一组（pgid 等于自身 pid） | 能；原生层已记下 pid、启动时间与 pgid |
| bash 工具里的 `nohup cmd &` | 同一函数的 `detach_reparent` 分支：`setsid` 后 fork 两次，并明确跳过上报（注释：intentionally left unowned，must survive the host's cancellation cleanup） | 孙进程 ppid 为 1，pgid 等于已退出的中间进程；中间进程以僵尸状态挂在宿主名下 | 不能；当前接口不上报 |
| bash 工具里的 `sleep` | brush 内置命令 | 不产生进程 | 不涉及 |
| Python eval 内核 | 宿主以 `detached`（`setsid`）起内核 | 内核 pgid = sid = 自身 pid | 能 |
| Python 用户代码 `subprocess.Popen` | 不经过宿主 | 继承内核的进程组 | 不能；只能经内核的进程组找到 |
| Python 用户代码 `start_new_session=True` | 不经过宿主 | 自成一组，脱离内核的进程组 | 不能；经进程组也找不到 |
| Python 用户代码 `sh -c 'x &'`（两层 fork） | 不经过宿主 | 孤儿（ppid 1），仍在内核的进程组里 | 不能；经进程组能找到 |
| JS eval | 宿主以 `detached` 起独立子进程 `__omp_worker_js_eval_process`；起不来时退回宿主进程内的 Worker 线程 | 与 Python 同样的三种结果 | 能（子进程）/ 不涉及（线程） |
| JS eval cell 超时被强杀 | 宿主只杀 worker 进程 | worker 4976 被杀后，它起的两个子进程成为孤儿（ppid 1，pgid 4976，组长已死）并继续运行；`proc_listpids(PROC_PGRP_ONLY, 4976)` 仍能列出它们 | — |
| MCP stdio 服务器 | 只有非 darwin 平台才 `detached`；macOS 上刻意不分组，因为脱离会话后 TCC 不再弹 Apple Events 权限提示（上游 issue #4987） | 留在宿主所在的进程组 | 能，但与宿主同组 |
| LSP 私有服务器 | `ptree.spawn`，未传 `detached`；`ptree` 默认不分组 | 留在宿主所在的进程组（实测宿主组里有 `gh pr view` 等普通子进程） | 能，但与宿主同组 |
| 多个宿主共用的守护进程（launch broker、LSP mux、blob broker、共享浏览器） | 由第一个需要它的宿主起，刻意 detached 且 unref；按剩余客户端数自行退出 | 未单独实测 | 能，但它不属于任何一个宿主 |
| 第三方插件自己起的 PTY | 插件源码注释称子进程在自己的进程组里 | 未实测 | 宿主看不到 |

宿主所在的进程组不一定属于宿主：由 zsh 启动的宿主自成一组；由桌面应用（Paseo）启动的宿主 39307 观察到 pgid 为 861，与其他程序共用一组。

TS 侧约 49 个文件直接调用 `Bun.spawn` 或 `ptree.spawn`，没有统一的起进程入口；上游 PR #13192 为 Linux cgroup 逐个包装了约 60 处，review 指出以后新增的 `Bun.spawn` 会悄悄漏掉。

活过宿主的进程在三个平台上都有操作系统自己的拥有者：macOS 的 launchd 按 plist 起用户代理并在退出后拉起，Linux 的 systemd 按用户级 unit 起服务，Windows 的服务管理器按服务注册起；它们的父进程是服务管理器，不是宿主。omp 当前的 `nohup` 两层 fork 与 detached 守护进程绕过了这一层，由宿主自己充当"放走"的一方。
